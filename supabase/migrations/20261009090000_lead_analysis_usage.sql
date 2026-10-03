-- Experimental lead analysis (ADR-046): AI usage for classifying redacted
-- HubSpot lead dialogues is recorded with its own purpose, so cost is
-- visible separately and counts against the same budgets. No HubSpot data
-- is stored in the database.
alter table public.ai_usage drop constraint ai_usage_purpose_check;
alter table public.ai_usage add constraint ai_usage_purpose_check
  check (purpose in ('conversation', 'indexing', 'instruction_test', 'attachment_indexing', 'lead_analysis'));
