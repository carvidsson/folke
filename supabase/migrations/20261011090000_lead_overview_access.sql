-- Lead analysis, next step (ADR-048, builds on ADR-046/047).
--
-- * Configured inboxes with organisational dimensions (region, facility, brand).
--   Regions are data, not code. HubSpot inbox id stays the stable key.
-- * Sync coverage: which periods Folke has fetched from HubSpot, and when.
-- * Per lead: the car (brand/model, only when identified), message times for
--   deterministic follow-up facts.
-- * Analyses: richer, avidentified situation assessment (lead-ai-3).
-- * Runs for a region or all regions (summaries of stored classifications).
-- * Access: groups or users, optionally limited to one region. Enforced by RLS.
-- * Settings: a HubSpot thread URL pattern verified by an administrator.
-- Still no message texts or customer contact details.

-- ---------------------------------------------------------------------------
-- Regions and inbox configuration
-- ---------------------------------------------------------------------------

create table public.lead_regions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 1 and 80),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
insert into public.lead_regions (name, sort_order) values ('Alingsås', 1), ('Skåne', 2), ('Blekinge', 3);

alter table public.lead_inboxes
  add column active boolean not null default false,
  add column region_id uuid references public.lead_regions (id) on delete set null,
  add column facility text check (facility is null or length(facility) between 1 and 80),
  add column brand text check (brand is null or length(brand) between 1 and 80);

-- ---------------------------------------------------------------------------
-- Per lead: car and message times (deterministic, no text)
-- ---------------------------------------------------------------------------

alter table public.lead_threads
  add column latest_message_at timestamptz,
  add column last_customer_message_at timestamptz,
  add column first_seller_after_customer_at timestamptz,
  add column followed_up boolean not null default false,
  add column vehicle_brand text check (vehicle_brand is null or length(vehicle_brand) between 1 and 40),
  add column vehicle_model text check (vehicle_model is null or length(vehicle_model) between 1 and 60),
  add column vehicle_source text check (vehicle_source is null or vehicle_source in ('subject', 'fields', 'page'));
create index lead_threads_brand_idx on public.lead_threads (vehicle_brand, vehicle_model);

alter table public.lead_dialogue_analyses
  -- What the analysis was based on: reuse without fetching HubSpot when unchanged.
  add column source_latest_message_at timestamptz,
  add column situation_state text check (situation_state is null or situation_state in ('none', 'customer_last', 'too_early', 'waiting')),
  -- lead-ai-3: the customer's situation and whether the dialogue moved forward (avidentified text).
  add column assessment jsonb check (assessment is null or jsonb_typeof(assessment) = 'object');

-- ---------------------------------------------------------------------------
-- Sync coverage
-- ---------------------------------------------------------------------------

create table public.lead_syncs (
  id bigint generated always as identity primary key,
  hubspot_inbox_id text not null references public.lead_inboxes (hubspot_inbox_id) on delete cascade,
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  synced_at timestamptz not null default now(),
  synced_by uuid references public.profiles (id) on delete set null default auth.uid(),
  leads int not null default 0 check (leads >= 0),
  -- False when HubSpot could not be read completely: the period is then not covered.
  complete boolean not null
);
create index lead_syncs_inbox_idx on public.lead_syncs (hubspot_inbox_id, synced_at desc);

-- ---------------------------------------------------------------------------
-- Runs for an inbox, a region or all regions
-- ---------------------------------------------------------------------------

alter table public.lead_analysis_runs
  alter column hubspot_inbox_id drop not null,
  add column scope_type text not null default 'inbox' check (scope_type in ('inbox', 'region', 'all')),
  add column region_id uuid references public.lead_regions (id) on delete set null,
  add constraint lead_analysis_runs_scope check (
    (scope_type = 'inbox' and hubspot_inbox_id is not null)
    or (scope_type = 'region' and hubspot_inbox_id is null)
    or (scope_type = 'all' and hubspot_inbox_id is null and region_id is null)
  );
create index lead_analysis_runs_scope_idx on public.lead_analysis_runs (scope_type, region_id, finished_at desc);

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------

