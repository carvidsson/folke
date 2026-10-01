-- Folke MVP 0.2 – core schema: profiles, groups, assistants, grants.
--
-- Security model (see docs/ARCHITECTURE.md):
--   * Every table has RLS enabled. Policies go through helper functions in
--     the private `app` schema (not exposed via the Data API).
--   * All access requires an active profile, an MFA-verified session (aal2)
--     and a session younger than 7 days: app.authorized().
--   * Admin changes are audited by triggers (see 20261001090300_operations.sql).


create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.app_role as enum ('system_admin', 'assistant_manager', 'employee');
create type public.user_status as enum ('invited', 'active', 'disabled');
create type public.assistant_status as enum ('active', 'draft', 'paused');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  title text not null default '',
  department text not null default '',
  location text not null default '',
  role public.app_role not null default 'employee',
  status public.user_status not null default 'invited',
  mfa_enrolled_at timestamptz,
  last_active_at timestamptz,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  -- System groups (e.g. "Alla medarbetare") implicitly contain every active user.
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint groups_name_len check (char_length(name) between 1 and 80)
);
create unique index groups_name_key on public.groups (lower(name));

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Group managers may review and approve documents owned by the group.
  is_manager boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.assistants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  tagline text not null default '',
  description text not null default '',
  icon text not null check (icon in ('sales', 'analysis', 'meetings', 'warranty')),
  tone text not null check (tone in ('sage', 'slate', 'sand', 'clay')),
  status public.assistant_status not null default 'draft',
  -- Server-side only: excluded from the authenticated role's column grants.
  instructions text not null default '',
  suggested_prompts text[] not null default '{}',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assistant_managers (
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (assistant_id, user_id)
);

create table public.assistant_grants (
  id uuid primary key default gen_random_uuid(),
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  group_id uuid references public.groups (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint assistant_grants_one_subject check (num_nonnulls(user_id, group_id) = 1)
);
create unique index assistant_grants_user_key on public.assistant_grants (assistant_id, user_id) where user_id is not null;
create unique index assistant_grants_group_key on public.assistant_grants (assistant_id, group_id) where group_id is not null;

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table public.assistant_collections (
  assistant_id uuid not null references public.assistants (id) on delete cascade,
  collection_id uuid not null references public.collections (id) on delete cascade,
  primary key (assistant_id, collection_id)
);

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------

create function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();
create trigger assistants_touch before update on public.assistants
  for each row execute function app.touch_updated_at();

-- Create a profile for every new auth user (users are only created by invite).
-- Only the display name is taken from metadata; role and status are never
-- read from user-controlled metadata.
create function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), '')
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Authorisation helpers (SECURITY DEFINER so policies can use them without
-- recursive RLS; all are STABLE and pin search_path).
-- ---------------------------------------------------------------------------

-- MFA-verified session.
create function app.is_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- Session started less than 7 days ago (defence in depth next to the Auth
-- session timebox). Session start = earliest authentication method timestamp.
create function app.session_fresh() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
    (
      select min((m ->> 'timestamp')::bigint)
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as m
    ) > extract(epoch from now() - interval '7 days'),
    false
  )
$$;

create function app.current_profile_status() returns public.user_status
language sql stable security definer set search_path = '' as $$
  select status from public.profiles where id = auth.uid()
$$;

create function app.user_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;

-- The main gate: active user, MFA-verified, fresh session.
create function app.authorized() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
     and app.is_aal2()
     and app.session_fresh()
     and app.current_profile_status() = 'active'
$$;

create function app.is_system_admin() returns boolean
language sql stable set search_path = '' as $$
  select app.authorized() and app.user_role() = 'system_admin'
$$;

-- Explicit memberships plus implicit system groups.
create function app.user_group_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select gm.group_id from public.group_members gm where gm.user_id = auth.uid()
  union
  select g.id from public.groups g
  where g.is_system and app.current_profile_status() = 'active'
$$;

create function app.is_group_manager(p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = auth.uid() and is_manager
  )
$$;

create function app.is_any_group_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.group_members where user_id = auth.uid() and is_manager
  )
$$;

create function app.is_assistant_manager(p_assistant_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1 from public.assistant_managers
    where assistant_id = p_assistant_id and user_id = auth.uid()
  )
$$;

