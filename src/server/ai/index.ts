import "server-only";

import { mockProvider } from "./providers/mock";
import type { AIProvider } from "./types";

export type { AIProvider } from "./types";

/**
 * Resolves the configured AI provider.
 *
 * Selected with the server-side env var FOLKE_AI_PROVIDER (default "mock").
 * API keys for real providers must only ever be read here, on the server,
 * from environment variables – never committed and never sent to the client.
 */
const providers: Record<string, AIProvider> = {
  mock: mockProvider,
};

export function getAIProvider(): AIProvider {
  const id = process.env.FOLKE_AI_PROVIDER ?? "mock";
  const provider = providers[id];
  if (!provider) {
    throw new Error(`AI provider "${id}" is not configured`);
  }
  return provider;
}
