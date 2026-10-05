import { NextResponse, type NextRequest } from "next/server";

import { emailLinkSchema } from "@/lib/auth/email-link";

/**
 * Landing point for links in invitation and password-reset e-mails (the templates link here with
 * `token_hash` and `type`, see docs/SETUP.md).
 *
 * A GET never verifies the token. E-mail security scanners (Safe Links and the like) open every link in
 * an e-mail within seconds; verifying here let them use up the one-time link before the person clicked
 * it (verified in beta 2026-10-05). The link only leads to /login/confirm, where the person continues
 * with a button – the token is verified by that POST (a server action).
 */
export async function GET(request: NextRequest) {
  const parsed = emailLinkSchema.safeParse({
    token_hash: request.nextUrl.searchParams.get("token_hash"),
    type: request.nextUrl.searchParams.get("type"),
  });
  if (!parsed.success) return NextResponse.redirect(new URL("/login?error=link", request.url));
  const to = new URL("/login/confirm", request.url);
  to.searchParams.set("token_hash", parsed.data.token_hash);
  to.searchParams.set("type", parsed.data.type);
  return NextResponse.redirect(to, { status: 303 });
}
