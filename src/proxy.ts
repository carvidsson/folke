import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * Runs before every matched request:
 *   1. Sets a nonce-based Content Security Policy (scripts only with nonce).
 *   2. Refreshes the Supabase session cookies (tokens are short-lived).
 *   3. Optimistic redirects: no session -> /login, password-only (aal1)
 *      session -> MFA step.
 *
 * This is NOT the authorisation boundary. Pages and route handlers verify the
 * session with getSession()/getApiSession(), and the database enforces RLS
 * (aal2, enrolled TOTP, active profile, 7-day limit) on every query.
 */

const PUBLIC_PREFIXES = ["/login", "/auth"];

function contentSecurityPolicy(nonce: string) {
  const isDev = process.env.NODE_ENV === "development";
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const https = (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are used by UI primitives; scripts stay strict.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // Browser uploads go directly to Supabase Storage via one-time URLs.
    `connect-src 'self' ${supabase}${isDev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);

  // Downstream rendering reads the nonce from the request headers.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Not configured yet: let the page render its configuration error.
  if (!url || !key) return forward();

  let response = forward();

  const supabase = createServerClient(url, key, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  const redirectTo = (target: string) => {
    const redirect = NextResponse.redirect(new URL(target, request.url));
    // Keep refreshed cookies on the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!isPublic) {
    if (!claims) {
      if (path.startsWith("/api/")) {
        return NextResponse.json({ error: "Inte inloggad" }, { status: 401 });
      }
      return redirectTo("/login");
    }
    if (claims.aal !== "aal2") {
      if (path.startsWith("/api/")) {
        return NextResponse.json({ error: "Tvåstegsverifiering krävs" }, { status: 401 });
      }
      return redirectTo("/login/mfa");
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|brand/|icon.svg|favicon.ico).*)",
  ],
};
