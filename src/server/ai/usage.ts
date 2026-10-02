import "server-only";

import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { chatCostUsd, embeddingCostUsd, usdToSek } from "./pricing";
import type { UsageReport } from "./types";

/** What a call was for (ai_usage.purpose). */
export type UsagePurpose = "conversation" | "indexing" | "instruction_test" | "attachment_indexing";

/**
 * Records token usage and estimated cost (service role, after the caller's
 * authorisation checks). Never records content.
 */
export async function recordChatUsage(input: {
  userId: string;
  assistantId: string;
  /** null for instruction tests (no conversation is stored). */
  conversationId: string | null;
  provider: string;
  dataClass: "internal" | "synthetic";
  usage: UsageReport;
  purpose?: UsagePurpose;
}) {
  const costUsd = chatCostUsd(input.usage.model, input.usage);
  const { error } = await createSupabaseAdminClient()
    .from("ai_usage")
    .insert({
      kind: "chat",
      user_id: input.userId,
      assistant_id: input.assistantId,
      conversation_id: input.conversationId,
      provider: input.provider,
      model: input.usage.model,
      input_tokens: input.usage.inputTokens,
      cached_input_tokens: input.usage.cachedInputTokens,
      output_tokens: input.usage.outputTokens,
      reasoning_tokens: input.usage.reasoningTokens,
      cost_usd: costUsd,
      cost_sek: usdToSek(costUsd),
      estimated: input.usage.estimated,
      data_class: input.dataClass,
      purpose: input.purpose ?? "conversation",
    });
  if (error) console.error("[ai/usage] could not record chat usage", error.message);
}

export async function recordEmbeddingUsage(input: {
  userId: string | null;
  assistantId?: string | null;
  conversationId?: string | null;
  model: string;
  tokens: number;
  dataClass: "internal" | "synthetic";
  purpose?: UsagePurpose;
}) {
  const costUsd = embeddingCostUsd(input.model, input.tokens);
  const { error } = await createSupabaseAdminClient()
    .from("ai_usage")
    .insert({
      kind: "embedding",
      user_id: input.userId,
      assistant_id: input.assistantId ?? null,
      conversation_id: input.conversationId ?? null,
      provider: "openai",
      model: input.model,
      input_tokens: input.tokens,
      output_tokens: 0,
      cost_usd: costUsd,
      cost_sek: usdToSek(costUsd),
      estimated: false,
      data_class: input.dataClass,
      purpose: input.purpose ?? "conversation",
    });
  if (error) console.error("[ai/usage] could not record embedding usage", error.message);
}
