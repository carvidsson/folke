import type { Metadata } from "next";

import { PermissionsView, type PermissionsData } from "@/components/admin/permissions-view";
import { documentVisibleToGroup } from "@/lib/domain/access";
import type { Role } from "@/lib/domain/types";
import { requireSystemAdminPage } from "@/server/auth/session";
import { listAssistantGrants, listAssistants, listCollections } from "@/server/data/assistants";
import { listDocuments } from "@/server/data/documents";
import { listGroups, listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Behörigheter" };

export default async function AdminPermissionsPage() {
  await requireSystemAdminPage();
  const [groups, users, assistants, grants, collections, documents] = await Promise.all([
    listGroups(),
    listUsers(),
    listAssistants(),
    listAssistantGrants(),
    listCollections(),
    listDocuments(),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const systemGroupIds = groups.filter((g) => g.system).map((g) => g.id);

  const data: PermissionsData = {
    groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberIds.length })),
    assistants,
    groupGrants: Object.fromEntries(
      groups.map((g) => [
        g.id,
        grants
          .filter((x) => x.subject.type === "group" && x.subject.groupId === g.id)
          .map((x) => x.assistantId),
      ]),
    ),
    directGrants: grants.flatMap((x) =>
      x.subject.type === "user"
        ? [{ id: x.id, userName: userName.get(x.subject.userId) ?? "Okänd", assistantId: x.assistantId }]
        : [],
    ),
    users: users.filter((u) => u.status !== "disabled").map(({ id, name }) => ({ id, name })),
    collections: collections.map((c) => ({ id: c.id, name: c.name })),
    documentCoverage: Object.fromEntries(
      groups.map((g) => [
        g.id,
        Object.fromEntries(
          collections.map((c) => {
            const inCollection = documents.filter((d) => d.collectionId === c.id);
            return [
              c.id,
              {
                visible: inCollection.filter((d) => documentVisibleToGroup(d, g, systemGroupIds)).length,
                total: inCollection.length,
              },
            ];
          }),
        ),
      ]),
    ),
    roleCounts: users.reduce(
      (acc, u) => ({ ...acc, [u.role]: (acc[u.role] ?? 0) + 1 }),
      {} as Record<Role, number>,
    ),
  };

  return <PermissionsView data={data} />;
}
