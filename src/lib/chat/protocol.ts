import { z } from "zod";

import type { SourceReference } from "@/lib/domain/types";

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
    attachments: z
      .array(
        z.object({
          name: z.string().max(255),
          mimeType: z.string().max(255),
          sizeBytes: z.number().int().nonnegative(),
        }),
      )
      .max(5)
      .optional(),
  }),
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
  | { type: "sources"; sources: SourceReference[] }
  | { type: "text"; delta: string }
  /** Final, verified answer: content without invalid citations, cited sources only. */
  | { type: "done"; content: string; sources: SourceReference[] }
  | { type: "error"; message: string };

export type ConversationMode = "standard" | "synthetic";
