-- Folke MVP 0.2 – knowledge base: documents, sharing, review, chunks, search.
--
-- Rules:
--   * A document is owned by a group (its area of responsibility) and shared
--     with that group by default. More groups can be added.
--   * New documents are 'pending' until a reviewer approves them. Reviewers are
--     system administrators and managers of the owning group.
--   * Only approved, processed and currently valid documents are searchable,
--     and only by members of groups the document is shared with, through an
--     assistant the document is linked to.
--   * Files live in the private 'documents' bucket. Only the server (service
--     role) touches storage; there are no storage policies for end users.
--   * Pilot policy: uploaders must attest that the file is internal and
--     contains no customer data (internal_only_attested_at).

create type public.document_review_status as enum ('pending', 'approved', 'rejected', 'archived');
create type public.document_processing_status as enum ('queued', 'processing', 'ready', 'failed');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null,
  file_type text not null check (file_type in ('pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  storage_path text unique,
  collection_id uuid not null references public.collections (id),
  owner_group_id uuid not null references public.groups (id),
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  internal_only_attested_at timestamptz not null,
  review_status public.document_review_status not null default 'pending',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  processing_status public.document_processing_status not null default 'queued',
  processing_error text,
  page_count int,
  char_count int,
  valid_from date not null default current_date,
  valid_until date,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_validity check (valid_until is null or valid_until >= valid_from)
);
create index documents_owner_group_idx on public.documents (owner_group_id);
create index documents_review_idx on public.documents (review_status);

create table public.document_shares (
  document_id uuid not null references public.documents (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  primary key (document_id, group_id)
);
create index document_shares_group_idx on public.document_shares (group_id);

create table public.document_assistants (
  document_id uuid not null references public.documents (id) on delete cascade,
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  primary key (document_id, assistant_id)
);

create table public.document_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  location text,
  tsv tsvector generated always as (to_tsvector('swedish', content)) stored,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);

create trigger documents_touch before update on public.documents
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function app.can_upload_documents() returns boolean
language sql stable set search_path = '' as $$
  select app.authorized() and (
    app.user_role() in ('system_admin', 'assistant_manager')
    or app.is_any_group_manager()
  )
$$;

create function app.can_review_document(p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.documents d
    where d.id = p_document_id
      and (app.user_role() = 'system_admin' or app.is_group_manager(d.owner_group_id))
  )
$$;

-- Visible in the knowledge base (metadata).
create function app.can_read_document(p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.documents d
    where d.id = p_document_id
      and (
        d.uploaded_by = auth.uid()
        or app.user_role() = 'system_admin'
        or app.is_group_manager(d.owner_group_id)
        or (
          d.review_status = 'approved'
          and exists (
            select 1 from public.document_shares s
            where s.document_id = d.id and s.group_id in (select app.user_group_ids())
          )
        )
      )
  )
$$;

-- Usable as a source in answers: approved, processed, valid today, shared
-- with one of the user's groups.
create function app.can_search_document(p_document_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.documents d
    where d.id = p_document_id
      and d.review_status = 'approved'
      and d.processing_status = 'ready'
      and d.valid_from <= current_date
      and (d.valid_until is null or d.valid_until >= current_date)
      and exists (
        select 1 from public.document_shares s
        where s.document_id = d.id and s.group_id in (select app.user_group_ids())
      )
  )
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- Share with the owning group by default.
create function app.share_with_owner_group() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.document_shares (document_id, group_id)
  values (new.id, new.owner_group_id)
  on conflict do nothing;
  return new;
end $$;

create trigger documents_default_share after insert on public.documents
  for each row execute function app.share_with_owner_group();

-- Column rules for updates by end users.
create function app.protect_document_columns() returns trigger
language plpgsql set search_path = '' as $$
declare
  is_reviewer boolean;
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  -- Processing results and file location are written by the server only.
  if (new.processing_status, new.processing_error, new.page_count, new.char_count,
      new.storage_path, new.size_bytes, new.mime_type, new.file_type, new.file_name)
     is distinct from
     (old.processing_status, old.processing_error, old.page_count, old.char_count,
      old.storage_path, old.size_bytes, old.mime_type, old.file_type, old.file_name) then
    raise exception 'Bearbetningsfält kan bara ändras av servern' using errcode = '42501';
  end if;
  if new.uploaded_by <> old.uploaded_by or new.internal_only_attested_at <> old.internal_only_attested_at then
    raise exception 'Uppladdare och intygande kan inte ändras' using errcode = '42501';
  end if;

  is_reviewer := app.user_role() = 'system_admin' or app.is_group_manager(old.owner_group_id);

  if (new.review_status, new.reviewed_by, new.reviewed_at, new.review_comment)
     is distinct from (old.review_status, old.reviewed_by, old.reviewed_at, old.review_comment) then
    if not is_reviewer then
      raise exception 'Du saknar behörighet att granska dokumentet' using errcode = '42501';
    end if;
    if new.review_status = 'approved' and new.processing_status <> 'ready' then
      raise exception 'Dokumentet kan godkännas först när bearbetningen är klar' using errcode = '23514';
    end if;
    if new.review_status is distinct from old.review_status then
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
  end if;

  if new.owner_group_id <> old.owner_group_id and not (
    app.user_role() = 'system_admin' or app.is_group_manager(new.owner_group_id)
  ) then
    raise exception 'Du kan inte flytta dokumentet till den gruppen' using errcode = '42501';
  end if;

  -- Uploaders (non-reviewers) may only edit metadata while the document is
  -- not approved, and any edit sends it back for review.
  if not is_reviewer then
    if old.review_status = 'approved' then
      raise exception 'Godkända dokument kan bara ändras av en granskare' using errcode = '42501';
    end if;
    new.review_status := 'pending';
  end if;

  return new;
end $$;

create trigger documents_protect before update on public.documents
  for each row execute function app.protect_document_columns();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.documents enable row level security;
alter table public.document_shares enable row level security;
alter table public.document_assistants enable row level security;
alter table public.document_chunks enable row level security;

revoke all on public.documents, public.document_shares, public.document_assistants, public.document_chunks from anon;
-- Chunks are written only by the server.
revoke insert, update, delete on public.document_chunks from authenticated;

-- The inline uploader check is needed for INSERT ... RETURNING: a new row is
-- not yet visible to app.can_read_document() within the same statement.
create policy documents_select on public.documents for select to authenticated
  using ((uploaded_by = auth.uid() and app.authorized()) or app.can_read_document(id));

create policy documents_insert on public.documents for insert to authenticated
  with check (
    app.can_upload_documents()
    and uploaded_by = auth.uid()
    and review_status = 'pending'
    and processing_status = 'queued'
    and storage_path is null
    and internal_only_attested_at is not null
    and (
      app.user_role() = 'system_admin'
      or owner_group_id in (
        select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
      )
    )
  );

create policy documents_update on public.documents for update to authenticated
  using (
    app.can_review_document(id)
    or (app.authorized() and uploaded_by = auth.uid())
  )
  with check (app.authorized());

create policy documents_delete on public.documents for delete to authenticated
  using (
    app.can_review_document(id)
    or (app.authorized() and uploaded_by = auth.uid() and review_status in ('pending', 'rejected'))
  );

-- Sharing: reviewers may share with any group; uploaders only with their own
-- groups while the document is not approved.
create policy document_shares_select on public.document_shares for select to authenticated
  using (app.can_read_document(document_id));
create policy document_shares_insert on public.document_shares for insert to authenticated
  with check (
    app.can_review_document(document_id)
    or (
      app.authorized()
      and group_id in (select gm.group_id from public.group_members gm where gm.user_id = auth.uid())
      and exists (
        select 1 from public.documents d
        where d.id = document_id and d.uploaded_by = auth.uid() and d.review_status <> 'approved'
      )
    )
  );
create policy document_shares_delete on public.document_shares for delete to authenticated
  using (
    app.can_review_document(document_id)
    or exists (
      select 1 from public.documents d
      where d.id = document_id and d.uploaded_by = auth.uid()
        and d.review_status <> 'approved' and app.authorized()
    )
  );

create policy document_assistants_select on public.document_assistants for select to authenticated
  using (app.can_read_document(document_id));
create policy document_assistants_insert on public.document_assistants for insert to authenticated
  with check (
    app.can_review_document(document_id)
    or exists (
      select 1 from public.documents d
      where d.id = document_id and d.uploaded_by = auth.uid()
        and d.review_status <> 'approved' and app.authorized()
    )
  );
create policy document_assistants_delete on public.document_assistants for delete to authenticated
  using (
    app.can_review_document(document_id)
    or exists (
      select 1 from public.documents d
      where d.id = document_id and d.uploaded_by = auth.uid()
        and d.review_status <> 'approved' and app.authorized()
    )
  );

create policy document_chunks_select on public.document_chunks for select to authenticated
  using (app.can_search_document(document_id));

-- ---------------------------------------------------------------------------
-- Search (SECURITY INVOKER: the caller's RLS applies to every row).
-- ---------------------------------------------------------------------------

-- Swedish full-text search over chunks the caller may use, restricted to
-- documents linked to the given assistant. Terms are OR-ed so natural
-- questions still match; ranking favours chunks with more matching terms.
create function public.search_document_chunks(
  p_assistant_id uuid,
  p_query text,
  p_limit int default 8
)
returns table (
  chunk_id bigint,
  document_id uuid,
  title text,
  content text,
  location text,
  rank real
)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select nullif(
      replace(plainto_tsquery('swedish', left(p_query, 1000))::text, ' & ', ' | '),
      ''
    )::tsquery as query
  )
  select c.id, d.id, d.title, c.content, c.location, ts_rank_cd(c.tsv, q.query) as rank
  from q
  join public.document_chunks c on c.tsv @@ q.query
  join public.documents d on d.id = c.document_id
  join public.document_assistants da on da.document_id = d.id and da.assistant_id = p_assistant_id
  where app.can_use_assistant(p_assistant_id)
  order by rank desc, c.id
  limit least(greatest(p_limit, 1), 20)
$$;

revoke execute on function public.search_document_chunks(uuid, text, int) from anon, public;
grant execute on function public.search_document_chunks(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, no end-user policies (server-only access).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 52428800,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/markdown', 'text/csv'
  ]
)
on conflict (id) do nothing;
