import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { isSessionExpired, sessionStartedAt } from "@/lib/auth/session-age";
import { canSeeAdministration, roleHas, type Capability } from "@/lib/domain/roles";
import type { User } from "@/lib/domain/types";
import { PROFILE_COLUMNS, toUser, type ProfileRow } from "@/server/data/users";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * The single seam for "who is the current user".
 *
 * A valid session requires:
 *   1. a verified JWT (getClaims validates the signature),
 *   2. MFA completed in this session (aal2),
 *   3. a session younger than 7 days,
 *   4. an active profile.
 * The database enforces the same rules through RLS; this function only makes
 * the UI redirect to the right place instead of rendering empty pages.
 */

export interface Session {
  user: User;
  sessionStartedAt: Date;
}

export type SessionProblem = "unauthenticated" | "mfa_required" | "mfa_setup_required" | "expired" | "inactive";

type SessionResult = { ok: true; session: Session } | { ok: false; problem: SessionProblem };

const LAST_ACTIVE_THROTTLE_MS = 10 * 60 * 1000;

export const resolveSession = cache(async (): Promise<SessionResult> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return { ok: false, problem: "unauthenticated" };
  if (claims.aal !== "aal2") return { ok: false, problem: "mfa_required" };
  if (isSessionExpired(claims.amr)) return { ok: false, problem: "expired" };

  const { data: profile } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", claims.sub)
    .maybeSingle<ProfileRow>();
  if (!profile || profile.status !== "active") return { ok: false, problem: "inactive" };
  // TOTP was reset by an administrator: a new factor must be enrolled.
  if (!profile.mfa_enrolled_at) return { ok: false, problem: "mfa_setup_required" };

  const lastActive = profile.last_active_at ? Date.parse(profile.last_active_at) : 0;
  if (Date.now() - lastActive > LAST_ACTIVE_THROTTLE_MS) {
    await supabase.from("profiles").update({ last_active_at: new Date().toISOString() }).eq("id", profile.id);
  }

  return {
    ok: true,
    session: { user: toUser(profile), sessionStartedAt: new Date(sessionStartedAt(claims.amr)!) },
  };
});

const REDIRECTS: Record<SessionProblem, string> = {
  unauthenticated: "/login",
  mfa_required: "/login/mfa",
  mfa_setup_required: "/login/mfa/setup",
  expired: "/auth/signout?reason=expired",
  // Invited users finish onboarding (activation happens after TOTP); disabled
  // users are signed out there.
  inactive: "/auth/activate",
};

/** For pages and server actions: redirects when there is no valid session. */
export async function getSession(): Promise<Session> {
  const result = await resolveSession();
  if (!result.ok) redirect(REDIRECTS[result.problem]);
  return result.session;
}

/** For route handlers: returns null instead of redirecting. */
export async function getApiSession(): Promise<Session | null> {
  const result = await resolveSession();
  return result.ok ? result.session : null;
}

/**
 * Guard for administration pages. Call it in every admin page and action –
 * not only in the layout, since layouts do not re-run on client navigation.
 * The database enforces the same rule via RLS.
 */
export async function requireAdministrationAccess(): Promise<Session> {
  const session = await getSession();
  if (!canSeeAdministration(session.user.role)) notFound();
  return session;
}

export async function requireCapability(capability: Capability): Promise<Session> {
  const session = await getSession();
  if (!roleHas(session.user.role, capability)) notFound();
  return session;
}

/** Guard for pages that only system administrators may open. */
export async function requireSystemAdminPage(): Promise<Session> {
  const session = await getSession();
  if (session.user.role !== "system_admin") notFound();
  return session;
}
