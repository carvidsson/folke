import "server-only";

import { documentValidity } from "@/lib/domain/access";
import type { DocumentValidity, KnowledgeDocument } from "@/lib/domain/types";

import { mockStore } from "./mock-store";

// Mock implementation. Replace with database queries (see docs/ARCHITECTURE.md).

export type KnowledgeDocumentView = KnowledgeDocument & {
  validity: DocumentValidity;
  uploadedByName: string;
};

/**
 * Documents visible in the knowledge base.
 *
 * TODO(backend): filter by document access for the current user. In the
 * prototype every document is returned so the UI can show all states.
 */
export async function listDocuments(): Promise<KnowledgeDocumentView[]> {
  const store = mockStore();
  const names = new Map(store.users.map((u) => [u.id, u.name]));
  return store.documents
    .map((doc) => ({
      ...doc,
      validity: documentValidity(doc, store.now),
      uploadedByName: names.get(doc.uploadedById) ?? "Okänd",
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}
