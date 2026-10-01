import "server-only";

import { logSecurityEvent } from "@/server/audit";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export type ActivationResult = "active" | "activated" | "disabled" | "failed";

/**
 * Final onboarding step. Call ONLY after the current session reached aal2
 * (successful TOTP). An invited user becomes active; disabled users stay
 * disabled. Uses the secret-key client because users cannot change their own
 * status (by design).
 */
export async function activateCurrentUserIfInvited(userId: string): Promise<ActivationResult> {
  const supabase = await createSupabaseServerClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", userId)
    .maybeSingle<{ status: string }>();

  if (profile?.status === "active") return "active";
  if (profile?.status !== "invited") return "disabled";

  const { error } = await createSupabaseAdminClient()
    .from("profiles")
    .update({ status: "active" })
    .eq("id", userId)
    .eq("status", "invited");
  if (error) {
    console.error("[auth] activation failed", error.message);
    return "failed";
  }
  await logSecurityEvent("auth.activated", { actorId: userId });
  return "activated";
}

export const ACTIVATION_REDIRECTS: Record<ActivationResult, string> = {
  active: "/",
  activated: "/",
  disabled: "/auth/signout?reason=disabled",
  failed: "/login?error=activation",
};
