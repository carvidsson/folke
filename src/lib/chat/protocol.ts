import { z } from "zod";

import type { MessageSource } from "@/lib/domain/types";
import { leadChatContextSchema, leadTurnSchema } from "@/lib/leads/chat";

/**
 * Wire protocol between the chat UI and POST /api/chat.
 *
 * Request: the NEW user message only. The server loads history from the
 * database, so a client cannot inject fabricated earlier turns.
 * Response: newline-delimited JSON (NDJSON), one `ChatStreamEvent` per line.
 */

export const MAX_MESSAGE_CHARS = 8_000;

export const chatRequestSchema = z.object({
  assistantId: z.uuid(),
  conversationId: z.uuid().nullable(),
  /**
   * Only used when a new conversation is created. "synthetic" requests a
   * synthetic test conversation; the server checks the user's AI test
   * access and decides the provider itself.
   */
  mode: z.enum(["standard", "synthetic"]).optional(),
  message: z.object({
    content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    /** Uploaded, ready conversation attachments (ADR-045); the server verifies ownership. */
    attachmentIds: z.array(z.uuid()).max(5).optional(),
  }),
  /**
   * Leadanalys (ADR-050): the page selection a NEW lead conversation starts from. Help only – the
   * server re-resolves it against the user's lead access, and it never widens what may be read.
   */
  leadContext: leadChatContextSchema.optional(),
  /**
   * Leadanalys: a click that needs no interpretation (continuation after a step, seller intro, a chosen
   * seller, a suggested question). Validated and re-resolved on the server like the text.
   */
  leadTurn: leadTurnSchema.optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type ChatStreamEvent =
  /** Sent first; the conversation the exchange was stored in. */
  | {
      type: "conversation";
      conversationId: string;
      title: string;
      created: boolean;
      dataClass: ConversationMode;
      /** Which engine answers: "mock" (no AI call) or "openai". */
      provider: "mock" | "openai";
      model: string | null;
    }
  /** Retrieved excerpts (may be narrowed to the cited ones in "done"). */
  | { type: "sources"; sources: MessageSource[] }
  | { type: "text"; delta: string }
  /** Final, verified answer: content without invalid citations, cited sources only. */
  | { type: "done"; content: string; sources: MessageSource[] }
  | { type: "error"; message: string };

export type ConversationMode = "standard" | "synthetic";
