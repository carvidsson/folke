import type { Metadata } from "next";

import { ChatView } from "@/components/chat/chat-view";
import { NoAssistants } from "@/components/chat/no-assistants";
import { getSession } from "@/server/auth/session";
import { listAssistantsForUser } from "@/server/data/assistants";

export const metadata: Metadata = { title: "Ny chatt" };

export default async function NewChatPage({ searchParams }: PageProps<"/chat">) {
  const { user } = await getSession();
  const assistants = await listAssistantsForUser(user.id);
  if (assistants.length === 0) return <NoAssistants />;

  const { assistant: slug } = await searchParams;
  const initial = assistants.find((a) => a.slug === slug) ?? assistants[0];

  // Keyed so switching assistant via the URL starts a fresh chat.
  return <ChatView key={initial.id} assistants={assistants} initialAssistantId={initial.id} />;
}
