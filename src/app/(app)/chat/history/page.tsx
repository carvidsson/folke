import type { Metadata } from "next";

import { ConversationHistory } from "@/components/chat/conversation-history";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { listConversations } from "@/server/data/conversations";

export const metadata: Metadata = { title: "Konversationer" };

export default async function ConversationHistoryPage() {
  const { user } = await getSession();
  const [conversations, assistants] = await Promise.all([listConversations(user.id), listMyAssistants()]);
  return <ConversationHistory conversations={conversations} assistants={assistants} />;
}
