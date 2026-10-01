"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import { signInAction, type FormState } from "@/server/auth/actions";

import { Field, FormMessage, SubmitButton } from "./form-parts";

/** Step 1: e-mail and password. Credentials go straight to Supabase Auth. */
export function LoginForm({ notice }: { notice?: string }) {
  const [state, action] = useActionState<FormState, FormData>(signInAction, {});

  return (
    <form action={action} className="mt-8 flex flex-col gap-5">
      <FormMessage error={state.error ?? notice} />
      <Field
        id="email"
        name="email"
        type="email"
        label="E-postadress"
        autoComplete="username"
        required
        autoFocus={!state.email}
        defaultValue={state.email}
        key={state.email ?? "email"}
      />
      <div className="flex flex-col gap-2">
        <Field
          id="password"
          name="password"
          type="password"
          label="Lösenord"
          autoComplete="current-password"
          required
          autoFocus={Boolean(state.email)}
        />
        <Link href="/login/forgot" className="self-end text-xs font-medium text-muted-foreground hover:text-foreground">
          Glömt lösenordet?
        </Link>
      </div>
      <SubmitButton>
        Logga in
        <ArrowRight data-icon="inline-end" />
      </SubmitButton>
      <p className="text-caption text-center">
        Inloggningen kräver tvåstegsverifiering med en autentiseringsapp.
      </p>
    </form>
  );
}
