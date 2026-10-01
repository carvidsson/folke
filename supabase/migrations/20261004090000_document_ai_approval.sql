-- Folke – per-document approval for OpenAI (ADR-036).
--
-- Activates the reserved data class 'approved'. A system administrator can
-- explicitly approve ONE document at a time for processing by the external
-- AI provider, and revoke it again. Nothing is approved automatically:
-- every existing and new document stays 'internal' until approved.
--
-- Additive and non-destructive: new columns with safe defaults, a stricter
-- replacement of the class trigger, and an approval function.
--
-- Rules:
--   * The class can only change internal <-> approved, and only through
--     public.set_document_ai_approval() (system administrators). Direct
--     updates are rejected, also for the service role.
--   * Revoking removes the document's embeddings in the same transaction;
--     retrieval filters on the class at query time, so a revoked document is
--     excluded from the very next AI call.
--   * Synthetic test documents keep their immutable class.
--   * Index status columns are written by the server only.

alter table public.documents
  add column ai_approved_by uuid references public.profiles (id) on delete set null,
  add column ai_approved_at timestamptz,
  add column ai_index_status text not null default 'none'
    check (ai_index_status in ('none', 'pending', 'indexing', 'ready', 'failed')),
  add column ai_index_error text,
  add column ai_indexed_at timestamptz;

create or replace function app.protect_document_ai_class() returns trigger
language plpgsql set search_path = '' as $$
declare
  via_approval boolean := coalesce(current_setting('app.ai_approval', true), '') = 'on'
                          and current_user not in ('authenticated', 'anon');
  is_server boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  if tg_op = 'INSERT' then
    if new.ai_data_class = 'approved' then
      raise exception 'Dokument godkänns för OpenAI efter uppladdning' using errcode = '42501';
    end if;
    if new.ai_data_class <> 'internal' and not is_server then
      raise exception 'Dataklassen kan bara sättas av servern' using errcode = '42501';
    end if;
    if not is_server and (new.ai_approved_by is not null or new.ai_approved_at is not null
        or new.ai_index_status <> 'none' or new.ai_index_error is not null or new.ai_indexed_at is not null) then
      raise exception 'AI-fält kan bara sättas av servern' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.ai_data_class is distinct from old.ai_data_class then
    if not (via_approval and old.ai_data_class in ('internal', 'approved')
            and new.ai_data_class in ('internal', 'approved')) then
      raise exception 'Dokumentets dataklass kan bara ändras genom godkännande för OpenAI' using errcode = '42501';
    end if;
  end if;
  if (new.ai_approved_by, new.ai_approved_at) is distinct from (old.ai_approved_by, old.ai_approved_at)
     and not via_approval then
    raise exception 'Godkännande för OpenAI kan bara ändras av en systemadministratör' using errcode = '42501';
  end if;
  if (new.ai_index_status, new.ai_index_error, new.ai_indexed_at)
     is distinct from (old.ai_index_status, old.ai_index_error, old.ai_indexed_at)
     and not (via_approval or is_server) then
    raise exception 'Indexeringsstatus kan bara ändras av servern' using errcode = '42501';
  end if;
  return new;
end $$;

-- Embeddings: synthetic or approved documents only.
create or replace function app.guard_chunk_embedding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.embedding is not null and not exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.ai_data_class in ('synthetic', 'approved')
  ) then
    raise exception 'Embeddings får bara skapas för dokument som är godkända för OpenAI' using errcode = '42501';
  end if;
  return new;
end $$;

-- Approve (p_approved = true) or revoke one document. Returns the new class.
create function public.set_document_ai_approval(p_document_id uuid, p_approved boolean)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_class text;
  v_processing public.document_processing_status;
begin
  if not app.is_system_admin() then
    raise exception 'Endast systemadministratörer kan godkänna dokument för OpenAI' using errcode = '42501';
  end if;

  select d.ai_data_class, d.processing_status into v_class, v_processing
  from public.documents d where d.id = p_document_id for update;
  if not found then
    raise exception 'Dokumentet hittades inte' using errcode = 'P0002';
  end if;
  if v_class = 'synthetic' then
    raise exception 'Syntetiska testdokument hanteras från AI-sidan' using errcode = '42501';
  end if;

  perform set_config('app.ai_approval', 'on', true);
  if p_approved then
    if v_processing <> 'ready' then
      raise exception 'Dokumentet kan godkännas för OpenAI först när texten har lästs in' using errcode = '23514';
    end if;
    update public.documents
    set ai_data_class = 'approved',
        ai_approved_by = auth.uid(),
        ai_approved_at = now(),
        ai_index_status = 'pending',
        ai_index_error = null
    where id = p_document_id and ai_data_class <> 'approved';
  else
    update public.document_chunks
    set embedding = null, embedding_model = null, embedded_at = null
    where document_id = p_document_id;
    update public.documents
    set ai_data_class = 'internal',
        ai_approved_by = null,
        ai_approved_at = null,
        ai_index_status = 'none',
        ai_index_error = null,
        ai_indexed_at = null
    where id = p_document_id;
  end if;
  perform set_config('app.ai_approval', 'off', true);

  return case when p_approved then 'approved' else 'internal' end;
end $$;

revoke execute on function public.set_document_ai_approval(uuid, boolean) from anon, public;
grant execute on function public.set_document_ai_approval(uuid, boolean) to authenticated;

grant execute on all functions in schema app to authenticated, service_role;
