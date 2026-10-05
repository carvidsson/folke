import type { Metadata } from "next";

import { ChatView } from "@/components/chat/chat-view";
import { NoAssistants } from "@/components/chat/no-assistants";
import { attachmentsEnabled } from "@/server/ai/guard";
import { getSession } from "@/server/auth/session";
import { getMySyntheticModeAvailability } from "@/server/data/ai";
import { listMyAssistants } from "@/server/data/assistants";

export const metadata: Metadata = { title: "Ny chatt" };

// Leadanalys steps started from the chat (ADR-050) run as server actions on this page: the same time budget as on the Leadanalys page.
export const maxDuration = 800;

export default async function NewChatPage({ searchParams }: PageProps<"/chat">) {
  const { user } = await getSession();
  const [assistants, syntheticModeAvailable] = await Promise.all([
    listMyAssistants(),
    getMySyntheticModeAvailability(user.id),
  ]);
  if (assistants.length === 0) return <NoAssistants />;

  const { assistant: slug } = await searchParams;
  const initial = assistants.find((a) => a.slug === slug) ?? assistants[0];

  // Keyed so switching assistant via the URL starts a fresh chat.
  return (
    <ChatView
      key={initial.id}
      assistants={assistants}
      initialAssistantId={initial.id}
      syntheticModeAvailable={syntheticModeAvailable}
      attachmentsEnabled={attachmentsEnabled()}
    />
  );
}
