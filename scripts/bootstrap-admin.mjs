#!/usr/bin/env node
/**
 * Creates (or completes) the FIRST system administrator. Afterwards, all
 * users are invited from Administration → Användare.
 *
 *   npm run bootstrap:admin -- fornamn.efternamn@exempel.se "Förnamn Efternamn"
 *   npm run bootstrap:admin -- fornamn.efternamn@exempel.se "Förnamn Efternamn" --resend
 *
 * Idempotent:
 *   - New address        → sends an invitation and sets the role.
 *   - Existing user      → sets the role only; no new invitation, no duplicate.
 *   - --resend           → also re-sends the invitation if the user has not yet
 *                          accepted it (otherwise use "Glömt lösenordet?").
 * Refuses to run if ANOTHER active system administrator exists.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SITE_URL
 * from .env.local. Never prints keys.
 */
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const resend = args.includes("--resend");
const [rawEmail, fullName] = args.filter((a) => !a.startsWith("--"));
if (!rawEmail || !fullName) {
  console.error('Användning: npm run bootstrap:admin -- <e-post> "<namn>" [--resend]');
  process.exit(1);
}
const email = rawEmail.trim().toLowerCase();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
if (!url || !secret) {
  console.error("Saknar NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SECRET_KEY i .env.local");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

function fail(message, error) {
  console.error(message, error?.message ? `(${error.message})` : "");
  process.exit(1);
}

// 1. Is there already another active system administrator?
const { data: activeAdmins, error: adminError } = await admin
  .from("profiles")
  .select("id, email")
  .eq("role", "system_admin")
  .eq("status", "active");
if (adminError) fail("Kunde inte läsa profiler.", adminError);
if (activeAdmins.some((a) => a.email.toLowerCase() === email)) {
  console.log("Användaren är redan aktiv systemadministratör. Inget att göra.");
  process.exit(0);
}
if (activeAdmins.length > 0) {
  fail("Det finns redan en aktiv systemadministratör. Bjud in fler användare i Folke.");
}

// 2. Existing user?
const { data: existing, error: lookupError } = await admin
  .from("profiles")
  .select("id, status, full_name")
  .eq("email", email)
  .maybeSingle();
if (lookupError) fail("Kunde inte söka efter användaren.", lookupError);

let userId = existing?.id;
let invited = false;

if (!existing) {
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${site}/auth/confirm`,
  });
  if (error) fail("Inbjudan misslyckades.", error);
  userId = data.user.id;
  invited = true;
} else if (resend && existing.status === "invited") {
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${site}/auth/confirm` });
  if (error) {
    console.warn(
      "Ny inbjudan kunde inte skickas (troligen har inbjudan redan accepterats). Använd \"Glömt lösenordet?\" på inloggningssidan i stället.",
    );
  } else {
    invited = true;
  }
}

// 3. Role (service role bypasses the profile-column trigger by design).
const { error: roleError } = await admin
  .from("profiles")
  .update({ role: "system_admin", full_name: existing?.full_name || fullName })
  .eq("id", userId);
if (roleError) fail("Rollen kunde inte sättas.", roleError);

await admin.from("audit_log").insert({
  action: "admin.user_invited",
  target_type: "profiles",
  target_id: userId,
  metadata: { role: "system_admin", bootstrap: true, invitationSent: invited },
});

if (invited) {
  console.log("Klart. Inbjudan har skickats. Följ länken för att välja lösenord och aktivera tvåstegsverifiering.");
} else {
  console.log(
    `Klart. Användaren har rollen systemadministratör (status: ${existing.status}). Ingen ny inbjudan skickades.\n` +
      "Logga in på /login. Kontot aktiveras när tvåstegsverifieringen är klar.",
  );
}
