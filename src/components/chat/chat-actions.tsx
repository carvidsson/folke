"use client";

import { createContext, useContext } from "react";

/** What a message's own controls may do in the conversation it belongs to ("Ställ frågan igen"). */
export interface ChatActions {
  ask: (text: string) => void;
  busy: boolean;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions() {
  return useContext(ChatActionsContext);
}
