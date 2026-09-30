import type { ChatStreamEvent } from "@/lib/chat/protocol";
import type { Assistant, MessageRole } from "@/lib/domain/types";

/**
 * Provider-neutral AI interface.
 *
 * Folke has not chosen an AI vendor yet. Everything above this interface
 * (route handlers, UI) is vendor-agnostic; adding a vendor means adding one
 * implementation in ./providers and registering it in ./index.ts.
 */

export interface ProviderMessage {
  role: MessageRole;
  content: string;
}

export interface ChatCompletionInput {
  assistant: Assistant;
  messages: ProviderMessage[];
  /**
   * Retrieved context the model may cite. Empty until retrieval (RAG) is
   * built; retrieval must filter by the user's document access first.
   */
  context: RetrievedChunk[];
  signal?: AbortSignal;
}

export interface RetrievedChunk {
  documentId: string;
  title: string;
  text: string;
  location: string | null;
}

export interface AIProvider {
  readonly id: string;
  streamChat(input: ChatCompletionInput): AsyncIterable<ChatStreamEvent>;
}
