import "server-only";

import { serverEnv } from "@/server/env";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Invitations in Supabase Auth (only after the caller checked the system administrator role).
 *
 * Supabase sends an invitation only to an account that has not used a link yet; a new invitation then
 * replaces the token (the old link stops working) and gets a new validity. Once a link has been used –
 * by the person, or by an e-mail scanner that opened it – Supabase refuses new invitations
 * ("email_exists"). For an account that was never used in Folke (see `unusedInvitation`), the Auth
 * account is then removed and invited anew: a new id, a new token and a new validity, and the caller
 * restores role and groups. Accounts that have been used are never removed here.
 */

export type InviteFailure = "email_exists" | "rate_limited" | "failed";
export type InviteResult = { ok: true; userId: string } | { ok: false; code: InviteFailure };

function redirectTo() {
  return `${serverEnv().NEXT_PUBLIC_SITE_URL}/auth/confirm`;
}

export async function sendInvitation(email: string, fullName: string | null): Promise<InviteResult> {
  const { data, error } = await createSupabaseAdminClient().auth.admin.inviteUserByEmail(email, {
    ...(fullName ? { data: { full_name: fullName } } : {}),
    redirectTo: redirectTo(),
  });
  if (!error && data.user) return { ok: true, userId: data.user.id };
  if (error?.code === "email_exists") return { ok: false, code: "email_exists" };
  // Supabase Auth limits how many e-mails it sends (per address and per hour for the project).
  if (error?.code === "over_email_send_rate_limit" || error?.status === 429) return { ok: false, code: "rate_limited" };
  console.error("[admin] invitation failed", error?.code ?? "unknown");
  return { ok: false, code: "failed" };
}

/** The Auth account for an e-mail address (case-insensitive), or null. */
export async function authUserIdByEmail(email: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === wanted);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

/**
 * A profile that only exists because of an invitation: still invited, never signed in to Folke with
 * two-step verification (no last activity, no registered factor). Removing and re-inviting it loses
 * nothing – Folke requires a verified TOTP session for any data.
 */
export function unusedInvitation(profile: { status: string; mfa_enrolled_at: string | null; last_active_at: string | null } | null): boolean {
  return !!profile && profile.status === "invited" && !profile.mfa_enrolled_at && !profile.last_active_at;
}

/**
 * Removes an unused Auth account and invites the address again. Refuses when the account has a
 * verified MFA factor (it has been used). Returns the new user id.
 *
 * If the new e-mail cannot be sent (for example Supabase's e-mail rate limit), the account is still
 * created again – without an e-mail – so that the caller can restore role and groups and nothing is
 * lost; `pendingUserId` then names it, and a later "Skicka inbjudan igen" sends the e-mail.
 */
export async function recreateInvitation(
  userId: string,
  email: string,
  fullName: string | null,
): Promise<InviteResult | { ok: false; code: InviteFailure; pendingUserId: string }> {
  const admin = createSupabaseAdminClient();
  const { data: factors, error: factorError } = await admin.auth.admin.mfa.listFactors({ userId });
  if (factorError) return { ok: false, code: "failed" };
  if (factors.factors.some((f) => f.status === "verified")) return { ok: false, code: "email_exists" };
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[admin] could not remove unused invitation", error.code ?? "unknown");
    return { ok: false, code: "failed" };
  }
  const sent = await sendInvitation(email, fullName);
  if (sent.ok) return sent;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { ...(fullName ? { data: { full_name: fullName } } : {}), redirectTo: redirectTo() },
  });
  if (linkError || !link.user) {
    console.error("[admin] could not recreate the invited account", linkError?.code ?? "unknown");
    return sent;
  }
  return { ok: false, code: sent.code, pendingUserId: link.user.id };
}
