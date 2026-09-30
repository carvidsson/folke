import type { Metadata } from "next";

import { AssistantsView, type AssistantRow } from "@/components/admin/assistants-view";
import { assistantAccessSources } from "@/lib/domain/access";
import { requireAdministrationAccess } from "@/server/auth/session";
import { listAssistantGrants, listAssistants, listCollections } from "@/server/data/assistants";
import { listDocuments } from "@/server/data/documents";
import { listGroups, listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Assistenter" };

export default async function AdminAssistantsPage() {
  await requireAdministrationAccess();
  const [assistants, grants, collections, documents, users, groups] = await Promise.all([
    listAssistants(),
    listAssistantGrants(),
    listCollections(),
    listDocuments(),
    listUsers(),
    listGroups(),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const group = new Map(groups.map((g) => [g.id, g]));
  const activeUsers = users.filter((u) => u.status !== "disabled");

  const rows: AssistantRow[] = assistants.map((assistant) => ({
    assistant,
    managerNames: assistant.managerIds.map((id) => userName.get(id) ?? "Okänd"),
    collections: collections.filter((c) => assistant.collectionIds.includes(c.id)),
    documentCount: documents.filter((d) => d.assistantIds.includes(assistant.id)).length,
    userCount: activeUsers.filter(
      (u) => assistantAccessSources(u.id, assistant.id, grants, groups).length > 0,
    ).length,
    grants: grants
      .filter((g) => g.assistantId === assistant.id)
      .map((g) =>
        g.subject.type === "group"
          ? {
              id: g.id,
              kind: "group" as const,
              label: group.get(g.subject.groupId)?.name ?? "Okänd grupp",
              memberCount: group.get(g.subject.groupId)?.memberIds.length ?? 0,
            }
          : { id: g.id, kind: "user" as const, label: userName.get(g.subject.userId) ?? "Okänd" },
      ),
  }));

  return <AssistantsView rows={rows} />;
}
