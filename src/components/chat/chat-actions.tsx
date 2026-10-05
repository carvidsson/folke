"use client";

import { createContext, useContext } from "react";

import type { LeadTurn } from "@/lib/leads/chat";

/** What a message's own controls may do in the conversation it belongs to ("Ställ frågan igen"). */
export interface ChatActions {
  /** Sends the text as the user's next message; Leadanalys may add a structured turn (no interpretation). */
  ask: (text: string, leadTurn?: LeadTurn) => void;
  busy: boolean;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions() {
  return useContext(ChatActionsContext);
}
