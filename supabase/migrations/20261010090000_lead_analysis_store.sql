-- Persistent lead analysis (ADR-047, builds on ADR-046).
--
-- HubSpot remains the source of truth for the conversations. Folke stores
-- only structured analysis data: deterministic facts per lead, AI
-- classifications per dialogue (versioned, with a fingerprint of the
-- source), and one row per AI run. No customer names, e-mail addresses,
-- phone numbers, personnummer or message texts are stored.
--
-- Access: system administrators only (read and write through their own
-- session, RLS). Rows are never deleted by users; the service role can.

-- ---------------------------------------------------------------------------
-- Inboxes and sellers (HubSpot ids are the stable identity)
-- ---------------------------------------------------------------------------

create table public.lead_inboxes (
  hubspot_inbox_id text primary key check (hubspot_inbox_id ~ '^[0-9]{1,20}$'),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lead_sellers (
  hubspot_actor_id text primary key check (hubspot_actor_id ~ '^A-[0-9]{1,20}$'),
  -- The HubSpot user's name (an employee), refreshed on each run.
  display_name text check (display_name is null or length(display_name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Deterministic facts per lead
-- ---------------------------------------------------------------------------

create table public.lead_threads (
  hubspot_thread_id text primary key check (hubspot_thread_id ~ '^[0-9]{1,20}$'),
  hubspot_inbox_id text not null references public.lead_inboxes (hubspot_inbox_id),
  facts_version int not null check (facts_version > 0),
  arrived_at timestamptz not null,
  arrival_window text not null check (arrival_window in ('business_hours', 'weekday_off_hours', 'weekend')),
  channel text not null check (channel in ('form', 'email', 'other')),
  -- Source, form and car (listing title): business context, never customer data.
  source text check (length(source) <= 100),
  form_name text check (length(form_name) <= 200),
  vehicle text check (length(vehicle) <= 200),
  reply_status text not null check (reply_status in ('registered_reply', 'no_registered_reply', 'uncertain')),
  first_response_at timestamptz,
  calendar_minutes int check (calendar_minutes >= 0),
  business_minutes int check (business_minutes >= 0),
  owner_actor_id text references public.lead_sellers (hubspot_actor_id),
  responder_actor_id text references public.lead_sellers (hubspot_actor_id),
  assignment_events int not null default 0,
  moved_into_inbox boolean not null default false,
  thread_open boolean not null default false,
  customer_messages int not null default 0,
  seller_messages int not null default 0,
  internal_comments int not null default 0,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((reply_status = 'registered_reply') = (first_response_at is not null))
);
create index lead_threads_inbox_arrived_idx on public.lead_threads (hubspot_inbox_id, arrived_at);
create index lead_threads_responder_arrived_idx on public.lead_threads (responder_actor_id, arrived_at);

-- ---------------------------------------------------------------------------
-- AI classification per dialogue, versioned
-- ---------------------------------------------------------------------------

create table public.lead_dialogue_analyses (
  id bigint generated always as identity primary key,
  hubspot_thread_id text not null references public.lead_threads (hubspot_thread_id) on delete cascade,
  -- How the result was produced. A result is only reused (and only compared
  -- with others) for the same analysis_version and model.
  analysis_version text not null check (analysis_version ~ '^[a-z0-9.-]{1,40}$'),
  model text not null check (length(model) between 1 and 80),
  -- SHA-256 of the analysis input (dialogue, context, version): a changed
  -- dialogue gives a new fingerprint and a new analysis.
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  first_analysed_at timestamptz not null default now(),
  analysed_at timestamptz not null default now(),
  seller_actor_id text references public.lead_sellers (hubspot_actor_id),
  intent text not null,
  purchase_intent text not null,
  car_status text not null,
  alternative_offered text not null,
  -- {behaviour: {"status": "done" | "missing" | "not_relevant" | "unclear", "reason": text}}
  behaviours jsonb not null check (jsonb_typeof(behaviours) = 'object'),
  -- Short AI observations about the seller's handling (checked for personal data before saving).
  observations text[] not null default '{}' check (cardinality(observations) <= 3),
  evidence text not null check (evidence in ('sufficient', 'limited')),
  unique (hubspot_thread_id, analysis_version, model)
);
create index lead_dialogue_analyses_version_idx on public.lead_dialogue_analyses (analysis_version, model);

-- ---------------------------------------------------------------------------
-- AI runs: what was analysed, how, at what cost, and the combined analysis
-- ---------------------------------------------------------------------------

create table public.lead_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  hubspot_inbox_id text not null references public.lead_inboxes (hubspot_inbox_id),
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  analysis_version text not null,
  model text not null,
  facts_version int not null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  leads int not null check (leads >= 0),
  dialogues_analysed int not null check (dialogues_analysed >= 0),
  analysed_new int not null check (analysed_new >= 0),
  reused int not null check (reused >= 0),
  not_analysed jsonb not null default '[]'::jsonb,
  cost_usd numeric(12, 6) not null default 0,
  -- Aggregated facts and AI counts for the period (no per-lead data).
  facts jsonb not null,
  counts jsonb not null,
  -- The combined analysis; sellers are referenced as {{A-123}}, not by name.
  summary jsonb
);
create index lead_analysis_runs_inbox_idx on public.lead_analysis_runs (hubspot_inbox_id, finished_at desc);

-- ---------------------------------------------------------------------------
-- Timestamps, RLS and grants
-- ---------------------------------------------------------------------------

create trigger lead_inboxes_touch before update on public.lead_inboxes
  for each row execute function app.touch_updated_at();
create trigger lead_sellers_touch before update on public.lead_sellers
  for each row execute function app.touch_updated_at();
create trigger lead_threads_touch before update on public.lead_threads
  for each row execute function app.touch_updated_at();

alter table public.lead_inboxes enable row level security;
alter table public.lead_sellers enable row level security;
alter table public.lead_threads enable row level security;
alter table public.lead_dialogue_analyses enable row level security;
alter table public.lead_analysis_runs enable row level security;

revoke all on public.lead_inboxes, public.lead_sellers, public.lead_threads,
  public.lead_dialogue_analyses, public.lead_analysis_runs from anon, authenticated;
grant select, insert, update on public.lead_inboxes, public.lead_sellers, public.lead_threads,
  public.lead_dialogue_analyses to authenticated;
-- Runs are append-only for users.
grant select, insert on public.lead_analysis_runs to authenticated;
grant all on public.lead_inboxes, public.lead_sellers, public.lead_threads,
  public.lead_dialogue_analyses, public.lead_analysis_runs to service_role;

create policy lead_inboxes_admin on public.lead_inboxes for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());
create policy lead_sellers_admin on public.lead_sellers for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());
create policy lead_threads_admin on public.lead_threads for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());
create policy lead_dialogue_analyses_admin on public.lead_dialogue_analyses for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());
create policy lead_analysis_runs_select on public.lead_analysis_runs for select to authenticated
  using (app.is_system_admin());
create policy lead_analysis_runs_insert on public.lead_analysis_runs for insert to authenticated
  with check (app.is_system_admin() and created_by = auth.uid());
