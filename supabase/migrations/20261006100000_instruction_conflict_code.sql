-- Folke – conflict errors for instruction drafts as HTTP 409 (ADR-038).
--
-- 20261006090000 raised conflicts with SQLSTATE 40001. PostgREST treats
-- 40001 as a serialization failure and retries the request, so a conflict
-- hung for minutes instead of being reported. PT409 makes PostgREST answer
-- immediately with HTTP 409 Conflict. Function bodies are otherwise
-- unchanged.

create or replace function public.save_instruction_draft(
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
        using errcode = 'PT409';
    end if;
    update public.instruction_drafts
    set content = p_content, updated_by = auth.uid(), updated_at = clock_timestamp()
    where id = v_id
    returning updated_at into v_result;
  else
    if p_expected_updated_at is not null then
      raise exception 'Utkastet har publicerats eller kastats av någon annan. Ladda om sidan.'
        using errcode = 'PT409';
    end if;
    insert into public.instruction_drafts (scope, assistant_id, content, base_revision_id, updated_by, updated_at)
    values (p_scope, p_assistant_id, p_content, app.latest_instruction_revision(p_scope, p_assistant_id),
            auth.uid(), clock_timestamp())
    returning updated_at into v_result;
  end if;
  return v_result;
end $$;

create or replace function public.publish_instruction_draft(
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
    raise exception 'Det finns inget utkast att publicera. Det kan redan ha publicerats eller kastats.' using errcode = 'PT409';
  end if;
  if v_updated_at <> p_expected_updated_at then
    raise exception 'Utkastet har ändrats av någon annan sedan du öppnade det. Ladda om sidan innan du publicerar.'
      using errcode = 'PT409';
  end if;
  if v_base is distinct from app.latest_instruction_revision(p_scope, p_assistant_id) then
    raise exception 'De publicerade instruktionerna har ändrats sedan utkastet skapades. Jämför med historiken och spara utkastet på nytt innan du publicerar.'
      using errcode = 'PT409';
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
