import "server-only";

import { accessibleAssistantIds } from "@/lib/domain/access";
import type {
  Assistant,
  AssistantGrant,
  ID,
  KnowledgeCollection,
} from "@/lib/domain/types";

import { mockStore } from "./mock-store";

// Mock implementation. Replace with database queries (see docs/ARCHITECTURE.md).

export async function listAssistants(): Promise<Assistant[]> {
  return mockStore().assistants;
}

export async function listAssistantGrants(): Promise<AssistantGrant[]> {
  return mockStore().assistantGrants;
}

export async function listCollections(): Promise<KnowledgeCollection[]> {
  return mockStore().collections;
}

/** Assistants the given user may use (direct or via group). */
export async function listAssistantsForUser(userId: ID): Promise<Assistant[]> {
  const store = mockStore();
  const allowed = new Set(
    accessibleAssistantIds(userId, store.assistantGrants, store.groups),
  );
  return store.assistants.filter(
    (a) => allowed.has(a.id) && a.status === "active",
  );
}

/**
 * Returns the assistant only if the user may use it. Server code must use
 * this (not `listAssistants`) whenever acting on behalf of a user.
 */
export async function getAssistantForUser(
  userId: ID,
  assistantId: ID,
): Promise<Assistant | null> {
  const assistants = await listAssistantsForUser(userId);
  return assistants.find((a) => a.id === assistantId) ?? null;
}
