import type { Metadata } from "next";

import { KnowledgeView } from "@/components/knowledge/knowledge-view";
import { approvedDocumentsEnabled } from "@/server/ai/guard";
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

  const isAdmin = user.role === "system_admin";
  const managed = groups.filter((g) => g.managerIds.includes(user.id));
  const memberOf = groups.filter((g) => !g.system && g.memberIds.includes(user.id));
  const option = ({ id, name, system }: (typeof groups)[number]) => ({ id, name, system });

  // Mirrors the database rules (app.can_upload_documents and the insert
  // policy on documents); the database remains the authority.
  const canUpload = isAdmin || user.role === "assistant_manager" || managed.length > 0;
  const ownerGroups = (isAdmin ? groups : memberOf).map(option);
  const shareGroups = (isAdmin ? groups : memberOf).map(option);

  return (
    <KnowledgeView
      documents={documents}
      collections={collections}
      assistants={assistants}
      groups={groups.map(option)}
      ownerGroups={ownerGroups}
      shareGroups={shareGroups}
      canUpload={canUpload && ownerGroups.length > 0}
      reviewableGroupIds={managed.map((g) => g.id)}
      isAdmin={isAdmin}
      aiEnabled={approvedDocumentsEnabled()}
      currentUserId={user.id}
      initialDocumentId={typeof document === "string" ? document : null}
    />
  );
}
