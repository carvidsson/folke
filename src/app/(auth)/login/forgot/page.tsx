import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/mfa-forms";

export const metadata: Metadata = { title: "Glömt lösenord" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Glömt lösenordet?"
      description="Ange din e-postadress så skickar vi en länk för att välja ett nytt lösenord. Tvåstegsverifieringen påverkas inte."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
