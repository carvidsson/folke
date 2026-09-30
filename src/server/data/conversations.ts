import "server-only";

import type { Conversation, ConversationSummary, ID } from "@/lib/domain/types";

import { mockStore } from "./mock-store";

// Mock implementation. Replace with database queries (see docs/ARCHITECTURE.md).

function toSummary({ messages, ...rest }: Conversation): ConversationSummary {
  const lastAnswer = messages.findLast((m) => m.role === "assistant");
  return {
    ...rest,
    preview: (lastAnswer?.content ?? messages[0]?.content ?? "")
      .replace(/[*#>|`_\-[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140),
  };
}

/** Conversations owned by the user, most recent first. */
export async function listConversations(
  ownerId: ID,
  { limit }: { limit?: number } = {},
): Promise<ConversationSummary[]> {
  const list = mockStore()
    .conversations.filter((c) => c.ownerId === ownerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toSummary);
  return limit ? list.slice(0, limit) : list;
}

/** A conversation, only if owned by the user. */
export async function getConversation(
  ownerId: ID,
  id: ID,
): Promise<Conversation | null> {
  const conversation = mockStore().conversations.find((c) => c.id === id);
  return conversation?.ownerId === ownerId ? conversation : null;
}
