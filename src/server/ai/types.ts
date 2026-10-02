import type { MessageRole } from "@/lib/domain/types";

/**
 * Provider-neutral AI interface.
 *
 * Everything above this interface (route handler, persistence, retrieval,
 * data guard, UI) is vendor-agnostic; adding a vendor means adding one
 * implementation in ./providers and registering it in ./index.ts.
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
  /** Data class of the source document (checked before external calls). */
  dataClass?: "internal" | "synthetic" | "approved";
  /** Document metadata sent with the excerpt (dates as YYYY-MM-DD). */
  validFrom?: string | null;
  validUntil?: string | null;
  uploadedAt?: string | null;
  /** Re-read because an earlier answer in the conversation cited it. */
  reused?: boolean;
}

export interface ChatCompletionInput {
  /** Complete system prompt (assistant instructions + rules + context). */
  system: string;
  messages: ProviderMessage[];
  context: ContextChunk[];
  /** Model id from the catalog (ignored by the mock provider). */
  model?: string;
  signal?: AbortSignal;
  /**
   * Called exactly once when tokens were consumed – also after errors and
   * aborts – so cost tracking never misses a call.
   */
  onUsage?: (usage: UsageReport) => void;
}

export interface UsageReport {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** True when counts are estimated (mock, or a stream without final usage). */
  estimated: boolean;
}

export interface ProviderEvent {
  type: "text";
  delta: string;
}

export interface AIProvider {
  readonly id: string;
  /** True if calls leave Folke's infrastructure (subject to the data guard). */
  readonly external: boolean;
  streamChat(input: ChatCompletionInput): AsyncIterable<ProviderEvent>;
}
