-- Folke – conversation attachments (ADR-045).
--
-- Working material a user attaches to their own conversation: documents
-- (text is extracted and chunked like the knowledge base) and images. Kept
-- strictly apart from the knowledge base (public.documents):
--
--   * owner only – like conversations there is NO administrator policy,
--   * never searched by the knowledge-base functions, never approved,
--   * deleted with the conversation (cascade), the user or the purge,
--   * files live in their own private bucket that only the server touches;
--     every deleted attachment queues its file for removal
--     (storage_deletion_queue), so a failed Storage call can be retried.

-- ---------------------------------------------------------------------------
-- Storage: private bucket, no end-user policies (server-only access).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'conversation-attachments', 'conversation-attachments', false, 20971520,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/markdown', 'text/csv',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif'
  ]
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------

create table public.conversation_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- Set when the message is sent; until then the upload belongs to the user only.
  conversation_id uuid references public.conversations (id) on delete cascade,
  kind text not null check (kind in ('document', 'image')),
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_type text not null
    check (file_type in ('pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'png', 'jpeg', 'webp', 'gif')),
  mime_type text not null check (char_length(mime_type) <= 255),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  storage_path text unique,
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed')),
  error text check (char_length(error) <= 500),
  -- How the model receives the file: extracted text, the PDF itself (no text
  -- layer, e.g. scanned) or an image.
  content_mode text check (content_mode in ('text', 'pdf_inline', 'image')),
  page_count int,
  char_count int,
  created_at timestamptz not null default now(),
  check ((kind = 'image') = (file_type in ('png', 'jpeg', 'webp', 'gif')))
);
create index conversation_attachments_conversation_idx on public.conversation_attachments (conversation_id, created_at);
create index conversation_attachments_user_idx on public.conversation_attachments (user_id, created_at);

create table public.conversation_attachment_chunks (
  id bigint generated always as identity primary key,
  attachment_id uuid not null references public.conversation_attachments (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  location text,
  tsv tsvector generated always as (to_tsvector('swedish', content)) stored,
  embedding extensions.halfvec(1536),
  embedding_model text,
  unique (attachment_id, chunk_index)
);
create index conversation_attachment_chunks_tsv_idx on public.conversation_attachment_chunks using gin (tsv);

-- Files to remove from Storage. Server only: a row stays until the removal
-- succeeded, with attempts and the last error, so it can be retried later.
create table public.storage_deletion_queue (
  id bigint generated always as identity primary key,
  bucket text not null,
  path text not null,
  reason text not null,
  attempts int not null default 0,
  last_error text,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now()
);
create index storage_deletion_queue_created_idx on public.storage_deletion_queue (created_at);

-- ---------------------------------------------------------------------------
-- Helpers and triggers
-- ---------------------------------------------------------------------------

create function app.owns_attachment(p_attachment_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.conversation_attachments
    where id = p_attachment_id and user_id = auth.uid()
  )
$$;
grant execute on function app.owns_attachment(uuid) to authenticated, service_role;

-- A bound attachment stays in its conversation; processing fields are
-- written by the server only.
create function app.protect_attachment_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if old.conversation_id is not null and new.conversation_id is distinct from old.conversation_id then
    raise exception 'Bilagan hör redan till en konversation' using errcode = '42501';
  end if;
  if (new.user_id, new.kind, new.file_name, new.file_type, new.mime_type, new.size_bytes, new.storage_path,
      new.status, new.error, new.content_mode, new.page_count, new.char_count, new.created_at)
     is distinct from
     (old.user_id, old.kind, old.file_name, old.file_type, old.mime_type, old.size_bytes, old.storage_path,
      old.status, old.error, old.content_mode, old.page_count, old.char_count, old.created_at) then
    raise exception 'Bilagans uppgifter kan bara ändras av servern' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger conversation_attachments_protect before update on public.conversation_attachments
  for each row execute function app.protect_attachment_columns();

-- New uploads start empty: users cannot point a row at a stored file or mark it ready.
create function app.guard_attachment_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if new.storage_path is not null or new.status <> 'uploading' or new.content_mode is not null
     or new.error is not null or new.page_count is not null or new.char_count is not null then
    raise exception 'Bilagans uppgifter kan bara sättas av servern' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger conversation_attachments_guard_insert before insert on public.conversation_attachments
  for each row execute function app.guard_attachment_insert();

-- Every deleted attachment (by the user, the conversation, the purge or the
-- account) queues its file.
create function app.queue_attachment_file() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.storage_path is not null then
    insert into public.storage_deletion_queue (bucket, path, reason)
    values ('conversation-attachments', old.storage_path, 'attachment_deleted');
  end if;
  return old;
end $$;

create trigger conversation_attachments_queue_file after delete on public.conversation_attachments
  for each row execute function app.queue_attachment_file();

-- ---------------------------------------------------------------------------
-- RLS and grants (owner only; no administrator policy)
-- ---------------------------------------------------------------------------

alter table public.conversation_attachments enable row level security;
alter table public.conversation_attachment_chunks enable row level security;
alter table public.storage_deletion_queue enable row level security;

revoke all on public.conversation_attachments, public.conversation_attachment_chunks, public.storage_deletion_queue
  from anon, authenticated;
grant select, delete on public.conversation_attachments to authenticated;
grant insert (kind, file_name, file_type, mime_type, size_bytes) on public.conversation_attachments to authenticated;
grant update (conversation_id) on public.conversation_attachments to authenticated;
grant select on public.conversation_attachment_chunks to authenticated;
grant select, insert, update, delete on public.conversation_attachments, public.conversation_attachment_chunks,
  public.storage_deletion_queue to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy conversation_attachments_owner_select on public.conversation_attachments for select to authenticated
  using (user_id = auth.uid() and app.authorized());
create policy conversation_attachments_owner_insert on public.conversation_attachments for insert to authenticated
  with check (user_id = auth.uid() and app.authorized() and conversation_id is null);
create policy conversation_attachments_owner_update on public.conversation_attachments for update to authenticated
  using (user_id = auth.uid() and app.authorized())
  with check (user_id = auth.uid() and (conversation_id is null or app.owns_conversation(conversation_id)));
create policy conversation_attachments_owner_delete on public.conversation_attachments for delete to authenticated
  using (user_id = auth.uid() and app.authorized());

create policy conversation_attachment_chunks_owner_select on public.conversation_attachment_chunks
  for select to authenticated using (app.owns_attachment(attachment_id));

-- ---------------------------------------------------------------------------
-- Search within one conversation's attachments (SECURITY INVOKER: the
-- caller's RLS applies). Hybrid like the knowledge base, but a separate
-- function so the knowledge-base search can never return attachments.
-- `fts_match` tells whether the words of the question occur in the chunk.
-- ---------------------------------------------------------------------------

create function public.search_conversation_attachments(
  p_conversation_id uuid,
  p_query text,
  p_embedding extensions.halfvec(1536) default null,
  p_embedding_model text default null,
  p_limit int default 40
)
returns table (
  chunk_id bigint,
  attachment_id uuid,
  chunk_index int,
  file_name text,
  content text,
  location text,
  score double precision,
  fts_match boolean
)
language sql stable security invoker set search_path = '' as $$
  with params as (
    select least(greatest(p_limit, 1), 100) as n
  ),
  q as (
    select nullif(replace(plainto_tsquery('swedish', left(p_query, 2000))::text, ' & ', ' | '), '')::tsquery as query
  ),
  eligible as (
    select c.id, c.tsv, c.embedding, c.embedding_model
    from public.conversation_attachment_chunks c
    join public.conversation_attachments a on a.id = c.attachment_id
    where a.conversation_id = p_conversation_id
      and a.status = 'ready'
      and app.owns_conversation(p_conversation_id)
  ),
  fts as (
    select e.id, row_number() over (order by ts_rank_cd(e.tsv, q.query) desc, e.id) as r
    from eligible e, q
    where e.tsv @@ q.query
    order by r
    limit (select n from params)
  ),
  vec as (
    select e.id, row_number() over (order by e.embedding operator(extensions.<=>) p_embedding, e.id) as r
    from eligible e
    where p_embedding is not null and e.embedding is not null and e.embedding_model = p_embedding_model
    order by r
    limit (select n from params)
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score, bool_or(src = 'fts') as fts_match
    from (select id, r, 'fts' as src from fts union all select id, r, 'vec' from vec) x
    group by id
    order by score desc, id
    limit (select n from params)
  )
  select c.id, a.id, c.chunk_index, a.file_name, c.content, c.location, f.score, f.fts_match
  from fused f
  join public.conversation_attachment_chunks c on c.id = f.id
  join public.conversation_attachments a on a.id = c.attachment_id
  order by f.score desc, c.id
$$;

revoke execute on function public.search_conversation_attachments(uuid, text, extensions.halfvec, text, int) from anon, public;
grant execute on function public.search_conversation_attachments(uuid, text, extensions.halfvec, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- AI usage: embeddings of attachments are their own purpose
-- ---------------------------------------------------------------------------

alter table public.ai_usage drop constraint ai_usage_purpose_check;
alter table public.ai_usage add constraint ai_usage_purpose_check
  check (purpose in ('conversation', 'indexing', 'instruction_test', 'attachment_indexing'));
