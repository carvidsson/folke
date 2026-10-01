import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { MfaChallengeForm } from "@/components/auth/mfa-forms";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Tvåstegsverifiering" };

export default async function MfaPage() {
  const supabase = await createSupabaseServerClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login");
  if (claims.claims.aal === "aal2") redirect("/auth/activate");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (!factors?.totp.some((f) => f.status === "verified")) redirect("/login/mfa/setup");

  return (
    <AuthShell
      title="Tvåstegsverifiering"
      description="Ange den sexsiffriga koden från din autentiseringsapp."
    >
      <MfaChallengeForm />
    </AuthShell>
  );
}
