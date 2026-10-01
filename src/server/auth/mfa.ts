import "server-only";

import { toBase64SvgDataUrl } from "@/lib/auth/qr";
import { createSupabaseServerClient } from "@/server/supabase/server";

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Starts a fresh TOTP enrolment. Called from the setup page (server side).
 * Unverified leftovers from earlier attempts are removed first.
 */
export async function startTotpEnrollment(): Promise<TotpEnrollment | { alreadyEnrolled: true }> {
  const supabase = await createSupabaseServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (factors?.totp.some((f) => f.status === "verified")) return { alreadyEnrolled: true };

  for (const factor of factors?.all ?? []) {
    if (factor.factor_type === "totp" && factor.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Folke" });
  if (error || !data) throw new Error("Tvåstegsverifiering kunde inte startas");
  return { factorId: data.id, qrCode: toBase64SvgDataUrl(data.totp.qr_code), secret: data.totp.secret };
}