create function app.can_use_assistant(p_assistant_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.authorized() and exists (
    select 1
    from public.assistants a
    join public.assistant_grants g on g.assistant_id = a.id
    where a.id = p_assistant_id
      and a.status = 'active'
      and (
        g.user_id = auth.uid()
        or g.group_id in (select app.user_group_ids())
      )
  )
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Column-level protection
-- ---------------------------------------------------------------------------

-- Role and status may only be changed by system administrators (or the
-- service role used by server-side admin actions). Nobody changes their own.
create function app.protect_profile_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if new.id <> old.id or new.email <> old.email then
    raise exception 'Profilens id och e-post kan inte ändras här' using errcode = '42501';
  end if;
  if (new.role, new.status, new.mfa_enrolled_at, new.invited_by)
     is distinct from (old.role, old.status, old.mfa_enrolled_at, old.invited_by) then
    if not app.is_system_admin() then
      raise exception 'Endast systemadministratörer kan ändra roll och status' using errcode = '42501';
    end if;
    if new.id = auth.uid() then
      raise exception 'Du kan inte ändra din egen roll eller status' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_protect before update on public.profiles
  for each row execute function app.protect_profile_columns();

-- Assistant instructions are hidden from the API for normal users.
revoke select on public.assistants from authenticated, anon;
grant select (
  id, slug, name, tagline, description, icon, tone, status,
  suggested_prompts, sort_order, created_at, updated_at
) on public.assistants to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.assistants enable row level security;
alter table public.assistant_managers enable row level security;
alter table public.assistant_grants enable row level security;
alter table public.collections enable row level security;
alter table public.assistant_collections enable row level security;

-- Anonymous visitors get nothing.
revoke all on
  public.profiles, public.groups, public.group_members, public.assistants,
  public.assistant_managers, public.assistant_grants, public.collections,
  public.assistant_collections
from anon;

-- profiles: own row always (needed during onboarding before MFA);
-- colleagues' profiles once authorized.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.authorized());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() and app.authorized())
  with check (id = auth.uid());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (app.is_system_admin())
  with check (app.is_system_admin());

-- groups & memberships: readable by authorized users, managed by admins.
create policy groups_select on public.groups for select to authenticated
  using (app.authorized());
create policy groups_admin_insert on public.groups for insert to authenticated
  with check (app.is_system_admin() and not is_system);
create policy groups_admin_update on public.groups for update to authenticated
  using (app.is_system_admin() and not is_system)
  with check (app.is_system_admin() and not is_system);
create policy groups_admin_delete on public.groups for delete to authenticated
  using (app.is_system_admin() and not is_system);

create policy group_members_select on public.group_members for select to authenticated
  using (app.authorized());
create policy group_members_admin_all on public.group_members for all to authenticated
  using (app.is_system_admin())
  with check (
    app.is_system_admin()
    and not exists (select 1 from public.groups g where g.id = group_id and g.is_system)
  );

-- assistants: users see the assistants they may use; admins and managers see
-- all they administer.
create policy assistants_select on public.assistants for select to authenticated
  using (
    app.can_use_assistant(id)
    or app.is_system_admin()
    or app.is_assistant_manager(id)
  );
create policy assistants_admin_insert on public.assistants for insert to authenticated
  with check (app.is_system_admin());
create policy assistants_manage_update on public.assistants for update to authenticated
  using (app.is_system_admin() or app.is_assistant_manager(id))
  with check (app.is_system_admin() or app.is_assistant_manager(id));
create policy assistants_admin_delete on public.assistants for delete to authenticated
  using (app.is_system_admin());

create policy assistant_managers_select on public.assistant_managers for select to authenticated
  using (app.authorized());
create policy assistant_managers_admin_all on public.assistant_managers for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());

-- grants: users see grants that concern them; admins/managers see all.
create policy assistant_grants_select on public.assistant_grants for select to authenticated
  using (
    app.is_system_admin()
    or app.is_assistant_manager(assistant_id)
    or (app.authorized() and (user_id = auth.uid() or group_id in (select app.user_group_ids())))
  );
create policy assistant_grants_admin_all on public.assistant_grants for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());

create policy collections_select on public.collections for select to authenticated
  using (app.authorized());
create policy collections_admin_all on public.collections for all to authenticated
  using (app.is_system_admin()) with check (app.is_system_admin());

create policy assistant_collections_select on public.assistant_collections for select to authenticated
  using (app.authorized());
create policy assistant_collections_manage on public.assistant_collections for all to authenticated
  using (app.is_system_admin() or app.is_assistant_manager(assistant_id))
  with check (app.is_system_admin() or app.is_assistant_manager(assistant_id));

-- Assistants the caller may use (admins can *see* more assistants than they
-- may use; the chat and start page must only offer usable ones).
create function public.my_assistant_ids() returns setof uuid
language sql stable security invoker set search_path = '' as $$
  select a.id from public.assistants a where app.can_use_assistant(a.id)
$$;
revoke execute on function public.my_assistant_ids() from anon, public;
grant execute on function public.my_assistant_ids() to authenticated;