create table public.lead_settings (
  id boolean primary key default true check (id),
  hubspot_portal_id text check (hubspot_portal_id is null or hubspot_portal_id ~ '^[0-9]{1,20}$'),
  -- Derived from a real conversation URL pasted by an administrator; {threadId} is replaced per lead.
  hubspot_thread_url_template text check (
    hubspot_thread_url_template is null
    or (hubspot_thread_url_template like 'https://%' and hubspot_thread_url_template like '%{threadId}%' and length(hubspot_thread_url_template) <= 300)
  ),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
insert into public.lead_settings default values;

-- ---------------------------------------------------------------------------
-- Access: a group or a user, all regions (region_id null) or one region
-- ---------------------------------------------------------------------------

create table public.lead_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  group_id uuid references public.groups (id) on delete cascade,
  region_id uuid references public.lead_regions (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  constraint lead_access_grants_one_subject check (num_nonnulls(user_id, group_id) = 1)
);
create unique index lead_access_grants_user_key on public.lead_access_grants (user_id, coalesce(region_id, '00000000-0000-0000-0000-000000000000'::uuid)) where user_id is not null;
create unique index lead_access_grants_group_key on public.lead_access_grants (group_id, coalesce(region_id, '00000000-0000-0000-0000-000000000000'::uuid)) where group_id is not null;

-- ---------------------------------------------------------------------------
-- Helper functions (security definer: users cannot read the grants)
-- ---------------------------------------------------------------------------

create function app.my_lead_grants() returns table (region_id uuid)
language sql stable security definer set search_path = '' as $$
  select g.region_id from public.lead_access_grants g
  where app.authorized() and (g.user_id = auth.uid() or g.group_id in (select app.user_group_ids()))
$$;

create function app.has_lead_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_system_admin() or exists (select 1 from app.my_lead_grants())
$$;

create function app.has_all_lead_regions() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_system_admin() or exists (select 1 from app.my_lead_grants() g where g.region_id is null)
$$;

create function app.can_read_lead_region(p_region_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_all_lead_regions() or exists (select 1 from app.my_lead_grants() g where g.region_id = p_region_id)
$$;

-- Users see active inboxes in their regions; system administrators see all.
create function app.can_read_lead_inbox(p_inbox_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_system_admin() or exists (
    select 1 from public.lead_inboxes i
    where i.hubspot_inbox_id = p_inbox_id and i.active
      and (app.has_all_lead_regions() or (i.region_id is not null and app.can_read_lead_region(i.region_id)))
  )
$$;

create function app.can_read_lead_thread(p_thread_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lead_threads t where t.hubspot_thread_id = p_thread_id and app.can_read_lead_inbox(t.hubspot_inbox_id))
$$;

create function app.can_read_lead_run(p_scope text, p_inbox_id text, p_region_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_scope
    when 'inbox' then app.can_read_lead_inbox(p_inbox_id)
    when 'region' then p_region_id is not null and app.can_read_lead_region(p_region_id)
    else app.has_all_lead_regions()
  end
$$;

revoke execute on function app.my_lead_grants(), app.has_lead_access(), app.has_all_lead_regions(),
  app.can_read_lead_region(uuid), app.can_read_lead_inbox(text), app.can_read_lead_thread(text),
  app.can_read_lead_run(text, text, uuid) from public, anon;
grant execute on function app.my_lead_grants(), app.has_lead_access(), app.has_all_lead_regions(),
  app.can_read_lead_region(uuid), app.can_read_lead_inbox(text), app.can_read_lead_thread(text),
  app.can_read_lead_run(text, text, uuid) to authenticated, service_role;

-- What the signed-in user may see (for the server; the database enforces it anyway).
create function public.my_lead_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'has_access', app.has_lead_access(),
    'is_admin', app.is_system_admin(),
    'all_regions', app.has_all_lead_regions(),
    'region_ids', coalesce((select jsonb_agg(distinct g.region_id) from app.my_lead_grants() g where g.region_id is not null), '[]'::jsonb)
  )
$$;
revoke execute on function public.my_lead_access() from public, anon;
grant execute on function public.my_lead_access() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: replace the system-administrator-only policies (ADR-047)
-- ---------------------------------------------------------------------------

drop policy lead_inboxes_admin on public.lead_inboxes;
drop policy lead_sellers_admin on public.lead_sellers;
drop policy lead_threads_admin on public.lead_threads;
drop policy lead_dialogue_analyses_admin on public.lead_dialogue_analyses;
drop policy lead_analysis_runs_select on public.lead_analysis_runs;
drop policy lead_analysis_runs_insert on public.lead_analysis_runs;

-- Configuration: read by those with access, written by system administrators.
create policy lead_inboxes_select on public.lead_inboxes for select to authenticated using (app.can_read_lead_inbox(hubspot_inbox_id));
create policy lead_inboxes_admin_insert on public.lead_inboxes for insert to authenticated with check (app.is_system_admin());
create policy lead_inboxes_admin_update on public.lead_inboxes for update to authenticated using (app.is_system_admin()) with check (app.is_system_admin());

create policy lead_sellers_select on public.lead_sellers for select to authenticated using (app.has_lead_access());
create policy lead_sellers_insert on public.lead_sellers for insert to authenticated with check (app.has_lead_access());
create policy lead_sellers_update on public.lead_sellers for update to authenticated using (app.has_lead_access()) with check (app.has_lead_access());

-- Lead data: anyone who may read the inbox may also refresh it from HubSpot.
create policy lead_threads_select on public.lead_threads for select to authenticated using (app.can_read_lead_inbox(hubspot_inbox_id));
create policy lead_threads_insert on public.lead_threads for insert to authenticated with check (app.can_read_lead_inbox(hubspot_inbox_id));
create policy lead_threads_update on public.lead_threads for update to authenticated
  using (app.can_read_lead_inbox(hubspot_inbox_id)) with check (app.can_read_lead_inbox(hubspot_inbox_id));

create policy lead_dialogue_analyses_select on public.lead_dialogue_analyses for select to authenticated using (app.can_read_lead_thread(hubspot_thread_id));
create policy lead_dialogue_analyses_insert on public.lead_dialogue_analyses for insert to authenticated with check (app.can_read_lead_thread(hubspot_thread_id));
create policy lead_dialogue_analyses_update on public.lead_dialogue_analyses for update to authenticated
  using (app.can_read_lead_thread(hubspot_thread_id)) with check (app.can_read_lead_thread(hubspot_thread_id));

create policy lead_analysis_runs_select on public.lead_analysis_runs for select to authenticated
  using (app.can_read_lead_run(scope_type, hubspot_inbox_id, region_id));
create policy lead_analysis_runs_insert on public.lead_analysis_runs for insert to authenticated
  with check (app.can_read_lead_run(scope_type, hubspot_inbox_id, region_id) and created_by = auth.uid());

alter table public.lead_regions enable row level security;
alter table public.lead_syncs enable row level security;
alter table public.lead_settings enable row level security;
alter table public.lead_access_grants enable row level security;

revoke all on public.lead_regions, public.lead_syncs, public.lead_settings, public.lead_access_grants from anon, authenticated;
grant select, insert, update, delete on public.lead_regions to authenticated;
grant select, insert on public.lead_syncs to authenticated;
grant select, update on public.lead_settings to authenticated;
grant select, insert, delete on public.lead_access_grants to authenticated;
grant all on public.lead_regions, public.lead_syncs, public.lead_settings, public.lead_access_grants to service_role;

create policy lead_regions_select on public.lead_regions for select to authenticated using (app.has_lead_access());
create policy lead_regions_admin on public.lead_regions for all to authenticated using (app.is_system_admin()) with check (app.is_system_admin());

create policy lead_syncs_select on public.lead_syncs for select to authenticated using (app.can_read_lead_inbox(hubspot_inbox_id));
create policy lead_syncs_insert on public.lead_syncs for insert to authenticated
  with check (app.can_read_lead_inbox(hubspot_inbox_id) and synced_by = auth.uid());

create policy lead_settings_select on public.lead_settings for select to authenticated using (app.has_lead_access());
create policy lead_settings_admin on public.lead_settings for update to authenticated using (app.is_system_admin()) with check (app.is_system_admin());

create policy lead_access_grants_admin on public.lead_access_grants for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());
