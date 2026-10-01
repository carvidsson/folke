import "server-only";

import { serverEnv } from "@/server/env";

import { mockProvider } from "./providers/mock";
import type { AIProvider } from "./types";

export type { AIProvider } from "./types";

/**
 * Resolves the configured AI provider (server-side env FOLKE_AI_PROVIDER,
 * default "mock").
 *
 * Only providers registered here can be used. No real provider is
 * registered until a vendor is approved for company data – see
 * docs/DECISIONS.md. API keys must only be read inside a provider module,
 * from server-side environment variables.
 */
const providers: Record<string, AIProvider> = {
  mock: mockProvider,
};

export function getAIProvider(): AIProvider {
  const id = serverEnv().FOLKE_AI_PROVIDER;
  const provider = providers[id];
  if (!provider) throw new Error(`AI provider "${id}" is not registered`);
  return provider;
}
