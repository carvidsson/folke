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
  | { type: "conversation"; conversationId: string; title: string; created: boolean }
  | { type: "sources"; sources: SourceReference[] }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };
