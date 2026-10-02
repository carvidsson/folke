import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ChatView } from "@/components/chat/chat-view";
import { attachmentsEnabled } from "@/server/ai/guard";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { getConversation } from "@/server/data/conversations";

export async function generateMetadata({
  params,
}: PageProps<"/chat/[conversationId]">): Promise<Metadata> {
  const { user } = await getSession();
  const conversation = await getConversation(user.id, (await params).conversationId);
  return { title: conversation?.title ?? "Chatt" };
}

export default async function ConversationPage({ params }: PageProps<"/chat/[conversationId]">) {
  const { conversationId } = await params;
  const { user } = await getSession();
  const [conversation, assistants] = await Promise.all([
    getConversation(user.id, conversationId),
    listMyAssistants(),
  ]);
  if (!conversation) notFound();

  // A conversation with an assistant the user no longer has access to is hidden.
  const assistant = assistants.find((a) => a.id === conversation.assistantId);
  if (!assistant) notFound();

  return (
    <ChatView
      key={conversation.id}
      assistants={[assistant]}
      initialAssistantId={assistant.id}
      conversation={{
        id: conversation.id,
        title: conversation.title,
        dataClass: conversation.dataClass,
        messages: conversation.messages,
      }}
      attachmentsEnabled={attachmentsEnabled()}
    />
  );
}
