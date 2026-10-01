-- Folke MVP 0.2 – explicit table privileges for the API roles.
--
-- New Supabase projects do not grant table privileges to anon,
-- authenticated or service_role automatically. Privileges are therefore
-- granted explicitly and minimally here:
--   * Table/column privileges decide WHICH OPERATIONS a role may attempt.
--   * RLS policies and triggers still decide WHICH ROWS and WHICH CHANGES.
--   * anon gets nothing.
-- Every new table must be added here (or in its own migration) together
-- with RLS policies and tests in tests/db.

-- ---------------------------------------------------------------------------
-- service_role: server-side operations after authorisation checks
-- (invitations, storage, processing results, usage and audit records).
-- service_role bypasses RLS but still needs ordinary privileges.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- authenticated: signed-in users. Rows are restricted by RLS.
-- ---------------------------------------------------------------------------

-- Profiles: read colleagues (RLS), edit own details; role/status/inviter are
-- column-granted but protected by app.protect_profile_columns (admins only).
-- id, email, mfa_enrolled_at and timestamps are not writable by users.
grant select on public.profiles to authenticated;
grant update (full_name, title, department, location, last_active_at, role, status, invited_by)
  on public.profiles to authenticated;

grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.group_members to authenticated;

-- Assistants: SELECT is column-granted in the core migration (instructions
-- excluded). Updates are limited to configurable columns.
grant insert, delete on public.assistants to authenticated;
grant update (name, tagline, description, status, instructions, suggested_prompts, sort_order)
  on public.assistants to authenticated;

grant select, insert, delete on public.assistant_managers to authenticated;
grant select, insert, delete on public.assistant_grants to authenticated;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, delete on public.assistant_collections to authenticated;

-- Documents: processing columns are protected by app.protect_document_columns.
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, delete on public.document_shares to authenticated;
grant select, insert, delete on public.document_assistants to authenticated;
-- Chunks are written by the server only.
grant select on public.document_chunks to authenticated;

-- Conversations are private (RLS: owner only). Messages are immutable.
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;

-- Read-only for users (RLS: own usage / admins); written by the server.
grant select on public.ai_usage to authenticated;
grant select on public.audit_log to authenticated;
