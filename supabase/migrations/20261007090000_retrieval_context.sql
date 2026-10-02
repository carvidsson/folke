-- Folke – retrieval for conversations (ADR-042).
--
-- Additive. Two SECURITY INVOKER functions, so the caller's RLS applies to
-- every row exactly like search_document_chunks_hybrid (kept unchanged):
--
--   * search_document_context: the same hybrid search (full text + vector,
--     reciprocal rank fusion) but with a larger candidate pool and the
--     document metadata the model needs (validity, upload date, chunk order).
--     The server picks the final context from these candidates
--     (src/server/chat/retrieval.ts).
--   * get_document_context_chunks: re-reads specific chunks that an earlier
--     answer in the same conversation cited, under the same rules as search
--     (assistant, data class, RLS). An earlier answer is never a source in
--     itself; only the verified chunks behind it are reused.

create function public.search_document_context(
  p_assistant_id uuid,
  p_query text,
  p_embedding extensions.halfvec(1536) default null,
  p_embedding_model text default null,
  p_data_class text default null,
  p_limit int default 60
)
returns table (
  chunk_id bigint,
  document_id uuid,
  chunk_index int,
  title text,
  content text,
  location text,
  ai_data_class text,
  valid_from date,
  valid_until date,
  uploaded_at timestamptz,
  score double precision,
  snippet text
)
language sql stable security invoker set search_path = '' as $$
  with params as (
    select least(greatest(p_limit, 1), 150) as n
  ),
  q as (
    select nullif(
      replace(plainto_tsquery('swedish', left(p_query, 2000))::text, ' & ', ' | '),
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
    limit (select n from params)
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
    limit (select n from params)
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score
    from (select id, r from fts union all select id, r from vec) x
    group by id
    order by score desc, id
    limit (select n from params)
  )
  select c.id, d.id, c.chunk_index, d.title, c.content, c.location, d.ai_data_class,
         d.valid_from, d.valid_until, d.created_at, f.score,
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

revoke execute on function public.search_document_context(uuid, text, extensions.halfvec, text, text, int)
  from anon, public;
grant execute on function public.search_document_context(uuid, text, extensions.halfvec, text, text, int)
  to authenticated;

create function public.get_document_context_chunks(
  p_assistant_id uuid,
  p_chunk_ids bigint[],
  p_data_class text default null
)
returns table (
  chunk_id bigint,
  document_id uuid,
  chunk_index int,
  title text,
  content text,
  location text,
  ai_data_class text,
  valid_from date,
  valid_until date,
  uploaded_at timestamptz
)
language sql stable security invoker set search_path = '' as $$
  select c.id, d.id, c.chunk_index, d.title, c.content, c.location, d.ai_data_class,
         d.valid_from, d.valid_until, d.created_at
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  join public.document_assistants da on da.document_id = d.id and da.assistant_id = p_assistant_id
  where app.can_use_assistant(p_assistant_id)
    and (p_data_class is null or d.ai_data_class = p_data_class)
    and c.id = any (p_chunk_ids[1:20])
  order by d.id, c.chunk_index
$$;

revoke execute on function public.get_document_context_chunks(uuid, bigint[], text) from anon, public;
grant execute on function public.get_document_context_chunks(uuid, bigint[], text) to authenticated;
