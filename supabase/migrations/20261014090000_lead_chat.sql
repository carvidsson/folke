-- Leadanalys i chatten (ADR-050).
--
-- A separate assistant answers questions about the lead analysis from data already stored in Folke.
-- It never starts a HubSpot sync or a new dialogue analysis, and the user's own client reads all lead
-- data, so the lead access rules (lead_access_grants, RLS) apply unchanged.
--
-- 1. assistants.kind: 'lead_analysis' marks the assistant whose conversations use the lead analysis
--    instead of document retrieval. Readable by users; never updatable through the API.
-- 2. conversations.data_class 'lead' and lead_context: a lead conversation is its own data class
--    (immutable, like the others). lead_context only remembers which selection the conversation is
--    about (ids and a period) – the server re-resolves it against the user's current access on every
--    turn, so it can never grant or widen access.
-- 3. ai_usage: purpose 'lead_chat' and data class 'lead', so cost is visible separately.
-- 4. The Leadanalys assistant itself (active, without grants: administrators decide who may use it).

-- 1 -------------------------------------------------------------------------
alter table public.assistants
  add column kind text not null default 'documents' check (kind in ('documents', 'lead_analysis'));
grant select (kind) on public.assistants to authenticated;

create function app.assistant_kind(p_assistant_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select a.kind from public.assistants a where a.id = p_assistant_id
$$;
revoke execute on function app.assistant_kind(uuid) from public, anon;
grant execute on function app.assistant_kind(uuid) to authenticated, service_role;

-- 2 -------------------------------------------------------------------------
alter table public.conversations drop constraint if exists conversations_data_class_check;
alter table public.conversations
  add constraint conversations_data_class_check check (data_class in ('internal', 'synthetic', 'lead'));

alter table public.conversations
  add column lead_context jsonb
  check (lead_context is null or (jsonb_typeof(lead_context) = 'object' and pg_column_size(lead_context) <= 2048)),
  add constraint conversations_lead_context_class check (lead_context is null or data_class = 'lead');

-- The lead assistant only has lead conversations, and only users with lead access may start them;
-- document assistants never get lead conversations.
drop policy conversations_owner_insert on public.conversations;
create policy conversations_owner_insert on public.conversations for insert to authenticated
  with check (
    user_id = auth.uid()
    and app.can_use_assistant(assistant_id)
    and case app.assistant_kind(assistant_id)
      when 'lead_analysis' then data_class = 'lead' and app.has_lead_access()
      else data_class = 'internal' or (data_class = 'synthetic' and app.has_ai_test_access())
    end
  );

-- 3 -------------------------------------------------------------------------
alter table public.ai_usage drop constraint ai_usage_purpose_check;
alter table public.ai_usage add constraint ai_usage_purpose_check
  check (purpose in ('conversation', 'indexing', 'instruction_test', 'attachment_indexing', 'lead_analysis', 'lead_chat'));
alter table public.ai_usage drop constraint if exists ai_usage_data_class_check;
alter table public.ai_usage add constraint ai_usage_data_class_check
  check (data_class in ('internal', 'synthetic', 'lead'));

-- 4 -------------------------------------------------------------------------
insert into public.assistants (slug, name, tagline, description, icon, tone, status, instructions, suggested_prompts, sort_order, kind)
values (
  'leadanalys',
  'Leadanalys',
  'Frågor om hur leads tas emot och besvaras',
  'Svarar på frågor om leadshanteringen utifrån Leadanalys: svarstider, källor, säljare, utveckling över tid och sparade AI-analyser av dialogerna – med länkar till underlaget och originaldialogen i HubSpot.',
  'analysis',
  'slate',
  'active',
  E'Du hjälper säljchefer att förstå och utveckla leadshanteringen.\n\n'
  || E'- Svara kort och konkret först, fördjupa sedan. Använd rubriker eller punktlistor när det hjälper läsningen.\n'
  || E'- Var ett stöd för coachning och verksamhetsutveckling – aldrig en bedömning av personer. Rangordna inte säljare och ge inga betyg.\n'
  || E'- Lyft det som fungerar lika tydligt som det som kan utvecklas.\n'
  || E'- Avsluta gärna med en eller två naturliga möjligheter att gå vidare, till exempel att visa exempel, jämföra med föregående period eller sammanfatta inför ett säljmöte.',
  array['Vad sticker ut senaste 30 dagarna?', 'Hur är svarstiden i våra inkorgar?', 'Vad bör vi ta upp på nästa säljmöte?'],
  90,
  'lead_analysis'
)
on conflict (slug) do nothing;
