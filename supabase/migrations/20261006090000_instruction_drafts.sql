-- Folke – drafts and publishing for AI instructions, tagged AI usage
-- (ADR-038).
--
-- Additive. Drafts are stored separately and never reach users: chat only
-- reads the published texts (organization_instructions.content and
-- assistants.instructions). Publishing copies a draft to the published text,
-- which records a version in instruction_revisions (published versions only).
--
-- Also updates two default texts so they leave room for users' future
-- preferences – only if nobody has edited them yet.

-- ---------------------------------------------------------------------------
-- Drafts: at most one per target (the organization or one assistant)
-- ---------------------------------------------------------------------------

create table public.instruction_drafts (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('organization', 'assistant')),
  assistant_id uuid references public.assistants (id) on delete cascade,
  target text generated always as (coalesce(assistant_id::text, 'organization')) stored unique,
  content text not null check (char_length(content) <= 8000),
  -- The published version the draft started from (latest revision then).
  base_revision_id bigint references public.instruction_revisions (id) on delete set null,
  updated_by uuid default auth.uid() references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((scope = 'assistant') = (assistant_id is not null))
);

alter table public.instruction_drafts enable row level security;
revoke all on public.instruction_drafts from anon, authenticated;
grant select, insert, update (content, updated_by, updated_at), delete on public.instruction_drafts to authenticated;
grant select, insert, update, delete on public.instruction_drafts to service_role;

