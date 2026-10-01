-- Folke MVP 0.2 – access also requires a CURRENT TOTP enrolment.
--
-- Problem: when an administrator resets a user's TOTP (e.g. lost or stolen
-- phone), the user's existing aal2 session kept working until it expired,
-- because RLS only checked the token's aal claim.
-- Fix: app.authorized() additionally requires profiles.mfa_enrolled_at to be
-- set. The admin "reset MFA" action clears it, so access stops immediately
-- for every existing session; the user must enrol a new factor.
--
-- Non-destructive: replaces functions only.

create or replace function app.current_profile_mfa_enrolled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select mfa_enrolled_at is not null from public.profiles where id = auth.uid()),
    false
  )
$$;

grant execute on function app.current_profile_mfa_enrolled() to authenticated, service_role;

create or replace function app.authorized() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
     and app.is_aal2()
     and app.session_fresh()
     and app.current_profile_status() = 'active'
     and app.current_profile_mfa_enrolled()
$$;
