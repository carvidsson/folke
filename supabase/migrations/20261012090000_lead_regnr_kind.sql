-- Leadanalys (ADR-048): what the lead form's registration number field contained.
--
-- 'plate'   a value in Swedish plate format
-- 'virtual' the dealer system's placeholder "Virtuell" (listings without a physical car, e.g. incoming
--           or to order). A signal for analysis, not a vehicle status.
-- 'other'   another value ("Okänt", odd formats)
-- null      no such field (e-mail leads, forms without it)
--
-- Only the kind is stored, never the registration number itself. Table-level grants and the RLS
-- policies on lead_threads already cover the new column. FACTS_VERSION 3 fills it on the next sync.

alter table public.lead_threads
  add column regnr_kind text check (regnr_kind is null or regnr_kind in ('plate', 'virtual', 'other'));

create index lead_threads_regnr_kind_idx on public.lead_threads (hubspot_inbox_id, regnr_kind);
