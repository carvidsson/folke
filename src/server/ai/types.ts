import type { MessageRole } from "@/lib/domain/types";

/**
 * Provider-neutral AI interface.
 *
 * No AI vendor is approved for company data yet. Everything above this
 * interface (route handler, persistence, retrieval, UI) is vendor-agnostic;
 * adding a vendor means adding one implementation in ./providers and
 * registering it in ./index.ts.
 */

export interface ProviderMessage {
  role: MessageRole;
  content: string;
}

/** A retrieved document excerpt the model may cite as [index]. */
export interface ContextChunk {
  index: number;
  documentId: string;
  title: string;
  /** Full chunk text – what a model receives as context. */
  content: string;
  location: string | null;
  /** Passage around the matching terms (for display and the mock answer). */
  snippet?: string | null;
}

export interface ChatCompletionInput {
  /** Complete system prompt (assistant instructions + rules + context). */
  system: string;
  messages: ProviderMessage[];
  context: ContextChunk[];
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number };

export interface AIProvider {
  readonly id: string;
  streamChat(input: ChatCompletionInput): AsyncIterable<ProviderEvent>;
}
