import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { MfaEnrollForm } from "@/components/auth/mfa-forms";
import { startTotpEnrollment } from "@/server/auth/mfa";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Aktivera tvåstegsverifiering" };

export default async function MfaSetupPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");

  const enrollment = await startTotpEnrollment();
  if ("alreadyEnrolled" in enrollment) redirect("/login/mfa");

  return (
    <AuthShell
      title="Aktivera tvåstegsverifiering"
      description="Tvåstegsverifiering är obligatorisk i Folke. Du gör det här en gång."
    >
      <MfaEnrollForm {...enrollment} />
    </AuthShell>
  );
}
