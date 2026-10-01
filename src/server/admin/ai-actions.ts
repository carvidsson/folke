"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { userMessageFor } from "@/server/ai/errors";
import { DataGuardError, externalProviderConfigured } from "@/server/ai/guard";
import { CHAT_MODELS, embeddingModel, isAllowedChatModel } from "@/server/ai/models";
import { listAvailableModels } from "@/server/ai/providers/openai";
import {
  indexSyntheticEmbeddings,
  loadSyntheticCorpus,
  removeSyntheticCorpus,
  setAITestAccess,
} from "@/server/ai/test-data";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import type { ActionResult } from "./actions";

/**
 * AI administration (system administrators only).
 *
 * Model choices are validated against the server's model catalog and
 * allowlist; the stored value is resolved again on every request. Test
 * tools (synthetic corpus, embeddings, test access) are only available when
 * OpenAI is configured, i.e. in the development environment – never in the
 * pilot, which runs in mock mode.
 */

const uuid = z.uuid();

async function requireSystemAdmin() {
  const session = await getSession();
  if (session.user.role !== "system_admin") {
    await logSecurityEvent("access.denied", { actorId: session.user.id, metadata: { area: "admin.ai" } });
    throw new Error("Behörighet saknas");
  }
  return session;
}

function refresh() {
  revalidatePath("/admin", "layout");
}

const TEST_TOOLS_DISABLED: ActionResult = {
  ok: false,
  error: "AI-testverktygen är bara tillgängliga när OpenAI är konfigurerat i utvecklingsmiljön.",
};

export async function setAssistantModelAction(assistantId: string, modelId: string): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!uuid.safeParse(assistantId).success || !isAllowedChatModel(modelId)) {
    return { ok: false, error: "Modellen finns inte bland de godkända modellerna." };
  }
  const { error, count } = await createSupabaseAdminClient()
    .from("assistants")
    .update({ ai_model: modelId }, { count: "exact" })
    .eq("id", assistantId);
  if (error || !count) {
    if (error) console.error("[admin/ai] model change failed", error.message);
    return { ok: false, error: "Modellen kunde inte sparas." };
  }
  await logSecurityEvent("ai.model_changed", {
    actorId: session.user.id,
    targetType: "assistants",
    targetId: assistantId,
    metadata: { model: modelId },
  });
  refresh();
  return { ok: true, message: "Modellen har sparats." };
}

export type ModelCheckResult =
  | { ok: true; checked: { id: string; available: boolean }[] }
  | { ok: false; error: string };

/** Checks which catalog models the configured OpenAI project can use (no tokens are consumed). */
export async function checkModelsAction(): Promise<ModelCheckResult> {
  await requireSystemAdmin();
  if (!externalProviderConfigured()) return { ok: false, error: "OpenAI är inte konfigurerat." };
  try {
    const available = new Set(await listAvailableModels());
    const ids = [...CHAT_MODELS.map((m) => m.id), embeddingModel().id];
    return { ok: true, checked: ids.map((id) => ({ id, available: available.has(id) })) };
  } catch (error) {
    return { ok: false, error: userMessageFor(error) };
  }
}

export async function loadSyntheticCorpusAction(): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!externalProviderConfigured()) return TEST_TOOLS_DISABLED;
  try {
    const created = await loadSyntheticCorpus(session.user.id);
    await logSecurityEvent("ai.synthetic_corpus_loaded", { actorId: session.user.id, metadata: { created } });
    refresh();
    return { ok: true, message: created ? `${created} syntetiska testdokument har lästs in.` : "Testdokumenten fanns redan." };
  } catch (error) {
    console.error("[admin/ai] corpus load failed", (error as Error).message);
    return { ok: false, error: "Testdokumenten kunde inte läsas in." };
  }
}

export async function indexSyntheticEmbeddingsAction(): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!externalProviderConfigured()) return TEST_TOOLS_DISABLED;
  try {
    const result = await indexSyntheticEmbeddings(session.user.id);
    await logSecurityEvent("ai.embeddings_indexed", {
      actorId: session.user.id,
      metadata: { chunks: result.chunks, tokens: result.tokens, model: embeddingModel().id },
    });
    refresh();
    return {
      ok: true,
      message: result.chunks
        ? `Embeddings skapades för ${result.chunks} textavsnitt (${result.tokens} tokens).`
        : "Alla syntetiska textavsnitt har redan embeddings.",
    };
  } catch (error) {
    if (error instanceof DataGuardError) {
      console.error("[admin/ai]", error.message);
      return { ok: false, error: "Spärren stoppade indexeringen: endast syntetiska dokument får indexeras." };
    }
    const message = (error as Error).message;
    console.error("[admin/ai] indexing failed", (error as Error).name);
    return { ok: false, error: /budget|minut|svar som genereras/.test(message) ? message : userMessageFor(error) };
  }
}

export async function removeSyntheticCorpusAction(): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!externalProviderConfigured()) return TEST_TOOLS_DISABLED;
  try {
    const removed = await removeSyntheticCorpus();
    await logSecurityEvent("ai.synthetic_corpus_removed", { actorId: session.user.id, metadata: { removed } });
    refresh();
    return { ok: true, message: `${removed} syntetiska testdokument har tagits bort.` };
  } catch (error) {
    console.error("[admin/ai] corpus removal failed", (error as Error).message);
    return { ok: false, error: "Testdokumenten kunde inte tas bort." };
  }
}

export async function setAITestAccessAction(userId: string, enabled: boolean): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!externalProviderConfigured()) return TEST_TOOLS_DISABLED;
  if (!uuid.safeParse(userId).success) return { ok: false, error: "Ogiltig användare." };
  try {
    await setAITestAccess(userId, enabled);
    await logSecurityEvent("ai.test_access_changed", {
      actorId: session.user.id,
      targetType: "profiles",
      targetId: userId,
      metadata: { enabled },
    });
    refresh();
    return { ok: true, message: enabled ? "AI-testbehörighet har getts." : "AI-testbehörigheten har tagits bort." };
  } catch (error) {
    console.error("[admin/ai] test access change failed", (error as Error).message);
    return { ok: false, error: "Behörigheten kunde inte ändras." };
  }
}
