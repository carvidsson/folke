-- Leadanalys (ADR-049): the same access rules, evaluated once per query instead of once per row.
--
-- The policies on lead_threads, lead_syncs and lead_dialogue_analyses called app.can_read_lead_inbox()
-- for every row (about 1.5 ms per row: 1 287 leads took ~1.9 s to read). Here the set of readable
-- inboxes is computed once – `(select …)` makes it an InitPlan – and each row is checked against it.
--
-- Semantics are unchanged (tests/db/leads.test.ts):
-- - a system administrator reads everything (as before, also inboxes that are not configured);
-- - other users read active inboxes in the regions they have access to (all regions with a grant
--   without region).

create function app.readable_lead_inboxes() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.hubspot_inbox_id), '{}'::text[])
  from public.lead_inboxes i
  where i.active and (app.has_all_lead_regions() or (i.region_id is not null and app.can_read_lead_region(i.region_id)))
$$;
revoke execute on function app.readable_lead_inboxes() from public, anon;
grant execute on function app.readable_lead_inboxes() to authenticated, service_role;

-- lead_threads
drop policy lead_threads_select on public.lead_threads;
drop policy lead_threads_insert on public.lead_threads;
drop policy lead_threads_update on public.lead_threads;
create policy lead_threads_select on public.lead_threads for select to authenticated
  using ((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[]));
create policy lead_threads_insert on public.lead_threads for insert to authenticated
  with check ((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[]));
create policy lead_threads_update on public.lead_threads for update to authenticated
  using ((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[]))
  with check ((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[]));

-- lead_syncs
drop policy lead_syncs_select on public.lead_syncs;
drop policy lead_syncs_insert on public.lead_syncs;
create policy lead_syncs_select on public.lead_syncs for select to authenticated
  using ((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[]));
create policy lead_syncs_insert on public.lead_syncs for insert to authenticated
  with check (((select app.is_system_admin()) or hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])) and synced_by = auth.uid());

-- lead_dialogue_analyses: readable when the thread's inbox is readable.
drop policy lead_dialogue_analyses_select on public.lead_dialogue_analyses;
drop policy lead_dialogue_analyses_insert on public.lead_dialogue_analyses;
drop policy lead_dialogue_analyses_update on public.lead_dialogue_analyses;
create policy lead_dialogue_analyses_select on public.lead_dialogue_analyses for select to authenticated
  using (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_analyses.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
create policy lead_dialogue_analyses_insert on public.lead_dialogue_analyses for insert to authenticated
  with check (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_analyses.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
create policy lead_dialogue_analyses_update on public.lead_dialogue_analyses for update to authenticated
  using (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_analyses.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  )
  with check (
    (select app.is_system_admin())
    or exists (
      select 1 from public.lead_threads t
      where t.hubspot_thread_id = lead_dialogue_analyses.hubspot_thread_id and t.hubspot_inbox_id = any ((select app.readable_lead_inboxes())::text[])
    )
  );