create function app.can_edit_instructions(p_scope text, p_assistant_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_scope = 'organization' then app.is_system_admin()
    else app.is_system_admin() or app.is_assistant_manager(p_assistant_id)
  end
$$;

create policy instruction_drafts_select on public.instruction_drafts for select to authenticated
  using (app.can_edit_instructions(scope, assistant_id));
create policy instruction_drafts_insert on public.instruction_drafts for insert to authenticated
  with check (app.can_edit_instructions(scope, assistant_id) and updated_by = auth.uid());
create policy instruction_drafts_update on public.instruction_drafts for update to authenticated
  using (app.can_edit_instructions(scope, assistant_id))
  with check (app.can_edit_instructions(scope, assistant_id) and updated_by = auth.uid());
create policy instruction_drafts_delete on public.instruction_drafts for delete to authenticated
  using (app.can_edit_instructions(scope, assistant_id));

-- ---------------------------------------------------------------------------
-- Saving and publishing with optimistic locking. SECURITY INVOKER: the
-- caller's RLS applies to every read and write. Conflicts (errcode 40001)
-- are reported instead of silently overwriting someone else's work:
--   * saving a draft requires the draft's updated_at the editor started from
--     (null when there was no draft),
--   * publishing requires the same, and that the published text has not
--     changed since the draft was created (base_revision_id).
-- ---------------------------------------------------------------------------

create function app.latest_instruction_revision(p_scope text, p_assistant_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select max(id) from public.instruction_revisions
  where scope = p_scope and assistant_id is not distinct from p_assistant_id
$$;

create function public.save_instruction_draft(
  p_scope text,
  p_assistant_id uuid,
  p_content text,
  p_expected_updated_at timestamptz
) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  v_id bigint;
  v_updated_at timestamptz;
  v_result timestamptz;
begin
  if not app.can_edit_instructions(p_scope, p_assistant_id) then
    raise exception 'Du saknar behörighet att ändra instruktionerna' using errcode = '42501';
  end if;

  select d.id, d.updated_at into v_id, v_updated_at
  from public.instruction_drafts d
  where d.target = coalesce(p_assistant_id::text, 'organization')
  for update;

  if v_id is not null then
    if p_expected_updated_at is null or v_updated_at <> p_expected_updated_at then
      raise exception 'Utkastet har ändrats av någon annan sedan du öppnade det. Ladda om sidan för att se den senaste versionen.'
        using errcode = '40001';
    end if;
    update public.instruction_drafts
    set content = p_content, updated_by = auth.uid(), updated_at = clock_timestamp()
    where id = v_id
    returning updated_at into v_result;
  else
    if p_expected_updated_at is not null then
      raise exception 'Utkastet har publicerats eller kastats av någon annan. Ladda om sidan.'
        using errcode = '40001';
    end if;
    insert into public.instruction_drafts (scope, assistant_id, content, base_revision_id, updated_by, updated_at)
    values (p_scope, p_assistant_id, p_content, app.latest_instruction_revision(p_scope, p_assistant_id),
            auth.uid(), clock_timestamp())
    returning updated_at into v_result;
  end if;
  return v_result;
end $$;

create function public.publish_instruction_draft(
  p_scope text,
  p_assistant_id uuid,
  p_expected_updated_at timestamptz
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_id bigint;
  v_content text;
  v_base bigint;
  v_updated_at timestamptz;
  v_count int;
begin
  if not app.can_edit_instructions(p_scope, p_assistant_id) then
    raise exception 'Du saknar behörighet att publicera instruktionerna' using errcode = '42501';
  end if;

  select d.id, d.content, d.base_revision_id, d.updated_at into v_id, v_content, v_base, v_updated_at
  from public.instruction_drafts d
  where d.target = coalesce(p_assistant_id::text, 'organization')
  for update;

  if v_id is null then
    raise exception 'Det finns inget utkast att publicera. Det kan redan ha publicerats eller kastats.' using errcode = '40001';
  end if;
  if v_updated_at <> p_expected_updated_at then
    raise exception 'Utkastet har ändrats av någon annan sedan du öppnade det. Ladda om sidan innan du publicerar.'
      using errcode = '40001';
  end if;
  if v_base is distinct from app.latest_instruction_revision(p_scope, p_assistant_id) then
    raise exception 'De publicerade instruktionerna har ändrats sedan utkastet skapades. Jämför med historiken och spara utkastet på nytt innan du publicerar.'
      using errcode = '40001';
  end if;
  if p_scope = 'assistant' and char_length(trim(v_content)) < 20 then
    raise exception 'Assistentens instruktioner måste vara minst 20 tecken' using errcode = '23514';
  end if;

  if p_scope = 'organization' then
    update public.organization_instructions set content = v_content where id;
  else
    update public.assistants set instructions = v_content where id = p_assistant_id;
  end if;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Du saknar behörighet att publicera instruktionerna' using errcode = '42501';
  end if;
  delete from public.instruction_drafts where id = v_id;
end $$;

revoke execute on function public.save_instruction_draft(text, uuid, text, timestamptz) from anon, public;
revoke execute on function public.publish_instruction_draft(text, uuid, timestamptz) from anon, public;
grant execute on function public.save_instruction_draft(text, uuid, text, timestamptz) to authenticated;
grant execute on function public.publish_instruction_draft(text, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- AI usage: what the call was for (instruction tests are not conversations)
-- ---------------------------------------------------------------------------

alter table public.ai_usage
  add column purpose text not null default 'conversation'
  check (purpose in ('conversation', 'indexing', 'instruction_test'));

-- ---------------------------------------------------------------------------
-- Default texts that leave room for personal preferences (only if unedited)
-- ---------------------------------------------------------------------------

update public.organization_instructions
set content = 'Svara på naturlig och professionell svenska. Var konkret och tydlig. Anpassa svarets längd och detaljnivå efter frågans komplexitet och användarens eventuella preferenser. Prioritera alltid korrekthet och relevant information framför korthet.'
where content = 'Svara alltid på naturlig, professionell svenska. Var konkret och kortfattad.';

-- "kortfattat" in the sales assistant would override a user's choice of
-- detailed answers; the assistant's task and source rules are unchanged.
update public.assistants
set instructions = replace(instructions, 'Svara på svenska, sakligt och kortfattat.', 'Svara sakligt.')
where slug = 'salj' and instructions like '%Svara på svenska, sakligt och kortfattat.%';

grant execute on all functions in schema app to authenticated, service_role;
