import { NextResponse, type NextRequest } from "next/server";

import { isSessionExpired } from "@/lib/auth/session-age";
import { ACTIVATION_REDIRECTS, activateCurrentUserIfInvited } from "@/server/auth/activation";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Final onboarding step after a successful TOTP verification.
 * An invited user becomes active the first time they complete MFA.
 * Disabled users are signed out.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303 });

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return to("/login");
  if (claims.aal !== "aal2") return to("/login/mfa");
  if (isSessionExpired(claims.amr)) return to("/auth/signout?reason=expired");

  return to(ACTIVATION_REDIRECTS[await activateCurrentUserIfInvited(claims.sub)]);
}
