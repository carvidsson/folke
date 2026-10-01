import "server-only";

import { serverEnv } from "@/server/env";

import type { ContextChunk } from "./types";

/**
 * External data guard (ADR-031).
 *
 * Until a vendor agreement covers Börjessons' internal information, ONLY
 * synthetic test data may be sent to an external AI provider – for answers
 * and for embeddings. The decision is made here, on the server, from data
 * users cannot change:
 *   - conversations.data_class (set at creation, immutable; 'synthetic'
 *     requires profiles.ai_test_access, enforced by RLS),
 *   - profiles.ai_test_access (set by system administrators via the server),
 *   - documents.ai_data_class (set by the server, immutable; enforced by
 *     database triggers),
 *   - server environment (FOLKE_AI_PROVIDER, FOLKE_AI_EXTERNAL_DATA).
 * The database adds independent checks (embedding trigger, insert policy).
 */

export type ConversationDataClass = "internal" | "synthetic";

export class DataGuardError extends Error {
  constructor(reason: string) {
    super(`Data guard blocked an external AI call: ${reason}`);
    this.name = "DataGuardError";
  }
}

export interface RoutingInput {
  conversationClass: ConversationDataClass;
  /** Read from the database for this request (not from the client). */
  userHasTestAccess: boolean;
}

/** Whether OpenAI is configured at all (provider + key + policy). */
export function externalProviderConfigured(): boolean {
  const env = serverEnv();
  return env.FOLKE_AI_PROVIDER === "openai" && Boolean(env.OPENAI_API_KEY) && env.FOLKE_AI_EXTERNAL_DATA === "synthetic-only";
}

/** Which provider a chat turn may use. Anything not explicitly allowed is mock. */
export function chooseProviderId({ conversationClass, userHasTestAccess }: RoutingInput): "mock" | "openai" {
  if (!externalProviderConfigured()) return "mock";
  if (conversationClass !== "synthetic") return "mock";
  if (!userHasTestAccess) return "mock";
  return "openai";
}

/**
 * Which documents a conversation may retrieve from. Synthetic conversations
 * only see synthetic documents, whichever provider answers.
 */
export function retrievalDataClass(conversationClass: ConversationDataClass): "synthetic" | null {
  return conversationClass === "synthetic" ? "synthetic" : null;
}

/**
 * Final check right before anything is sent to an external provider.
 * Throws instead of filtering: a violation means a bug upstream.
 */
export function assertExternalAllowed(input: {
  external: boolean;
  conversationClass: ConversationDataClass;
  userHasTestAccess: boolean;
  context: Pick<ContextChunk, "dataClass">[];
}) {
  if (!input.external) return;
  if (serverEnv().FOLKE_AI_EXTERNAL_DATA !== "synthetic-only") {
    throw new DataGuardError("unsupported external data policy");
  }
  if (input.conversationClass !== "synthetic") throw new DataGuardError("conversation is not synthetic");
  if (!input.userHasTestAccess) throw new DataGuardError("user lacks AI test access");
  if (input.context.some((c) => c.dataClass !== "synthetic")) {
    throw new DataGuardError("context contains non-synthetic documents");
  }
}

/** Embeddings may only be created for synthetic documents. */
export function assertEmbeddable(documents: { ai_data_class: string }[]) {
  if (documents.some((d) => d.ai_data_class !== "synthetic")) {
    throw new DataGuardError("embedding requested for non-synthetic documents");
  }
}
