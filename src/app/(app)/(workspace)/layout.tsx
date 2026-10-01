import { AppShell } from "@/components/layout/app-shell";
import { WorkspaceSidebar } from "@/components/layout/workspace-sidebar";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { listConversations } from "@/server/data/conversations";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getSession();
  const [assistants, recent] = await Promise.all([
    listMyAssistants(),
    listConversations(user.id, { limit: 5 }),
  ]);

  return (
    <AppShell sidebar={<WorkspaceSidebar user={user} assistants={assistants} recent={recent} />}>
      {children}
    </AppShell>
  );
}
