import { UsersRound } from "lucide-react";
import type { Metadata } from "next";

import { CreateGroupButton, CreateGroupCard, GroupMenu } from "@/components/admin/group-actions";
import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { documentVisibleToGroup } from "@/lib/domain/access";
import { requireAdministrationAccess } from "@/server/auth/session";
import { listAssistantGrants, listAssistants } from "@/server/data/assistants";
import { listDocuments } from "@/server/data/documents";
import { listGroups, listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Grupper" };

export default async function AdminGroupsPage() {
  await requireAdministrationAccess();
  const [groups, users, assistants, grants, documents] = await Promise.all([
    listGroups(),
    listUsers(),
    listAssistants(),
    listAssistantGrants(),
    listDocuments(),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Grupper"
        description="Grupper används för att tilldela assistenter och dokument till flera användare samtidigt."
        actions={<CreateGroupButton />}
      />

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => {
          const members = group.memberIds.map((id) => userById.get(id)).filter((u) => u !== undefined);
          const groupAssistants = assistants.filter((a) =>
            grants.some(
              (g) => g.assistantId === a.id && g.subject.type === "group" && g.subject.groupId === group.id,
            ),
          );
          const docCount = documents.filter((d) => documentVisibleToGroup(d, group.id, grants)).length;

          return (
            <article key={group.id} className="flex flex-col rounded-xl border bg-card p-5 shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <UsersRound className="size-[18px]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <h2 className="text-heading">{group.name}</h2>
                    {group.system && (
                      <Badge variant="outline" className="mt-0.5 font-normal text-muted-foreground">
                        Systemgrupp
                      </Badge>
                    )}
                  </div>
                </div>
                <GroupMenu name={group.name} editable={!group.system} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{group.description}</p>

              <dl className="mt-5 grid grid-cols-3 gap-3 border-t pt-4 text-sm">
                <div>
                  <dt className="text-caption">Medlemmar</dt>
                  <dd className="mt-1 font-medium tabular-nums">{members.length}</dd>
                </div>
                <div>
                  <dt className="text-caption">Assistenter</dt>
                  <dd className="mt-1 flex -space-x-1">
                    {groupAssistants.length === 0 ? (
                      <span className="font-medium">0</span>
                    ) : (
                      groupAssistants.map((a) => (
                        <AssistantAvatar key={a.id} assistant={a} size="xs" className="ring-2 ring-card" />
                      ))
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption">Dokument</dt>
                  <dd className="mt-1 font-medium tabular-nums">{docCount}</dd>
                </div>
              </dl>

              <div className="mt-auto flex items-center pt-5">
                <div className="flex -space-x-1">
                  {members.slice(0, 6).map((u) => (
                    <UserAvatar key={u.id} name={u.name} className="ring-2 ring-card" />
                  ))}
                </div>
                {members.length > 6 && (
                  <span className="ml-2 text-xs text-muted-foreground">+{members.length - 6}</span>
                )}
              </div>
            </article>
          );
        })}

        <CreateGroupCard />
      </div>
    </PageContainer>
  );
}
