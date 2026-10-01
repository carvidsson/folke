"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { roleHas } from "@/lib/domain/roles";
import { runInstructionTest, type InstructionTestResult } from "@/server/ai/instruction-test";
import { examplePreferences, personalInstructions, personalReminder } from "@/server/ai/preferences";
import { buildSystemPrompt } from "@/server/ai/prompt";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { getInstructionsForAdmin } from "@/server/data/assistants";
import { getInstructionDraft, getOrganizationInstructions } from "@/server/data/instructions";
import { createSupabaseServerClient } from "@/server/supabase/server";

import type { ActionResult } from "./actions";

/**
 * Drafts and publishing of shared and assistant-specific AI instructions
 * (ADR-037, ADR-038). Drafts never reach users: chat reads only published
 * texts. Saving and publishing run in database functions with optimistic
 * locking (the caller's RLS applies), so two editors cannot silently
 * overwrite each other. Publishing records a version in the history.
 */

const uuid = z.uuid();
const target = z
  .object({ scope: z.enum(["organization", "assistant"]), assistantId: uuid.nullable() })
  .refine((t) => (t.scope === "assistant") === (t.assistantId !== null));
const examples = z.enum(["none", "short", "balanced", "detailed"]);

function refresh() {
  revalidatePath("/admin", "layout");
}

async function requireConfigurer() {
  const { user } = await getSession();
  if (!roleHas(user.role, "assistants.configure")) throw new Error("Behörighet saknas");
  return user;
}

/** Our own Swedish database messages are safe to show; everything else is generic. */
function dbError(error: { code?: string; message?: string } | null, fallback: string) {
  if (error?.code === "PT409" || error?.code === "42501" || error?.code === "23514") return error.message ?? fallback;
  if (error) console.error("[admin/instructions]", error.code);
  return fallback;
}

export type DraftSaveResult = { ok: true; message: string; updatedAt: string } | { ok: false; error: string };

export async function saveInstructionDraftAction(input: {
  scope: "organization" | "assistant";
  assistantId: string | null;
  content: string;
  /** updated_at of the draft the editor started from (null = no draft). */
  expectedUpdatedAt: string | null;
}): Promise<DraftSaveResult> {
  await requireConfigurer();
  const t = target.safeParse(input);
  const content = z.string().max(8000).safeParse(input.content);
  if (!t.success || !content.success) return { ok: false, error: "Ogiltigt utkast (högst 8 000 tecken)." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_instruction_draft", {
    p_scope: t.data.scope,
    p_assistant_id: t.data.assistantId,
    p_content: content.data,
    p_expected_updated_at: input.expectedUpdatedAt,
  });
  if (error || !data) return { ok: false, error: dbError(error, "Utkastet kunde inte sparas.") };
  return { ok: true, message: "Utkastet har sparats. Det gäller inte för användarna förrän det publiceras.", updatedAt: data as string };
}

export async function publishInstructionDraftAction(input: {
  scope: "organization" | "assistant";
  assistantId: string | null;
  expectedUpdatedAt: string;
}): Promise<ActionResult> {
  const user = await requireConfigurer();
  const t = target.safeParse(input);
  if (!t.success || !input.expectedUpdatedAt) return { ok: false, error: "Ogiltig förfrågan." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("publish_instruction_draft", {
    p_scope: t.data.scope,
    p_assistant_id: t.data.assistantId,
    p_expected_updated_at: input.expectedUpdatedAt,
  });
  if (error) return { ok: false, error: dbError(error, "Instruktionerna kunde inte publiceras.") };
  await logSecurityEvent("ai.instructions_changed", {
    actorId: user.id,
    targetType: t.data.scope === "organization" ? "organization_instructions" : "assistants",
    targetId: t.data.assistantId,
  });
  refresh();
  return { ok: true, message: "Instruktionerna är publicerade och gäller för nya svar." };
}

export async function discardInstructionDraftAction(input: {
  scope: "organization" | "assistant";
  assistantId: string | null;
  expectedUpdatedAt: string;
}): Promise<ActionResult> {
  await requireConfigurer();
  const t = target.safeParse(input);
  if (!t.success) return { ok: false, error: "Ogiltig förfrågan." };
  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("instruction_drafts")
    .delete({ count: "exact" })
    .eq("target", t.data.assistantId ?? "organization")
    .eq("updated_at", input.expectedUpdatedAt);
  if (error) return { ok: false, error: dbError(error, "Utkastet kunde inte kastas.") };
  if (!count) return { ok: false, error: "Utkastet har ändrats av någon annan. Ladda om sidan." };
  refresh();
  return { ok: true, message: "Utkastet är kastat." };
}

/** Published and draft layers for an assistant, as the caller may read them. */
async function layersFor(assistantId: string) {
  const [organization, organizationDraft, assistant, assistantDraft] = await Promise.all([
    getOrganizationInstructions(),
    getInstructionDraft("organization"),
    getInstructionsForAdmin(assistantId),
    getInstructionDraft("assistant", assistantId),
  ]);
  if (assistant === null) return null;
  const published = { organization: organization?.content ?? "", assistant };
  return {
    published,
    draft: {
      organization: organizationDraft?.content ?? published.organization,
      assistant: assistantDraft?.content ?? assistant,
    },
    hasDraft: Boolean(organizationDraft || assistantDraft),
  };
}

const previewSchema = z.object({
  assistantId: uuid,
  version: z.enum(["published", "draft"]).default("published"),
  /** Fixed example preferences – never a real user's settings. */
  examplePreferences: examples.default("none"),
});

export type PromptPreviewResult = { ok: true; prompt: string; hasDraft: boolean } | { ok: false; error: string };

export async function previewPromptAction(input: z.input<typeof previewSchema>): Promise<PromptPreviewResult> {
  await requireConfigurer();
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Ogiltig förfrågan." };
  const layers = await layersFor(parsed.data.assistantId);
  if (!layers) return { ok: false, error: "Du ansvarar inte för den här assistenten." };
  const base = parsed.data.version === "draft" ? layers.draft : layers.published;
  const prefs = examplePreferences(parsed.data.examplePreferences);
  return {
    ok: true,
    prompt: buildSystemPrompt({ ...base, personal: personalInstructions(prefs), personalReminder: personalReminder(prefs) }, []),
    hasDraft: layers.hasDraft,
  };
}

const compareSchema = z.object({
  assistantId: uuid,
  question: z.string().trim().min(3).max(2000),
  examplePreferences: examples.default("none"),
});

export type CompareResult = { ok: true; result: InstructionTestResult } | { ok: false; error: string };

/** Two real OpenAI answers: published vs. draft instructions (same question, model and documents). */
export async function compareInstructionsAction(input: z.input<typeof compareSchema>): Promise<CompareResult> {
  const user = await requireConfigurer();
  const parsed = compareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Skriv en fråga på 3–2 000 tecken." };
  const layers = await layersFor(parsed.data.assistantId);
  if (!layers) return { ok: false, error: "Du ansvarar inte för den här assistenten." };
  if (!layers.hasDraft) return { ok: false, error: "Det finns inget utkast att jämföra med. Spara ett utkast först." };
  return runInstructionTest({
    userId: user.id,
    assistantId: parsed.data.assistantId,
    question: parsed.data.question,
    published: layers.published,
    draft: layers.draft,
    preferences: parsed.data.examplePreferences,
  });
}
