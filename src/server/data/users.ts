import "server-only";

import type { ID, Role, User, UserGroup, UserStatus } from "@/lib/domain/types";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

// All queries run as the signed-in user; RLS decides what is returned.

export const PROFILE_COLUMNS =
  "id, email, full_name, title, department, location, role, status, mfa_enrolled_at, last_active_at";

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  title: string;
  department: string;
  location: string;
  role: Role;
  status: UserStatus;
  mfa_enrolled_at: string | null;
  last_active_at: string | null;
}

export function toUser(row: ProfileRow): User {
  return {
    id: row.id,
    name: row.full_name || row.email,
    email: row.email,
    title: row.title,
    department: row.department,
    location: row.location,
    role: row.role,
    status: row.status,
    mfaEnrolled: row.mfa_enrolled_at !== null,
    lastActiveAt: row.last_active_at,
  };
}

export async function listUsers(): Promise<User[]> {
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase.from("profiles").select(PROFILE_COLUMNS).order("full_name").returns<ProfileRow[]>(),
  );
  return rows.map(toUser);
}

export async function getUser(id: ID): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  const row = unwrap(
    await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", id).maybeSingle<ProfileRow>(),
  );
  return row ? toUser(row) : null;
}

interface GroupRow {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  group_members: { user_id: string; is_manager: boolean }[];
}

/**
 * Groups with members. System groups implicitly contain all active users,
 * so their member list is derived from profiles.
 */
export async function listGroups(): Promise<UserGroup[]> {
  const supabase = await createSupabaseServerClient();
  const [groups, active] = await Promise.all([
    supabase
      .from("groups")
      .select("id, name, description, is_system, group_members(user_id, is_manager)")
      .order("is_system", { ascending: false })
      .order("name")
      .returns<GroupRow[]>(),
    supabase.from("profiles").select("id").eq("status", "active").returns<{ id: string }[]>(),
  ]);
  const activeIds = unwrap(active).map((p) => p.id);
  return unwrap(groups).map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    system: g.is_system,
    memberIds: g.is_system ? activeIds : g.group_members.map((m) => m.user_id),
    managerIds: g.group_members.filter((m) => m.is_manager).map((m) => m.user_id),
  }));
}
