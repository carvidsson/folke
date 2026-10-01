import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Session cookie hardening.
 *
 * - httpOnly: Folke never uses Supabase Auth in the browser (all auth runs in
 *   server actions/route handlers), so JavaScript does not need the tokens.
 *   This removes token theft via XSS.
 * - secure: only sent over HTTPS when the site runs on HTTPS.
 * - maxAge 7 days: matches the maximum session length (the real limit is
 *   enforced by getSession() and RLS).
 */
export function sessionCookieOptions(): CookieOptionsWithName {
  const https = (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: https,
    maxAge: 7 * 24 * 60 * 60,
  };
}
