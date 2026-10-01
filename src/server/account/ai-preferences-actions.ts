"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  ANSWER_LENGTHS,
  MAX_EXTRA_NOTES,
  MAX_WRITING_SAMPLE,
  WRITING_OPTIONS,
  WRITING_TONES,
  type AIPreferences,
} from "@/lib/domain/preferences";
import { ONBOARDING_LATER_COOKIE } from "@/lib/onboarding/constants";
import type { ActionResult } from "@/server/admin/actions";
import { runSideBySideTest, type SideBySideResult } from "@/server/ai/instruction-test";
import { personalInstructions, personalReminder } from "@/server/ai/preferences";
import { getSession } from "@/server/auth/session";
import { getInstructionsForAuthorizedChat, getMyAssistant } from "@/server/data/assistants";
import { getMyAIPreferences, getOrganizationInstructionsForChat } from "@/server/data/instructions";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * The current user's own AI preferences and onboarding (version 2).
 *
 * Every write uses the user's own client and the session's user id; the
 * client never sends a user id, and RLS (owner only) rejects anything else.
 * Preferences change form and tone only – never roles, groups, assistants,
 * documents or permissions.
 */

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v?.trim() ? v.trim() : null));

const preferencesSchema = z.object({
  answerLength: z.enum(ANSWER_LENGTHS).nullable(),
  writingTone: z.enum(WRITING_TONES).nullable(),
  writingOptions: z.array(z.enum(WRITING_OPTIONS)).max(WRITING_OPTIONS.length),
  extraNotes: optionalText(MAX_EXTRA_NOTES),
  writingSample: optionalText(MAX_WRITING_SAMPLE),
});
export type PreferencesInput = z.input<typeof preferencesSchema>;

function toRow(p: Partial<z.output<typeof preferencesSchema>>) {
  return {
    ...(p.answerLength !== undefined && { answer_length: p.answerLength }),
    ...(p.writingTone !== undefined && { writing_tone: p.writingTone }),
    ...(p.writingOptions !== undefined && { writing_options: [...new Set(p.writingOptions)] }),
    ...(p.extraNotes !== undefined && { extra_notes: p.extraNotes }),
    ...(p.writingSample !== undefined && { writing_sample: p.writingSample }),
  };
}

async function upsertOwn(userId: string, fields: Record<string, unknown>) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("user_ai_preferences").upsert({ user_id: userId, ...fields }, { onConflict: "user_id" });
  if (error) console.error("[account/ai-preferences] save failed", error.code);
  return !error;
}

function refresh() {
  revalidatePath("/", "layout");
}

/** Saves some or all preferences (onboarding steps save as they go). */
export async function saveMyAIPreferencesAction(input: Partial<PreferencesInput>): Promise<ActionResult> {
  const { user } = await getSession();
  const parsed = preferencesSchema.partial().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Kontrollera valen. Egna önskemål får vara högst 1 000 tecken och skrivexemplet 4 000." };
  if (!(await upsertOwn(user.id, toRow(parsed.data)))) return { ok: false, error: "Inställningarna kunde inte sparas." };
  refresh();
  return { ok: true, message: "Dina AI-inställningar har sparats." };
}

/** Back to Folke's defaults; the onboarding status is kept. */
export async function resetMyAIPreferencesAction(): Promise<ActionResult> {
  const { user } = await getSession();
  const ok = await upsertOwn(user.id, {
    answer_length: null,
    writing_tone: null,
    writing_options: [],
    extra_notes: null,
    writing_sample: null,
  });
  if (!ok) return { ok: false, error: "Inställningarna kunde inte återställas." };
  refresh();
  return { ok: true, message: "Standardinställningarna gäller nu." };
}

export async function setOnboardingStatusAction(status: "completed" | "skipped" | "not_started"): Promise<ActionResult> {
  const { user } = await getSession();
  if (!["completed", "skipped", "not_started"].includes(status)) return { ok: false, error: "Ogiltig status." };
  const ok = await upsertOwn(user.id, {
    onboarding_status: status,
    onboarding_completed_at: status === "completed" ? new Date().toISOString() : null,
  });
  if (!ok) return { ok: false, error: "Det gick inte att spara." };
  (await cookies()).delete(ONBOARDING_LATER_COOKIE);
  refresh();
  return { ok: true };
}

/** "Senare": no redirect for a few days; a reminder stays on the start page. */
export async function postponeOnboardingAction(): Promise<ActionResult> {
  await getSession();
  (await cookies()).set(ONBOARDING_LATER_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 3,
    path: "/",
  });
  return { ok: true };
}

const compareSchema = z.object({
  assistantId: z.uuid(),
  question: z.string().trim().min(3).max(2000),
  proposed: preferencesSchema,
});

export type PreferenceCompareResult = { ok: true; result: SideBySideResult } | { ok: false; error: string };

/**
 * Optional real AI test: the user's saved preferences (A) vs. the proposed
 * ones (B). Same assistant, question, model and retrieved documents, under
 * the user's own permissions and budget. No conversation is stored.
 */
export async function compareMyPreferencesAction(input: z.input<typeof compareSchema>): Promise<PreferenceCompareResult> {
  const { user } = await getSession();
  const parsed = compareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Skriv en fråga eller mejluppgift på 3–2 000 tecken." };
  const assistant = await getMyAssistant(parsed.data.assistantId);
  if (!assistant) return { ok: false, error: "Du har inte tillgång till den assistenten." };

  const [organization, instructions, saved] = await Promise.all([
    getOrganizationInstructionsForChat(),
    getInstructionsForAuthorizedChat(assistant.id),
    getMyAIPreferences(user.id),
  ]);
  const proposed: AIPreferences = { ...parsed.data.proposed, onboardingStatus: saved?.onboardingStatus ?? "not_started" };
  const base = { organization, assistant: instructions };
  return runSideBySideTest({
    userId: user.id,
    assistantId: assistant.id,
    question: parsed.data.question,
    a: { ...base, personal: personalInstructions(saved), personalReminder: personalReminder(saved) },
    b: { ...base, personal: personalInstructions(proposed), personalReminder: personalReminder(proposed) },
  });
}
