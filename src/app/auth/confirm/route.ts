import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Landing point for links in invitation and password-reset e-mails.
 * The e-mail templates must link here with `token_hash` and `type`
 * (see docs/SETUP.md). Verifying the token creates a password-only (aal1)
 * session, after which the user chooses a password and completes TOTP.
 */
const ALLOWED_TYPES: EmailOtpType[] = ["invite", "recovery"];

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(new URL("/login/set-password", request.url));
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", request.url));
}
