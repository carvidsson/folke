import "server-only";

import { ASSISTANT_GRANTS, ASSISTANTS, COLLECTIONS } from "@/mocks/assistants";
import { buildConversations } from "@/mocks/conversations";
import { buildDocuments } from "@/mocks/documents";
import { buildUsers, GROUPS } from "@/mocks/people";

/**
 * In-memory mock store. Built per call so relative timestamps stay fresh.
 *
 * Only the repository modules in this folder may import it. When the
 * database is introduced, the repositories switch to real queries and this
 * file is deleted.
 */
export function mockStore(now = new Date()) {
  return {
    now,
    users: buildUsers(now),
    groups: GROUPS,
    assistants: ASSISTANTS,
    assistantGrants: ASSISTANT_GRANTS,
    collections: COLLECTIONS,
    documents: buildDocuments(now),
    conversations: buildConversations(now),
  };
}
