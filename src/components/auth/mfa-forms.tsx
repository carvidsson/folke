"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import {
  confirmTotpEnrollmentAction,
  requestPasswordResetAction,
  setPasswordAction,
  verifyMfaAction,
  type FormState,
} from "@/server/auth/actions";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password-policy";

import { CodeField, Field, FormMessage, SubmitButton } from "./form-parts";

export function MfaChallengeForm() {
  const [state, action] = useActionState<FormState, FormData>(verifyMfaAction, {});
  return (
    <form action={action} className="mt-8 flex flex-col gap-5">
      <FormMessage error={state.error} />
      <CodeField />
      <SubmitButton>Verifiera</SubmitButton>
      <SignOutLink />
    </form>
  );
}

export function MfaEnrollForm({ factorId, qrCode, secret }: { factorId: string; qrCode: string; secret: string }) {
  const [state, action] = useActionState<FormState, FormData>(confirmTotpEnrollmentAction, {});
  const [showSecret, setShowSecret] = useState(false);

  return (
    <form action={action} className="mt-8 flex flex-col gap-5">
      <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li>1. Öppna en autentiseringsapp, till exempel Microsoft Authenticator eller Google Authenticator.</li>
        <li>2. Skanna QR-koden.</li>
        <li>3. Ange den sexsiffriga koden som visas i appen.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-background p-5">
        {/* Plain <img>: next/image does not support SVG data URLs. The URL is a
            server-normalised base64 SVG; scripts never run in <img>. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrCode}
          alt="QR-kod för tvåstegsverifiering"
          width={176}
          height={176}
          className="size-44 bg-white [image-rendering:pixelated]"
        />
        {showSecret ? (
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all select-all">{secret}</code>
        ) : (
          <button
            type="button"
            onClick={() => setShowSecret(true)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Kan du inte skanna? Visa koden för manuell inmatning
          </button>
        )}
      </div>
      <input type="hidden" name="factorId" value={factorId} />
      <FormMessage error={state.error} />
      <CodeField />
      <SubmitButton>Aktivera tvåstegsverifiering</SubmitButton>
      <SignOutLink />
    </form>
  );
}

export function SetPasswordForm() {
  const [state, action] = useActionState<FormState, FormData>(setPasswordAction, {});
  return (
    <form action={action} className="mt-8 flex flex-col gap-5">
      <FormMessage error={state.error} />
      <Field
        id="password"
        name="password"
        type="password"
        label="Nytt lösenord"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        required
        autoFocus
        hint={`Minst ${PASSWORD_MIN_LENGTH} tecken med stor och liten bokstav samt siffra.`}
      />
      <Field id="confirm" name="confirm" type="password" label="Upprepa lösenordet" autoComplete="new-password" required />
      <SubmitButton>Spara lösenord</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState<FormState, FormData>(requestPasswordResetAction, {});
  return (
    <form action={action} className="mt-8 flex flex-col gap-5">
      <FormMessage error={state.error} message={state.message} />
      <Field
        id="email"
        name="email"
        type="email"
        label="E-postadress"
        autoComplete="username"
        required
        autoFocus
        defaultValue={state.email}
        key={state.email ?? "email"}
      />
      <SubmitButton>Skicka länk</SubmitButton>
      <Link href="/login" className="text-center text-xs font-medium text-muted-foreground hover:text-foreground">
        Tillbaka till inloggningen
      </Link>
    </form>
  );
}

function SignOutLink() {
  return (
    <button
      type="submit"
      formAction="/auth/signout"
      formMethod="post"
      formNoValidate
      className="text-center text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      Avbryt och logga ut
    </button>
  );
}
