import "server-only";

import type { SourceReference } from "@/lib/domain/types";
import { retrieveContext } from "@/server/chat/retrieval";
import { citedSources } from "@/server/chat/turn";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { verifyCitations } from "./citations";
import { embedQuery } from "./embeddings";
import { userMessageFor } from "./errors";
import { approvedDocumentsEnabled, assertExternalAllowed } from "./guard";
import { beginAIRequest, finishAIRequest } from "./limits";
import { resolveChatModel } from "./models";
import { examplePreferences, personalInstructions, personalReminder, type ExamplePreferences } from "./preferences";
import { buildSystemPrompt, type InstructionLayers } from "./prompt";
import { openAIProvider } from "./providers/openai";
import type { ContextChunk, UsageReport } from "./types";
import { chatCostUsd } from "./pricing";
import { recordChatUsage } from "./usage";

/**
 * Side-by-side test of published vs. draft instructions with real OpenAI
 * (ADR-038). Callers MUST have checked that the user may configure the
 * assistant.
 *
 * Fairness: one retrieval, as the testing user (RLS: their groups, the
 * assistant, review, validity, and only documents approved for OpenAI),
 * shared by both answers; same model and question. The only intended
 * difference is the instructions – model output still varies between calls.
 *
 * Isolation: no conversation or message is stored. Usage counts against the
 * user's budget and limits like any AI call and is tagged instruction_test.
 * Personal preferences are fixed examples, never a real user's settings.
 */

export interface TestAnswer {
  answer: string;
  sources: SourceReference[];
  removedCitations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface InstructionTestResult {
  model: string;
  /** All excerpts both answers received (identical for both). */
  basis: SourceReference[];
  usedVectorSearch: boolean;
  published: TestAnswer;
  draft: TestAnswer;
}

async function answer(
  userId: string,
  assistantId: string,
  model: string,
  layers: InstructionLayers,
  context: ContextChunk[],
  sources: SourceReference[],
  question: string,
  requestId: string,
): Promise<TestAnswer> {
  let text = "";
  let usage: UsageReport | null = null;
  let error: string | undefined;
  try {
    for await (const event of openAIProvider.streamChat({
      system: buildSystemPrompt(layers, context),
      messages: [{ role: "user", content: question }],
      context,
      model,
      onUsage: (u) => (usage = u),
    })) {
      text += event.delta;
    }
  } catch (e) {
    error = userMessageFor(e);
  }
  const report = usage as UsageReport | null;
  if (report) {
    await recordChatUsage({
      userId,
      assistantId,
      conversationId: null,
      provider: openAIProvider.id,
      dataClass: "internal",
      usage: report,
      purpose: "instruction_test",
    });
  }
  await finishAIRequest(requestId, error ? "failed" : "completed");
  const verified = verifyCitations(text, context.length);
  return {
    answer: verified.content,
    sources: citedSources(sources, verified.cited),
    removedCitations: verified.removed,
    inputTokens: report?.inputTokens ?? 0,
    outputTokens: report?.outputTokens ?? 0,
    costUsd: report ? chatCostUsd(report.model, report) : 0,
    error,
  };
}

export interface SideBySideResult {
  model: string;
  basis: SourceReference[];
  usedVectorSearch: boolean;
  a: TestAnswer;
  b: TestAnswer;
}

/** Administrators: published vs. draft instructions, with fixed example preferences. */
export async function runInstructionTest(input: {
  userId: string;
  assistantId: string;
  question: string;
  published: Omit<InstructionLayers, "personal">;
  draft: Omit<InstructionLayers, "personal">;
  preferences: ExamplePreferences;
}): Promise<{ ok: true; result: InstructionTestResult } | { ok: false; error: string }> {
  const prefs = examplePreferences(input.preferences);
  const personal = { personal: personalInstructions(prefs), personalReminder: personalReminder(prefs) };
  const r = await runSideBySideTest({
    userId: input.userId,
    assistantId: input.assistantId,
    question: input.question,
    a: { ...input.published, ...personal },
    b: { ...input.draft, ...personal },
  });
  if (!r.ok) return r;
  const { a, b, ...rest } = r.result;
  return { ok: true, result: { ...rest, published: a, draft: b } };
}

/**
 * Two real answers to the same question with two sets of instruction layers
 * (A and B): same model, one shared retrieval under the user's RLS (approved
 * documents only), same limits and budget. No conversation is stored.
 */
export async function runSideBySideTest(input: {
  userId: string;
  assistantId: string;
  question: string;
  a: InstructionLayers;
  b: InstructionLayers;
}): Promise<{ ok: true; result: SideBySideResult } | { ok: false; error: string }> {
  if (!approvedDocumentsEnabled()) {
    return { ok: false, error: "OpenAI är inte aktiverat för godkända dokument i den här miljön." };
  }
  const supabase = await createSupabaseServerClient();
  const { data: assistantRow } = await supabase
    .from("assistants")
    .select("ai_model")
    .eq("id", input.assistantId)
    .maybeSingle<{ ai_model: string | null }>();
  const model = resolveChatModel(assistantRow?.ai_model).id;

  // Both requests are registered before any call, so a limit stops the test
  // before tokens are spent.
  const first = await beginAIRequest(input.userId, "chat");
  if (!first.ok) return { ok: false, error: first.message };
  const second = await beginAIRequest(input.userId, "chat");
  if (!second.ok) {
    await finishAIRequest(first.requestId, "aborted");
    return { ok: false, error: second.message };
  }

  // One retrieval for both answers, under the user's own RLS (same as chat).
  const { context, sources, stats } = await retrieveContext(supabase, {
    assistantId: input.assistantId,
    message: input.question,
    history: [],
    dataClass: "approved",
    embed: (text) =>
      embedQuery(text, {
        userId: input.userId,
        assistantId: input.assistantId,
        conversationId: null,
        dataClass: "internal",
        purpose: "instruction_test",
      }),
  });

  try {
    assertExternalAllowed({ external: true, conversationClass: "internal", userHasTestAccess: false, context });
  } catch {
    await finishAIRequest(first.requestId, "failed");
    await finishAIRequest(second.requestId, "failed");
    return { ok: false, error: "Spärren stoppade testet." };
  }

  const [a, b] = await Promise.all([
    answer(input.userId, input.assistantId, model, input.a, context, sources, input.question, first.requestId),
    answer(input.userId, input.assistantId, model, input.b, context, sources, input.question, second.requestId),
  ]);
  return { ok: true, result: { model, basis: sources, usedVectorSearch: stats.usedVectorSearch, a, b } };
}
