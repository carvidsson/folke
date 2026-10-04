import type { Attachment } from "@/lib/domain/types";
import { leadChatContextSchema, type LeadChatContext } from "@/lib/leads/chat";

/**
 * Hands a prompt (and its already uploaded attachments) from the start
 * page's quick-start box to the chat view without putting user text in the
 * URL (where it would end up in browser history and server logs).
 */

const KEY = "folke:pending-prompt";

export interface PendingPrompt {
  text: string;
  attachments: Attachment[];
  /** Leadanalys: the selection the question was asked from (validated again on the server). */
  leadContext?: LeadChatContext;
}

export function setPendingPrompt(prompt: PendingPrompt) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(prompt));
  } catch {
    // Storage unavailable (private mode etc.) – the chat simply starts empty.
  }
}

export function takePendingPrompt(): PendingPrompt | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PendingPrompt>;
    return typeof parsed.text === "string" && parsed.text.trim()
      ? {
          text: parsed.text,
          attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
          leadContext: leadChatContextSchema.safeParse(parsed.leadContext).data,
        }
      : null;
  } catch {
    return null;
  }
}
