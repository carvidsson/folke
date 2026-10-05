import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { SubmitButton } from "@/components/auth/form-parts";
import { emailLinkSchema } from "@/lib/auth/email-link";
import { confirmEmailLinkAction } from "@/server/auth/actions";

export const metadata: Metadata = { title: "Fortsätt" };

/**
 * The step between an e-mail link and choosing a password. Opening this page changes nothing: the
 * one-time link is used only when the person clicks the button (see /auth/confirm).
 */
export default async function ConfirmLinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const parsed = emailLinkSchema.safeParse({ token_hash: params.token_hash, type: params.type });
  if (!parsed.success) redirect("/login?error=link");
  const invite = parsed.data.type === "invite";

  return (
    <AuthShell
      title={invite ? "Välkommen till Folke" : "Välj ett nytt lösenord"}
      description={
        invite
          ? "Klicka på knappen för att fortsätta. Därefter väljer du lösenord och aktiverar tvåstegsverifiering."
          : "Klicka på knappen för att fortsätta och välja ett nytt lösenord."
      }
    >
      <form action={confirmEmailLinkAction} className="mt-8 flex flex-col gap-5">
        <input type="hidden" name="token_hash" value={parsed.data.token_hash} />
        <input type="hidden" name="type" value={parsed.data.type} />
        <SubmitButton>Fortsätt</SubmitButton>
        <p className="text-caption">Länken är personlig och kan bara användas en gång.</p>
      </form>
    </AuthShell>
  );
}
