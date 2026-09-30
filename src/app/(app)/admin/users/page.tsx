import type { Metadata } from "next";

import { UsersView, type UserRow } from "@/components/admin/users-view";
import { accessibleAssistantIds } from "@/lib/domain/access";
import { requireAdministrationAccess } from "@/server/auth/session";
import { listAssistantGrants, listAssistants } from "@/server/data/assistants";
import { listGroups, listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Användare" };

export default async function AdminUsersPage() {
  await requireAdministrationAccess();
  const [users, groups, assistants, grants] = await Promise.all([
    listUsers(),
    listGroups(),
    listAssistants(),
    listAssistantGrants(),
  ]);

  const rows: UserRow[] = users.map((user) => ({
    user,
    groupNames: groups
      .filter((g) => !g.system && g.memberIds.includes(user.id))
      .map((g) => g.name),
    assistantIds: user.status === "disabled" ? [] : accessibleAssistantIds(user.id, grants, groups),
  }));

  return (
    <UsersView
      rows={rows}
      assistants={assistants}
      groups={groups.map(({ id, name }) => ({ id, name }))}
      nowIso={new Date().toISOString()}
    />
  );
}
