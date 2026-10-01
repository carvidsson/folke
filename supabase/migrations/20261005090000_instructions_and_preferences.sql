-- Folke – shared AI instructions, instruction history and personal AI
-- preferences (ADR-037).
--
-- Additive: new tables with RLS and explicit grants, one new profile column.
--
-- Prompt layering (src/server/ai/prompt.ts):
--   1. organization_instructions  – shared by all assistants (system admins)
--   2. assistants.instructions    – per assistant (admins and managers)
--   3. user_ai_preferences        – the user's own wishes on form and tone;
--                                   they complement, never replace, 1 and 2
--   4. fixed rules (sources, injection, confidentiality)
--
-- Instructions are server-side data: end users cannot read them. Changes
-- are kept in instruction_revisions (who, when, what) for traceability and
-- restore – the generic audit log deliberately omits instruction text.

-- ---------------------------------------------------------------------------
-- Shared organization instructions (single row)
-- ---------------------------------------------------------------------------

create table public.organization_instructions (
  id boolean primary key default true check (id),
  content text not null default '' check (char_length(content) <= 8000),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Default = the tone rule that was hard-coded in src/server/ai/prompt.ts
-- until now (moved here so administrators can edit it). Rules about
-- sources, citations and safety stay fixed in code.
insert into public.organization_instructions (content) values (
'Svara alltid på naturlig, professionell svenska. Var konkret och kortfattad.'
);

alter table public.organization_instructions enable row level security;
revoke all on public.organization_instructions from anon, authenticated;
grant select, update (content) on public.organization_instructions to authenticated;
grant select, insert, update, delete on public.organization_instructions to service_role;

-- Readable by system administrators and assistant managers (they write
-- assistant instructions that build on it); writable by system admins.
create policy organization_instructions_select on public.organization_instructions for select to authenticated
  using (
    app.is_system_admin()
    or (app.authorized() and exists (select 1 from public.assistant_managers m where m.user_id = auth.uid()))
  );
create policy organization_instructions_update on public.organization_instructions for update to authenticated
  using (app.is_system_admin())
  with check (app.is_system_admin());

create function app.stamp_organization_instructions() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

create trigger organization_instructions_stamp before update on public.organization_instructions
  for each row execute function app.stamp_organization_instructions();

-- ---------------------------------------------------------------------------
-- Instruction history (written by triggers only)
-- ---------------------------------------------------------------------------

create table public.instruction_revisions (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('organization', 'assistant')),
  assistant_id uuid references public.assistants (id) on delete cascade,
  content text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((scope = 'assistant') = (assistant_id is not null))
);
create index instruction_revisions_scope_idx on public.instruction_revisions (scope, assistant_id, created_at desc);

alter table public.instruction_revisions enable row level security;
revoke all on public.instruction_revisions from anon, authenticated;
grant select on public.instruction_revisions to authenticated;
grant select, insert, update, delete on public.instruction_revisions to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy instruction_revisions_select on public.instruction_revisions for select to authenticated
  using (
    app.is_system_admin()
    or (scope = 'assistant' and app.is_assistant_manager(assistant_id))
    or (scope = 'organization' and app.authorized()
        and exists (select 1 from public.assistant_managers m where m.user_id = auth.uid()))
  );

create function app.record_instruction_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'organization_instructions' then
    if tg_op = 'INSERT' or new.content is distinct from old.content then
      insert into public.instruction_revisions (scope, content, created_by)
      values ('organization', new.content, auth.uid());
    end if;
  elsif tg_op = 'INSERT' or new.instructions is distinct from old.instructions then
    insert into public.instruction_revisions (scope, assistant_id, content, created_by)
    values ('assistant', new.id, new.instructions, auth.uid());
  end if;
  return new;
end $$;

create trigger organization_instructions_revision after insert or update on public.organization_instructions
  for each row execute function app.record_instruction_revision();
create trigger assistants_instruction_revision after insert or update of instructions on public.assistants
  for each row execute function app.record_instruction_revision();

-- Baseline revisions for the current texts.
insert into public.instruction_revisions (scope, content)
select 'organization', content from public.organization_instructions;
insert into public.instruction_revisions (scope, assistant_id, content)
select 'assistant', id, instructions from public.assistants;

-- ---------------------------------------------------------------------------
-- Personal AI preferences (owner only). Structured, so they can be turned
-- into personal instructions on the server – never sent as raw settings.
-- Values must match src/lib/domain/preferences.ts.
-- ---------------------------------------------------------------------------

create table public.user_ai_preferences (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  answer_length text check (answer_length in ('short', 'balanced', 'detailed')),
  writing_tone text check (writing_tone in ('professional', 'personal', 'formal')),
  writing_options text[] not null default '{}'
    check (writing_options <@ array['no_emojis', 'no_long_dashes', 'we_form', 'less_formal', 'short_emails']::text[]),
  extra_notes text check (char_length(extra_notes) <= 1000),
  writing_sample text check (char_length(writing_sample) <= 4000),
  onboarding_status text not null default 'not_started'
    check (onboarding_status in ('not_started', 'completed', 'skipped')),
  onboarding_completed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.user_ai_preferences enable row level security;
revoke all on public.user_ai_preferences from anon, authenticated;
grant select, insert, update, delete on public.user_ai_preferences to authenticated;
grant select, insert, update, delete on public.user_ai_preferences to service_role;

-- Private to the user, like conversations: no administrator policy.
create policy user_ai_preferences_owner on public.user_ai_preferences for all to authenticated
  using (user_id = auth.uid() and app.authorized())
  with check (user_id = auth.uid() and app.authorized());

create trigger user_ai_preferences_touch before update on public.user_ai_preferences
  for each row execute function app.touch_updated_at();

-- Whether the user is offered the introduction at first sign-in (chosen by
-- the administrator at invitation; existing users are not offered it).
alter table public.profiles add column onboarding_offered boolean not null default false;
grant update (onboarding_offered) on public.profiles to authenticated;

grant execute on all functions in schema app to authenticated, service_role;
