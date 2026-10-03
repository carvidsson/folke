-- Lead analysis (ADR-047): a lead with a registered seller reply where the
-- customer wrote last and no later seller message is registered in HubSpot.
-- A deterministic fact; it may have been answered outside HubSpot.
alter table public.lead_threads add column customer_wrote_last boolean not null default false;
