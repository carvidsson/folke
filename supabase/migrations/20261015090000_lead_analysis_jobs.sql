-- AI analysis of an inbox as a server-side job (ADR-051).
--
-- An analysis takes 60–200 seconds. It used to live in one long request from the browser: when the
-- phone locked or the tab reloaded, the user saw an error while the server finished – and a new click
-- started the same analysis again (double cost). Now:
--   - start_lead_analysis_job registers the job and returns at once; the work runs on the server after
--     the response (Next.js after(), within the route's max duration) and reports here;
--   - at most one running job per inbox, period, analysis method and model (unique index): a second
--     start returns the running job instead of starting another;
--   - the job keeps a heartbeat; a job without one for 150 seconds, or older than 6 minutes, can never
--     be running any more (the platform stops the function at 5 minutes) and is marked failed;
--   - the page and the chat read the status from here, so leaving and coming back shows the truth.

create table public.lead_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  hubspot_inbox_id text not null references public.lead_inboxes (hubspot_inbox_id) on delete cascade,
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  analysis_version text not null check (char_length(analysis_version) <= 40),
  model text not null check (char_length(model) <= 64),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_by uuid references public.profiles (id) on delete set null default auth.uid(),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  run_id uuid references public.lead_analysis_runs (id) on delete set null,
  -- A short Swedish message for the user, never dialogue content.
  error text check (error is null or char_length(error) <= 300)
);
create unique index lead_analysis_jobs_one_running on public.lead_analysis_jobs (hubspot_inbox_id, period_from, period_to, analysis_version, model)
  where status = 'running';
create index lead_analysis_jobs_lookup on public.lead_analysis_jobs (hubspot_inbox_id, period_from, period_to, started_at desc);

alter table public.lead_analysis_jobs enable row level security;
revoke all on public.lead_analysis_jobs from anon, authenticated;
grant select on public.lead_analysis_jobs to authenticated;
grant all on public.lead_analysis_jobs to service_role;
-- Read like the inbox itself; written only through the functions below.
create policy lead_analysis_jobs_select on public.lead_analysis_jobs for select to authenticated
  using (app.can_read_lead_inbox(hubspot_inbox_id));

-- Start, or join the running job. Returns the job and whether this call created it.
create function public.start_lead_analysis_job(p_inbox text, p_from date, p_to date, p_version text, p_model text)
returns table (id uuid, status text, started_at timestamptz, created boolean)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if auth.uid() is null or not app.can_read_lead_inbox(p_inbox) then
    raise exception 'Behörighet saknas' using errcode = '42501';
  end if;
  -- A job that can no longer be running (no heartbeat, or past the platform limit) is failed.
  update public.lead_analysis_jobs j
     set status = 'failed', finished_at = now(), error = 'Analysen avbröts innan den blev klar.'
   where j.hubspot_inbox_id = p_inbox and j.period_from = p_from and j.period_to = p_to
     and j.analysis_version = p_version and j.model = p_model and j.status = 'running'
     and (j.heartbeat_at < now() - interval '150 seconds' or j.started_at < now() - interval '6 minutes');

  insert into public.lead_analysis_jobs (hubspot_inbox_id, period_from, period_to, analysis_version, model, started_by)
  values (p_inbox, p_from, p_to, p_version, p_model, auth.uid())
  on conflict (hubspot_inbox_id, period_from, period_to, analysis_version, model) where status = 'running' do nothing
  returning lead_analysis_jobs.id into v_id;

  if v_id is not null then
    return query select j.id, j.status, j.started_at, true from public.lead_analysis_jobs j where j.id = v_id;
  else
    return query select j.id, j.status, j.started_at, false from public.lead_analysis_jobs j
      where j.hubspot_inbox_id = p_inbox and j.period_from = p_from and j.period_to = p_to
        and j.analysis_version = p_version and j.model = p_model and j.status = 'running';
  end if;
end $$;
revoke execute on function public.start_lead_analysis_job(text, date, date, text, text) from public, anon;
grant execute on function public.start_lead_analysis_job(text, date, date, text, text) to authenticated, service_role;

-- Heartbeat ('running') or the end ('completed' with the run, or 'failed' with a message). Only the
-- user who started the job, only while it is running, and only with a run of the same inbox.
create function public.update_lead_analysis_job(p_id uuid, p_status text, p_run_id uuid default null, p_error text default null)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rows int;
begin
  if p_status not in ('running', 'completed', 'failed') then
    raise exception 'Ogiltig status' using errcode = '22023';
  end if;
  update public.lead_analysis_jobs j
     set heartbeat_at = now(),
         status = p_status,
         finished_at = case when p_status = 'running' then null else now() end,
         run_id = case when p_status = 'completed' then p_run_id else j.run_id end,
         error = case when p_status = 'failed' then left(coalesce(p_error, 'Analysen kunde inte genomföras.'), 300) else null end
   where j.id = p_id and j.status = 'running' and j.started_by = auth.uid()
     and (p_run_id is null or exists (
       select 1 from public.lead_analysis_runs r where r.id = p_run_id and r.hubspot_inbox_id = j.hubspot_inbox_id));
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;
revoke execute on function public.update_lead_analysis_job(uuid, text, uuid, text) from public, anon;
grant execute on function public.update_lead_analysis_job(uuid, text, uuid, text) to authenticated, service_role;
