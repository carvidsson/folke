-- Folke MVP 0.2 – operations: AI usage (cost tracking), audit log, retention.

-- ---------------------------------------------------------------------------
-- AI usage. Written by the server (service role) only, so users cannot forge
-- or delete cost records. Users see their own usage; admins see all.
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete set null,
  assistant_id uuid references public.assistants (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cost_sek numeric(12, 4) not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_created_idx on public.ai_usage (created_at);
create index ai_usage_user_idx on public.ai_usage (user_id, created_at);

alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon;
revoke insert, update, delete on public.ai_usage from authenticated;

create policy ai_usage_select on public.ai_usage for select to authenticated
  using ((user_id = auth.uid() and app.authorized()) or app.is_system_admin());

-- ---------------------------------------------------------------------------
-- Audit log. Append-only. Written by triggers and the server; readable by
-- system administrators. Never contains conversation or document content.
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb
);
create index audit_log_occurred_idx on public.audit_log (occurred_at desc);
create index audit_log_action_idx on public.audit_log (action);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon;
revoke insert, update, delete on public.audit_log from authenticated;

create policy audit_log_admin_select on public.audit_log for select to authenticated
  using (app.is_system_admin());

-- Generic audit trigger. Records who changed what (column names and, for
-- small non-content fields, the new values). Content columns are excluded.
create function app.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb;
  old_rec jsonb;
  changed jsonb := '{}'::jsonb;
  k text;
  excluded text[] := array['content', 'instructions', 'tsv', 'updated_at', 'created_at', 'last_active_at'];
  target text;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  old_rec := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  for k in select jsonb_object_keys(rec) loop
    continue when k = any (excluded);
    if tg_op <> 'UPDATE' or rec -> k is distinct from old_rec -> k then
      changed := changed || jsonb_build_object(k, rec -> k);
    end if;
  end loop;

  if tg_op = 'UPDATE' and changed = '{}'::jsonb then
    return new;
  end if;

  target := coalesce(rec ->> 'id', rec ->> 'document_id', rec ->> 'group_id');

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, target, changed);

  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function app.audit_row_change();
create trigger audit_groups after insert or update or delete on public.groups
  for each row execute function app.audit_row_change();
create trigger audit_group_members after insert or update or delete on public.group_members
  for each row execute function app.audit_row_change();
create trigger audit_assistants after insert or update or delete on public.assistants
  for each row execute function app.audit_row_change();
create trigger audit_assistant_managers after insert or update or delete on public.assistant_managers
  for each row execute function app.audit_row_change();
create trigger audit_assistant_grants after insert or update or delete on public.assistant_grants
  for each row execute function app.audit_row_change();
create trigger audit_documents after insert or update or delete on public.documents
  for each row execute function app.audit_row_change();
create trigger audit_document_shares after insert or update or delete on public.document_shares
  for each row execute function app.audit_row_change();
create trigger audit_document_assistants after insert or update or delete on public.document_assistants
  for each row execute function app.audit_row_change();

-- ---------------------------------------------------------------------------
-- Retention review (annual). Administrators see counts only – never titles or
-- content – and can purge conversations inactive for at least one year.
-- ---------------------------------------------------------------------------

create function public.conversation_retention_summary()
returns table (inactive_since text, conversations bigint, messages bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_system_admin() then
    raise exception 'Endast systemadministratörer' using errcode = '42501';
  end if;
  return query
    select
      case
        when c.last_message_at >= now() - interval '6 months' then '< 6 månader'
        when c.last_message_at >= now() - interval '12 months' then '6–12 månader'
        when c.last_message_at >= now() - interval '24 months' then '12–24 månader'
        else '> 24 månader'
      end,
      count(distinct c.id),
      count(m.id)
    from public.conversations c
    left join public.messages m on m.conversation_id = c.id
    group by 1;
end $$;

create function public.purge_conversations(p_inactive_before timestamptz)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  deleted bigint;
begin
  if not app.is_system_admin() then
    raise exception 'Endast systemadministratörer' using errcode = '42501';
  end if;
  if p_inactive_before > now() - interval '12 months' then
    raise exception 'Gallring får bara avse konversationer som varit inaktiva i minst 12 månader'
      using errcode = '22023';
  end if;

  delete from public.conversations where last_message_at < p_inactive_before;
  get diagnostics deleted = row_count;

  insert into public.audit_log (actor_id, action, target_type, metadata)
  values (auth.uid(), 'conversations.purge', 'conversations',
          jsonb_build_object('inactive_before', p_inactive_before, 'deleted', deleted));
  return deleted;
end $$;

revoke execute on function public.conversation_retention_summary() from anon, public;
revoke execute on function public.purge_conversations(timestamptz) from anon, public;
grant execute on function public.conversation_retention_summary() to authenticated;
grant execute on function public.purge_conversations(timestamptz) to authenticated;

-- Server-side helper to fetch an assistant's instructions for admins/managers.
create function public.get_assistant_instructions(p_assistant_id uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (app.is_system_admin() or app.is_assistant_manager(p_assistant_id)) then
    raise exception 'Behörighet saknas' using errcode = '42501';
  end if;
  return (select instructions from public.assistants where id = p_assistant_id);
end $$;
revoke execute on function public.get_assistant_instructions(uuid) from anon, public;
grant execute on function public.get_assistant_instructions(uuid) to authenticated;
