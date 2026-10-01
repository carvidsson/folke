-- Folke MVP 0.3 – external AI (OpenAI) behind a server-enforced data guard.
--
-- Additive and non-destructive: new columns with safe defaults, new tables
-- and functions. Existing rows keep their current behaviour:
--   * every existing document is 'internal' and can never be reclassified,
--   * every existing conversation is 'internal' and can never be reclassified,
--   * nobody has AI test access until a system administrator grants it,
--   * assistants keep the default model (ai_model null).
--
-- Data guard (docs/SECURITY.md, ADR-031):
--   * documents.ai_data_class: 'internal' (default, never sent to an external
--     AI provider), 'synthetic' (fictional test data, may be sent),
--     'approved' (reserved for a future approval flow – NOT allowed yet).
--     Only the server (service role) can insert non-internal documents. The
--     class is immutable for everyone, so existing documents can never become
--     eligible by editing metadata.
--   * document_chunks.embedding can only be set for synthetic documents.
--   * conversations.data_class: 'internal' (default, mock only) or
--     'synthetic' (may use the external provider). Only users with
--     profiles.ai_test_access may create synthetic conversations. Immutable.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Documents: data class
-- ---------------------------------------------------------------------------

alter table public.documents
  add column ai_data_class text not null default 'internal'
  check (ai_data_class in ('internal', 'synthetic', 'approved'));

create function app.protect_document_ai_class() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.ai_data_class = 'approved' then
      raise exception 'Godkännande för extern AI-behandling är inte aktiverat' using errcode = '42501';
    end if;
    if new.ai_data_class <> 'internal'
       and current_user not in ('service_role', 'postgres', 'supabase_admin') then
      raise exception 'Dataklassen kan bara sättas av servern' using errcode = '42501';
    end if;
  elsif new.ai_data_class is distinct from old.ai_data_class then
    raise exception 'Dokumentets dataklass kan inte ändras' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger documents_protect_ai_class before insert or update on public.documents
  for each row execute function app.protect_document_ai_class();

-- ---------------------------------------------------------------------------
-- Profiles: AI test access (granted by system administrators via the server)
-- ---------------------------------------------------------------------------

alter table public.profiles add column ai_test_access boolean not null default false;
-- Not added to the authenticated role's column grants: users cannot set it.

create function app.has_ai_test_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and coalesce(
    (select p.ai_test_access from public.profiles p where p.id = auth.uid()), false
  )
$$;

-- ---------------------------------------------------------------------------
-- Conversations: data class
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column data_class text not null default 'internal'
  check (data_class in ('internal', 'synthetic'));

drop policy conversations_owner_insert on public.conversations;
create policy conversations_owner_insert on public.conversations for insert to authenticated
  with check (
    user_id = auth.uid()
    and app.can_use_assistant(assistant_id)
    and (data_class = 'internal' or app.has_ai_test_access())
  );

create or replace function app.protect_conversation_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id or new.assistant_id <> old.assistant_id then
    raise exception 'Konversationens ägare och assistent kan inte ändras' using errcode = '42501';
  end if;
  if new.data_class is distinct from old.data_class then
    raise exception 'Konversationens dataklass kan inte ändras' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Assistants: model choice (validated against the server's allowlist)
-- ---------------------------------------------------------------------------

alter table public.assistants
  add column ai_model text check (ai_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
-- Readable (not secret); written only by the server after a system
-- administrator check. Unknown values fall back to the default model.
grant select (ai_model) on public.assistants to authenticated;

-- ---------------------------------------------------------------------------
-- Chunks: embeddings (synthetic documents only)
-- ---------------------------------------------------------------------------

alter table public.document_chunks
  add column embedding extensions.halfvec(1536),
  add column embedding_model text,
  add column embedded_at timestamptz;

create index document_chunks_embedding_idx on public.document_chunks
  using hnsw (embedding extensions.halfvec_cosine_ops);

create function app.guard_chunk_embedding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.embedding is not null and not exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.ai_data_class = 'synthetic'
  ) then
    raise exception 'Embeddings får bara skapas för syntetiska testdokument' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger document_chunks_guard_embedding before insert or update on public.document_chunks
  for each row execute function app.guard_chunk_embedding();

-- ---------------------------------------------------------------------------
-- Hybrid search: full text + vector similarity, merged with reciprocal rank
-- fusion. SECURITY INVOKER: the caller's RLS applies to every row, exactly
-- like search_document_chunks. p_data_class restricts the documents (the
-- server passes 'synthetic' for conversations that may use an external
-- provider). Vectors are only compared when they were made with the same
-- embedding model as the query.
-- ---------------------------------------------------------------------------

create function public.search_document_chunks_hybrid(
  p_assistant_id uuid,
  p_query text,
  p_embedding extensions.halfvec(1536) default null,
  p_embedding_model text default null,
  p_data_class text default null,
  p_limit int default 8
)
returns table (
  chunk_id bigint,
  document_id uuid,
  title text,
  content text,
  location text,
  ai_data_class text,
  score double precision,
  snippet text
)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select nullif(
      replace(plainto_tsquery('swedish', left(p_query, 1000))::text, ' & ', ' | '),
      ''
    )::tsquery as query
  ),
  eligible as (
    select c.id, c.document_id, c.tsv, c.embedding, c.embedding_model
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    join public.document_assistants da on da.document_id = d.id and da.assistant_id = p_assistant_id
    where app.can_use_assistant(p_assistant_id)
      and (p_data_class is null or d.ai_data_class = p_data_class)
  ),
  fts as (
    select e.id, row_number() over (order by ts_rank_cd(e.tsv, q.query) desc, e.id) as r
    from eligible e, q
    where e.tsv @@ q.query
    order by r
    limit 40
  ),
  vec as (
    select e.id, row_number() over (
             order by e.embedding operator(extensions.<=>) p_embedding, e.id
           ) as r
    from eligible e
    where p_embedding is not null
      and e.embedding is not null
      and e.embedding_model = p_embedding_model
    order by r
    limit 40
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select id, r from fts union all select id, r from vec) x
    group by id
    order by score desc, id
    limit least(greatest(p_limit, 1), 20)
  )
  select c.id, d.id, d.title, c.content, c.location, d.ai_data_class, f.score,
         case when q.query is null then left(c.content, 300)
              else ts_headline(
                'swedish', c.content, q.query,
                'MaxFragments=2, MinWords=12, MaxWords=40, FragmentDelimiter=" … ", StartSel="", StopSel=""'
              )
         end
  from fused f
  join public.document_chunks c on c.id = f.id
  join public.documents d on d.id = c.document_id
  cross join q
  order by f.score desc, c.id
