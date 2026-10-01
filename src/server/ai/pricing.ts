import "server-only";

import { serverEnv } from "@/server/env";

import { CHAT_MODELS, EMBEDDING_MODELS } from "./models";

/**
 * Cost estimates from token counts and the model catalog's price list.
 *
 * Costs are estimates: OpenAI's invoice is authoritative, and the project
 * budget in OpenAI is not a guaranteed hard limit either. Unknown models
 * are recorded with cost 0 and a warning, so usage is never lost.
 */

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

export function chatCostUsd(model: string, usage: TokenUsage): number {
  if (model === "mock") return 0;
  const price = CHAT_MODELS.find((m) => m.id === model);
  if (!price) {
    console.warn(`[pricing] no price configured for model ${model}`);
    return 0;
  }
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cost =
    (usage.inputTokens - cached) * price.inputUsdPerMTok +
    cached * price.cachedInputUsdPerMTok +
    usage.outputTokens * price.outputUsdPerMTok;
  return round(cost / 1_000_000, 6);
}

export function embeddingCostUsd(model: string, tokens: number): number {
  const price = EMBEDDING_MODELS.find((m) => m.id === model);
  if (!price) {
    console.warn(`[pricing] no price configured for embedding model ${model}`);
    return 0;
  }
  return round((tokens * price.usdPerMTok) / 1_000_000, 6);
}

export function usdToSek(usd: number): number {
  return round(usd * serverEnv().FOLKE_USD_TO_SEK, 4);
}

function round(value: number, decimals: number) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
