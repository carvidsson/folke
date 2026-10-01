import { NextResponse, type NextRequest } from "next/server";

import { logSecurityEvent } from "@/server/audit";
import { createSupabaseServerClient } from "@/server/supabase/server";

const REASONS = new Set(["expired", "disabled"]);

async function signOut(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const reason = request.nextUrl.searchParams.get("reason");
  const known = reason && REASONS.has(reason) ? reason : null;

  if (data?.claims?.sub) {
    await logSecurityEvent(known === "expired" ? "auth.session_expired" : "auth.sign_out", {
      actorId: data.claims.sub,
      metadata: known ? { reason: known } : {},
    });
  }
  // "global" ends the user's sessions on all devices (from settings).
  const scope = request.nextUrl.searchParams.get("scope") === "global" ? "global" : "local";
  await supabase.auth.signOut({ scope });

  const target = new URL("/login", request.url);
  if (known) target.searchParams.set("reason", known);
  return NextResponse.redirect(target, { status: 303 });
}

export const POST = signOut;
// GET is used for server-side redirects (expired/disabled sessions).
export const GET = signOut;
