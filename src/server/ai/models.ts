import "server-only";

import { serverEnv } from "@/server/env";

/**
 * Central model catalog – the ONLY models Folke can call.
 *
 * A model must be listed here (with verified availability and price) before
 * it can be chosen. Administrators pick per assistant among the models that
 * are both in this catalog and enabled by FOLKE_CHAT_MODELS; the choice is
 * stored in the database, so switching needs no code change or deployment.
 * Every request resolves the stored value against this list again and falls
 * back to the default, so a tampered or outdated value can never select an
 * unlisted model or endpoint. All models use the same Responses API call with
 * the same limits (max_output_tokens, budgets, data guard).
 *
 * Prices in USD per million tokens from OpenAI's price list, checked
 * 2026-10-01. Availability verified in the project "Folke Development" with
 * synthetic test calls on 2026-10-01. Review both regularly.
 */

export type CostLevel = "low" | "medium" | "high";

export interface ChatModel {
  id: string;
  label: string;
  description: string;
  costLevel: CostLevel;
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Responses API `reasoning.effort` (temperature is not supported by these models). */
  reasoningEffort: "none" | "low" | "medium";
}

export interface EmbeddingModel {
  id: string;
  dimensions: number;
  usdPerMTok: number;
}

export const CHAT_MODELS: readonly ChatModel[] = [
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    description: "Snabb och billig. Standard för alla assistenter.",
    costLevel: "low",
    inputUsdPerMTok: 0.1,
    cachedInputUsdPerMTok: 0.01,
    outputUsdPerMTok: 0.5,
    reasoningEffort: "low",
  },
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    description: "Mer avancerad. Använd där kvalitetstesterna visar att det behövs.",
    costLevel: "medium",
    inputUsdPerMTok: 2,
    cachedInputUsdPerMTok: 0.1,
    outputUsdPerMTok: 10,
    reasoningEffort: "low",
  },
];

export const DEFAULT_CHAT_MODEL = "gpt-6-luna";

export const EMBEDDING_MODELS: readonly EmbeddingModel[] = [
  // Dimensions must match document_chunks.embedding (halfvec(1536)).
  { id: "text-embedding-3-small", dimensions: 1536, usdPerMTok: 0.02 },
];

export const COST_LEVEL_LABELS: Record<CostLevel, string> = {
  low: "Låg kostnad",
  medium: "Medelhög kostnad",
  high: "Hög kostnad",
};

/** Models administrators may choose (catalog ∩ FOLKE_CHAT_MODELS). */
export function allowedChatModels(): ChatModel[] {
  const configured = serverEnv()
    .FOLKE_CHAT_MODELS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const models = configured ? CHAT_MODELS.filter((m) => configured.includes(m.id)) : [...CHAT_MODELS];
  return models.length ? models : CHAT_MODELS.filter((m) => m.id === DEFAULT_CHAT_MODEL);
}

export function defaultChatModel(): ChatModel {
  const allowed = allowedChatModels();
  const configured = serverEnv().FOLKE_CHAT_MODEL_DEFAULT;
  return allowed.find((m) => m.id === configured) ?? allowed.find((m) => m.id === DEFAULT_CHAT_MODEL) ?? allowed[0];
}

/** The model to use for an assistant's stored choice (null/unknown → default). */
export function resolveChatModel(stored: string | null | undefined): ChatModel {
  return allowedChatModels().find((m) => m.id === stored) ?? defaultChatModel();
}

export function isAllowedChatModel(id: string): boolean {
  return allowedChatModels().some((m) => m.id === id);
}

export function embeddingModel(): EmbeddingModel {
  const configured = serverEnv().FOLKE_EMBEDDING_MODEL;
  return EMBEDDING_MODELS.find((m) => m.id === configured) ?? EMBEDDING_MODELS[0];
}

/** Typical cost of one answer (3 000 input + 500 output tokens), for the admin UI. */
export function typicalAnswerCostUsd(model: ChatModel): number {
  return (3000 * model.inputUsdPerMTok + 500 * model.outputUsdPerMTok) / 1_000_000;
}
