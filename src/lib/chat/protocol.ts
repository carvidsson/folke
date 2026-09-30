import { z } from "zod";

import type { SourceReference } from "@/lib/domain/types";

/**
 * Wire protocol between the chat UI and POST /api/chat.
 *
 * Request: JSON validated by `chatRequestSchema`.
 * Response: newline-delimited JSON (NDJSON), one `ChatStreamEvent` per line.
 *
 * Kept provider-neutral on purpose: whichever AI provider is chosen, the
 * server adapts its output to these events and the UI stays unchanged.
 */

export const chatRequestSchema = z.object({
  assistantId: z.string().min(1),
  conversationId: z.string().min(1).nullable(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20_000),
        attachments: z
          .array(
            z.object({
              name: z.string().max(255),
              mimeType: z.string().max(255),
              sizeBytes: z.number().int().nonnegative(),
            }),
          )
          .max(10)
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type ChatStreamEvent =
  | { type: "sources"; sources: SourceReference[] }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };
