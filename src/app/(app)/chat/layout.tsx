import { AppShell } from "@/components/layout/app-shell";
import { ChatSidebar } from "@/components/layout/chat-sidebar";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { listConversations } from "@/server/data/conversations";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getSession();
  const [assistants, conversations] = await Promise.all([
    listMyAssistants(),
    listConversations(user.id),
  ]);

  return (
    <AppShell
      mobileTopBar={false}
      sidebar={
        <ChatSidebar
          user={user}
          assistants={assistants}
          conversations={conversations}
          now={new Date()}
        />
      }
    >
      {children}
    </AppShell>
  );
}
