"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function SubmitButton({ children, className }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className={cn("mt-1 h-10 w-full", className)}>
      {pending && <LoaderCircle className="animate-spin" />}
      {children}
    </Button>
  );
}

export function FormMessage({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm",
        error ? "bg-destructive/6 text-destructive" : "bg-success-subtle text-success",
      )}
    >
      {error ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
      {error ?? message}
    </p>
  );
}

export function Field({
  id,
  label,
  hint,
  ...input
}: React.ComponentProps<typeof Input> & { id: string; label: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="h-10" {...input} />
      {hint && <p className="text-caption">{hint}</p>}
    </div>
  );
}

/** Six-digit TOTP code input. */
export function CodeField() {
  return (
    <Field
      id="code"
      name="code"
      label="Verifieringskod"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      placeholder="123 456"
      required
      autoFocus
      className="h-11 text-center font-mono text-lg tracking-[0.3em]"
    />
  );
}