$$;

revoke execute on function public.search_document_chunks_hybrid(uuid, text, extensions.halfvec, text, text, int)
  from anon, public;
grant execute on function public.search_document_chunks_hybrid(uuid, text, extensions.halfvec, text, text, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Usage: embeddings, cached tokens, USD cost, estimates
-- ---------------------------------------------------------------------------

alter table public.ai_usage
  add column kind text not null default 'chat' check (kind in ('chat', 'embedding')),
  add column cached_input_tokens int not null default 0 check (cached_input_tokens >= 0),
  add column reasoning_tokens int not null default 0 check (reasoning_tokens >= 0),
  add column cost_usd numeric(12, 6) not null default 0,
  add column estimated boolean not null default false,
  add column data_class text check (data_class in ('internal', 'synthetic'));

-- ---------------------------------------------------------------------------
-- Request log for rate limits, concurrency limits and budget stops.
-- Written and read only by the server (service role).
-- ---------------------------------------------------------------------------

create table public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('chat', 'embedding')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'aborted')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_requests_user_idx on public.ai_requests (user_id, started_at);
create index ai_requests_started_idx on public.ai_requests (started_at);

alter table public.ai_requests enable row level security;
revoke all on public.ai_requests from anon, authenticated;
grant select, insert, update, delete on public.ai_requests to service_role;

-- Atomically checks limits and registers a request. Returns
-- {"ok": true, "request_id": …} or {"ok": false, "reason": …}.
-- Requests running longer than 3 minutes are considered dead.
create function public.ai_begin_request(
  p_user_id uuid,
  p_kind text,
  p_max_concurrent int,
  p_max_per_minute int,
  p_user_daily_limit_usd numeric,
  p_monthly_limit_usd numeric
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_running int;
  v_recent int;
  v_user_day numeric;
  v_month numeric;
  v_id uuid;
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm';
begin
  perform pg_advisory_xact_lock(hashtext('folke.ai_requests'));

  select coalesce(sum(cost_usd), 0) into v_month
  from public.ai_usage where created_at >= v_month_start;
  if v_month >= p_monthly_limit_usd then
    return jsonb_build_object('ok', false, 'reason', 'monthly_budget');
  end if;

  if p_user_id is not null then
    select coalesce(sum(cost_usd), 0) into v_user_day
    from public.ai_usage where user_id = p_user_id and created_at >= v_today;
    if v_user_day >= p_user_daily_limit_usd then
      return jsonb_build_object('ok', false, 'reason', 'user_daily_budget');
    end if;

    select count(*) into v_running from public.ai_requests
    where user_id = p_user_id and status = 'running' and started_at > now() - interval '3 minutes';
    if v_running >= p_max_concurrent then
      return jsonb_build_object('ok', false, 'reason', 'concurrency');
    end if;

    select count(*) into v_recent from public.ai_requests
    where user_id = p_user_id and started_at > now() - interval '1 minute';
    if v_recent >= p_max_per_minute then
      return jsonb_build_object('ok', false, 'reason', 'rate_limit');
    end if;
  end if;

  insert into public.ai_requests (user_id, kind) values (p_user_id, p_kind) returning id into v_id;
  return jsonb_build_object('ok', true, 'request_id', v_id);
end $$;

create function public.ai_finish_request(p_request_id uuid, p_status text) returns void
language sql security definer set search_path = '' as $$
  update public.ai_requests
  set status = p_status, finished_at = now()
  where id = p_request_id and status = 'running'
$$;

revoke execute on function public.ai_begin_request(uuid, text, int, int, numeric, numeric) from anon, authenticated, public;
revoke execute on function public.ai_finish_request(uuid, text) from anon, authenticated, public;
grant execute on function public.ai_begin_request(uuid, text, int, int, numeric, numeric) to service_role;
grant execute on function public.ai_finish_request(uuid, text) to service_role;

-- Old request rows are only needed for the rate window.
create function public.ai_prune_requests() returns void
language sql security definer set search_path = '' as $$
  delete from public.ai_requests where started_at < now() - interval '2 days'
$$;
revoke execute on function public.ai_prune_requests() from anon, authenticated, public;
grant execute on function public.ai_prune_requests() to service_role;

grant execute on all functions in schema app to authenticated, service_role;
