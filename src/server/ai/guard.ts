import "server-only";

import { serverEnv } from "@/server/env";

import type { ContextChunk } from "./types";

/**
 * External data guard (ADR-031, ADR-036).
 *
 * Decides what may be sent to the external AI provider, on the server, from
 * data users cannot change:
 *   - server environment: FOLKE_AI_PROVIDER and FOLKE_AI_EXTERNAL_DATA,
 *   - documents.ai_data_class: 'internal' (default, never sent),
 *     'approved' (approved one by one by a system administrator, revocable),
 *     'synthetic' (fictional test data) – enforced by database triggers,
 *   - conversations.data_class: 'synthetic' test conversations (requires
 *     AI test access, immutable) or ordinary 'internal' conversations,
 *   - profiles.ai_test_access (system administrators only).
 *
 * Policies:
 *   synthetic-only      → only synthetic conversations of test users use
 *                         OpenAI, with synthetic documents only.
 *   approved-documents  → additionally, ordinary conversations use OpenAI
 *                         with approved documents only.
 * The database adds independent checks (class trigger, embedding trigger,
 * approval function, RLS on every retrieved row).
 */

export type ConversationDataClass = "internal" | "synthetic";
export type DocumentDataClass = "internal" | "synthetic" | "approved";

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

/** Whether OpenAI is configured at all (provider + key). */
export function externalProviderConfigured(): boolean {
  const env = serverEnv();
  return env.FOLKE_AI_PROVIDER === "openai" && Boolean(env.OPENAI_API_KEY);
}

/** Whether ordinary conversations may use OpenAI with approved documents. */
export function approvedDocumentsEnabled(): boolean {
  return externalProviderConfigured() && serverEnv().FOLKE_AI_EXTERNAL_DATA === "approved-documents";
}

/** Which provider a chat turn may use. Anything not explicitly allowed is mock. */
export function chooseProviderId({ conversationClass, userHasTestAccess }: RoutingInput): "mock" | "openai" {
  if (!externalProviderConfigured()) return "mock";
  if (conversationClass === "synthetic") return userHasTestAccess ? "openai" : "mock";
  return approvedDocumentsEnabled() ? "openai" : "mock";
}

/** The only document class an external call may use for this conversation. */
function allowedExternalClass(conversationClass: ConversationDataClass): DocumentDataClass {
  return conversationClass === "synthetic" ? "synthetic" : "approved";
}

/**
 * Which documents a conversation may retrieve from (null = all the user may
 * read, only for the mock provider). External calls retrieve only the
 * allowed class, filtered in the database at query time – so a revoked
 * document is excluded from the very next call.
 */
export function retrievalDataClass(conversationClass: ConversationDataClass, external: boolean): DocumentDataClass | null {
  if (conversationClass === "synthetic") return "synthetic";
  return external ? "approved" : null;
}

/** Document classes whose earlier answers may be sent again as history. */
export function historyAllowedClasses(conversationClass: ConversationDataClass, external: boolean): DocumentDataClass[] | null {
  return external ? [allowedExternalClass(conversationClass)] : null;
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
  if (!externalProviderConfigured()) throw new DataGuardError("external provider not configured");
  if (input.conversationClass === "synthetic") {
    if (!input.userHasTestAccess) throw new DataGuardError("user lacks AI test access");
  } else if (!approvedDocumentsEnabled()) {
    throw new DataGuardError("ordinary conversations are not enabled for the external provider");
  }
  const allowed = allowedExternalClass(input.conversationClass);
  if (input.context.some((c) => c.dataClass !== allowed)) {
    throw new DataGuardError(`context contains documents that are not ${allowed}`);
  }
}

/** Embeddings may only be created for synthetic or approved documents. */
export function assertEmbeddable(documents: { ai_data_class: string }[]) {
  if (documents.some((d) => d.ai_data_class !== "synthetic" && d.ai_data_class !== "approved")) {
    throw new DataGuardError("embedding requested for documents that are not approved");
  }
}
