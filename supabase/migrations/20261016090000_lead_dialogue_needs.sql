-- lead-needs-1 (ADR-052): what the customer asks for, per dialogue.
--
-- A separate, versioned AI pass over the same redacted, pseudonymised dialogue text as the lead
-- analysis. It is stored apart from lead_dialogue_analyses so that the taxonomy and the seller analysis
-- can change version independently, and so that leads without a seller reply can be included.
--
-- Stored: structured labels (codes), message numbers, form/message source and short avidentified
-- paraphrases checked for personal data on the server. Never message texts or customer details.
-- Every count is computed on the server from these rows.

create table public.lead_dialogue_needs (
  id bigint generated always as identity primary key,
  hubspot_thread_id text not null references public.lead_threads (hubspot_thread_id) on delete cascade,
  needs_version text not null check (needs_version ~ '^[a-z0-9.-]{1,40}$'),
  model text not null check (length(model) between 1 and 80),
  -- SHA-256 of the input (dialogue, context, form fields, version).
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The thread's latest message when analysed: reuse without reading HubSpot while unchanged.
  source_latest_message_at timestamptz,
  first_analysed_at timestamptz not null default now(),
  analysed_at timestamptz not null default now(),
  -- 'purchase' | 'after_sales' | 'other'; needs are counted among purchase dialogues only.
  purpose text not null check (purpose in ('purchase', 'after_sales', 'other')),
  -- {needs: [...], signals: [...], requests: [...], timeframe, unavailable: {...}, sellerTopics: [...]}
  result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 20000),
  evidence text not null check (evidence in ('sufficient', 'limited')),
  -- False when there was no text to send (form fields only): labels come from the form only.
  ai boolean not null default true,
  unique (hubspot_thread_id, needs_version, model)
);
create index lead_dialogue_needs_version_idx on public.lead_dialogue_needs (needs_version, model);

alter table public.lead_dialogue_needs enable row level security;
revoke all on public.lead_dialogue_needs from anon, authenticated;
-- Like lead_dialogue_analyses: users write their own analyses (the job runs with the user's session); no delete.
grant select, insert, update on public.lead_dialogue_needs to authenticated;
grant all on public.lead_dialogue_needs to service_role;

-- Readable and writable when the thread's inbox is readable (same rule and InitPlan as ADR-049).
create policy lead_dialogue_needs_select on public.lead_dialogue_needs for select to authenticated
  using (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_needs.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
create policy lead_dialogue_needs_insert on public.lead_dialogue_needs for insert to authenticated
  with check (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_needs.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
create policy lead_dialogue_needs_update on public.lead_dialogue_needs for update to authenticated
  using (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_needs.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  )
  with check (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_needs.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
