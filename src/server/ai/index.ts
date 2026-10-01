import "server-only";

import { mockProvider } from "./providers/mock";
import { openAIProvider } from "./providers/openai";
import type { AIProvider } from "./types";

export type { AIProvider } from "./types";

/**
 * Provider registry. Which provider a request may use is decided by the
 * data guard (./guard.ts: chooseProviderId), never by the client. API keys
 * are only read inside provider modules, from server-side environment
 * variables.
 */
const providers: Record<"mock" | "openai", AIProvider> = {
  mock: mockProvider,
  openai: openAIProvider,
};

export function getAIProvider(id: "mock" | "openai"): AIProvider {
  return providers[id];
}
