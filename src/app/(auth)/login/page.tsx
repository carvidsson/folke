import type { Metadata } from "next";

import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Logga in" };

const NOTICES: Record<string, string> = {
  expired: "Din session har gått ut efter 7 dagar. Logga in igen.",
  disabled: "Kontot är inaktiverat. Kontakta en systemadministratör.",
  link: "Länken är ogiltig eller har gått ut. Be om en ny inbjudan eller återställ lösenordet.",
  activation: "Kontot kunde inte aktiveras. Kontakta en systemadministratör.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { reason, error } = await searchParams;
  const key = typeof error === "string" ? error : typeof reason === "string" ? reason : null;

  return (
    <AuthShell title="Logga in" description="Använd ditt arbetskonto för att komma åt dina assistenter.">
      <LoginForm notice={key ? NOTICES[key] : undefined} />
    </AuthShell>
  );
}
