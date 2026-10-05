"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { emailLinkSchema } from "@/lib/auth/email-link";
import { passwordProblems } from "@/lib/auth/password-policy";
import { logSecurityEvent } from "@/server/audit";
import { ACTIVATION_REDIRECTS, activateCurrentUserIfInvited } from "@/server/auth/activation";
import { serverEnv } from "@/server/env";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Authentication actions. All credential handling is delegated to Supabase
 * Auth; nothing here stores or compares passwords or TOTP secrets.
 */

export interface FormState {
  error?: string;
  message?: string;
  /** Echoed back so the field survives React's form reset after an action. */
  email?: string;
}

const codeSchema = z.string().regex(/^\d{6}$/, "Ange den sexsiffriga koden.");

async function verifiedTotpFactorId() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  return data?.totp.find((f) => f.status === "verified")?.id ?? null;
}

// ---------------------------------------------------------------------------
// Step 1: e-mail and password
// ---------------------------------------------------------------------------

export async function signInAction(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ email: z.email(), password: z.string().min(1).max(200) })
    .safeParse({ email: formData.get("email"), password: formData.get("password") });
  const typedEmail = String(formData.get("email") ?? "").slice(0, 254);
  if (!parsed.success) return { error: "Ange e-postadress och lösenord.", email: typedEmail };

  const email = parsed.data.email.toLowerCase();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: parsed.data.password });

  if (error || !data.user) {
    await logSecurityEvent("auth.sign_in_failed", { metadata: { email, reason: error?.code ?? "unknown" } });
    return { error: "Fel e-postadress eller lösenord.", email: typedEmail };
  }

  const { data: profile } = await supabase.from("profiles").select("status").eq("id", data.user.id).maybeSingle();
  if (profile?.status === "disabled") {
    await supabase.auth.signOut();
    await logSecurityEvent("auth.sign_in_failed", { actorId: data.user.id, metadata: { reason: "disabled" } });
    return { error: "Kontot är inaktiverat. Kontakta en systemadministratör.", email: typedEmail };
  }

  await logSecurityEvent("auth.sign_in", { actorId: data.user.id, metadata: { step: "password" } });
  redirect((await verifiedTotpFactorId()) ? "/login/mfa" : "/login/mfa/setup");
}

// ---------------------------------------------------------------------------
// Step 2: TOTP challenge
// ---------------------------------------------------------------------------

export async function verifyMfaAction(_: FormState, formData: FormData): Promise<FormState> {
  const code = codeSchema.safeParse(String(formData.get("code") ?? "").replace(/\s/g, ""));
  if (!code.success) return { error: code.error.issues[0].message };

  const supabase = await createSupabaseServerClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect("/login");

  const factorId = await verifiedTotpFactorId();
  if (!factorId) redirect("/login/mfa/setup");

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.data });
  if (error) {
    await logSecurityEvent("auth.mfa_failed", { actorId: user.user.id, metadata: { reason: error.code } });
    return { error: "Koden stämmer inte. Kontrollera tiden i din app och försök igen." };
  }

  await logSecurityEvent("auth.mfa_verified", { actorId: user.user.id });
  redirect(ACTIVATION_REDIRECTS[await activateCurrentUserIfInvited(user.user.id)]);
}

// ---------------------------------------------------------------------------
// TOTP enrolment (first sign-in)
// ---------------------------------------------------------------------------

export async function confirmTotpEnrollmentAction(_: FormState, formData: FormData): Promise<FormState> {
  const code = codeSchema.safeParse(String(formData.get("code") ?? "").replace(/\s/g, ""));
  const factorId = z.string().uuid().safeParse(formData.get("factorId"));
  if (!code.success) return { error: code.error.issues[0].message };
  if (!factorId.success) return { error: "Ogiltig förfrågan. Ladda om sidan." };

  const supabase = await createSupabaseServerClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect("/login");

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factorId.data, code: code.data });
  if (error) {
    await logSecurityEvent("auth.mfa_failed", { actorId: user.user.id, metadata: { step: "enroll" } });
    return { error: "Koden stämmer inte. Kontrollera att du skannat den senaste QR-koden." };
  }

  await createSupabaseAdminClient()
    .from("profiles")
    .update({ mfa_enrolled_at: new Date().toISOString() })
    .eq("id", user.user.id)
    .is("mfa_enrolled_at", null);
  await logSecurityEvent("auth.mfa_enrolled", { actorId: user.user.id });
  redirect(ACTIVATION_REDIRECTS[await activateCurrentUserIfInvited(user.user.id)]);
}

// ---------------------------------------------------------------------------
// Password (after invitation or reset link)
// ---------------------------------------------------------------------------

export async function setPasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const problems = passwordProblems(password);
  if (problems.length) return { error: `Lösenordet måste ${problems.join(", ")}.` };
  if (password !== confirm) return { error: "Lösenorden matchar inte." };

  const supabase = await createSupabaseServerClient();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect("/login?error=link");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return {
      error:
        error.code === "weak_password"
          ? "Lösenordet är för svagt eller har förekommit i dataläckor. Välj ett annat."
          : error.code === "same_password"
            ? "Välj ett annat lösenord än det nuvarande."
            : "Lösenordet kunde inte sparas. Begär en ny länk och försök igen.",
    };
  }

  await logSecurityEvent("auth.password_set", { actorId: user.user.id });
  redirect((await verifiedTotpFactorId()) ? "/login/mfa" : "/login/mfa/setup");
}

export async function requestPasswordResetAction(_: FormState, formData: FormData): Promise<FormState> {
  const email = z.email().safeParse(formData.get("email"));
  if (!email.success) return { error: "Ange en giltig e-postadress.", email: String(formData.get("email") ?? "").slice(0, 254) };

  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(email.data.toLowerCase(), {
    redirectTo: `${serverEnv().NEXT_PUBLIC_SITE_URL}/auth/confirm`,
  });
  await logSecurityEvent("auth.password_reset_requested", { metadata: { email: email.data.toLowerCase() } });

  // Same answer whether or not the address exists.
  return { message: "Om adressen finns i Folke har vi skickat en länk för att välja nytt lösenord." };
}

// ---------------------------------------------------------------------------
// Invitation and password-reset links
// ---------------------------------------------------------------------------

/**
 * Verifies the one-time link from an invitation or a password reset – only when the person clicks
 * "Fortsätt" on /login/confirm (a POST with the server action's origin check). Opening the link (a GET,
 * as e-mail scanners do) never uses it up. A used or expired link is refused by Supabase Auth.
 */
export async function confirmEmailLinkAction(formData: FormData): Promise<void> {
  const parsed = emailLinkSchema.safeParse({ token_hash: formData.get("token_hash"), type: formData.get("type") });
  if (!parsed.success) redirect("/login?error=link");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ type: parsed.data.type, token_hash: parsed.data.token_hash });
  if (error) redirect("/login?error=link");
  redirect("/login/set-password");
}
