"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/server/admin/actions";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { serverEnv } from "@/server/env";
import { createSupabaseServerClient } from "@/server/supabase/server";

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  title: z.string().trim().max(120),
  department: z.string().trim().max(120),
  location: z.string().trim().max(120),
});

/** Updates the caller's own profile details (RLS: own row only). */
export async function updateProfileAction(input: z.input<typeof profileSchema>): Promise<ActionResult> {
  const { user } = await getSession();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Ange ett namn på minst två tecken." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.fullName,
      title: parsed.data.title,
      department: parsed.data.department,
      location: parsed.data.location,
    })
    .eq("id", user.id);
  if (error) return { ok: false, error: "Profilen kunde inte sparas." };
  revalidatePath("/", "layout");
  return { ok: true, message: "Profilen har sparats." };
}

/** Sends a password-change link to the signed-in user's own address. */
export async function sendPasswordChangeLinkAction(): Promise<ActionResult> {
  const { user } = await getSession();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
    redirectTo: `${serverEnv().NEXT_PUBLIC_SITE_URL}/auth/confirm`,
  });
  if (error) return { ok: false, error: "Länken kunde inte skickas. Försök igen om en stund." };
  await logSecurityEvent("auth.password_reset_requested", { actorId: user.id, metadata: { self: true } });
  return { ok: true, message: `En länk för att byta lösenord har skickats till ${user.email}.` };
}
