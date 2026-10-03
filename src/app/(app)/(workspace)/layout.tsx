import { AppShell } from "@/components/layout/app-shell";
import { WorkspaceSidebar } from "@/components/layout/workspace-sidebar";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { listConversations } from "@/server/data/conversations";
import { myLeadAccess } from "@/server/data/leads";
import { hubSpotConfigured } from "@/server/leads/hubspot";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getSession();
  const [assistants, recent, leadAccess] = await Promise.all([
    listMyAssistants(),
    listConversations(user.id, { limit: 5 }),
    hubSpotConfigured() ? myLeadAccess() : Promise.resolve(null),
  ]);

  return (
    <AppShell sidebar={<WorkspaceSidebar user={user} assistants={assistants} recent={recent} leadAnalysis={!!leadAccess?.hasAccess} />}>
      {children}
    </AppShell>
  );
}
