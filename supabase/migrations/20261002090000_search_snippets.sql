-- Folke MVP 0.2 – query-focused excerpts in document search.
--
-- Problem: answers and source cards showed the BEGINNING of a matching chunk,
-- not the passage that matched. Short documents become a single chunk, so the
-- relevant sentence could be far from the start.
-- Fix: return a `snippet` built with ts_headline (fragments around matching
-- terms) next to the full chunk text. The full text is still returned for use
-- as model context; the snippet is used for source cards and the mock answer.
--
-- Non-destructive: replaces a function only. Access rules are unchanged:
-- SECURITY INVOKER, so RLS on documents/chunks applies to every row.

drop function if exists public.search_document_chunks(uuid, text, int);

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
  rank real,
  snippet text
)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select nullif(
      replace(plainto_tsquery('swedish', left(p_query, 1000))::text, ' & ', ' | '),
      ''
    )::tsquery as query
  ),
  hits as (
    select c.id, d.id as document_id, d.title, c.content, c.location,
           ts_rank_cd(c.tsv, q.query) as rank, q.query
    from q
    join public.document_chunks c on c.tsv @@ q.query
    join public.documents d on d.id = c.document_id
    join public.document_assistants da on da.document_id = d.id and da.assistant_id = p_assistant_id
    where app.can_use_assistant(p_assistant_id)
    order by rank desc, c.id
    limit least(greatest(p_limit, 1), 20)
  )
  select id, document_id, title, content, location, rank,
         ts_headline(
           'swedish', content, query,
           'MaxFragments=2, MinWords=12, MaxWords=40, FragmentDelimiter=" … ", StartSel="", StopSel=""'
         )
  from hits
  order by rank desc, id
$$;

revoke execute on function public.search_document_chunks(uuid, text, int) from anon, public;
grant execute on function public.search_document_chunks(uuid, text, int) to authenticated;
