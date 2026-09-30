import type { Metadata } from "next";

import { KnowledgeView } from "@/components/knowledge/knowledge-view";
import { roleHas } from "@/lib/domain/roles";
import { getSession } from "@/server/auth/session";
import { listAssistants, listCollections } from "@/server/data/assistants";
import { listDocuments } from "@/server/data/documents";
import { listGroups } from "@/server/data/users";

export const metadata: Metadata = { title: "Kunskapsbank" };

export default async function KnowledgePage({ searchParams }: PageProps<"/knowledge">) {
  const { user } = await getSession();
  const [documents, collections, assistants, groups, { document }] = await Promise.all([
    listDocuments(),
    listCollections(),
    listAssistants(),
    listGroups(),
    searchParams,
  ]);

  return (
    <KnowledgeView
      documents={documents}
      collections={collections}
      assistants={assistants}
      groups={groups.map(({ id, name }) => ({ id, name }))}
      canUpload={roleHas(user.role, "knowledge.upload")}
      initialDocumentId={typeof document === "string" ? document : null}
    />
  );
}
