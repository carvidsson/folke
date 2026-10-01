import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { SetPasswordForm } from "@/components/auth/mfa-forms";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Välj lösenord" };

export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login?error=link");

  return (
    <AuthShell title="Välj lösenord" description="Välj ett lösenord som du bara använder för Folke.">
      <SetPasswordForm />
    </AuthShell>
  );
}
