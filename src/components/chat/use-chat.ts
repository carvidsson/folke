"use client";

import { useCallback, useRef, useState } from "react";

import { streamChat } from "@/lib/chat/client";
import type { Attachment, Message } from "@/lib/domain/types";

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export interface OutgoingMessage {
  text: string;
  attachments: Attachment[];
}

function newId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Client-side chat state. Messages live in memory only – nothing is persisted
 * in the prototype. When a backend exists, the server stores messages and this
 * hook only mirrors the stream.
 */
export function useChat({
  assistantId,
  conversationId,
  initialMessages = [],
}: {
  assistantId: string;
  conversationId: string | null;
  initialMessages?: Message[];
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (history: Message[]) => {
      const reply: Message = {
        id: newId("msg"),
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      };
      setMessages([...history, reply]);
      setStatus("submitted");
      setError(null);

      const update = (fn: (m: Message) => Message) =>
        setMessages((all) => all.map((m) => (m.id === reply.id ? fn(m) : m)));

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          {
            assistantId,
            conversationId,
            messages: history.map(({ role, content, attachments }) => ({
              role,
              content,
              attachments: attachments?.map(({ name, mimeType, sizeBytes }) => ({
                name,
                mimeType,
                sizeBytes,
              })),
            })),
          },
          (event) => {
            if (event.type === "sources") update((m) => ({ ...m, sources: event.sources }));
            if (event.type === "text") {
              setStatus("streaming");
              update((m) => ({ ...m, content: m.content + event.delta }));
            }
            if (event.type === "error") throw new Error(event.message);
          },
          controller.signal,
        );
        setStatus("idle");
      } catch (err) {
        if (controller.signal.aborted) {
          // Keep whatever was streamed; drop the reply if nothing arrived.
          setMessages((all) => all.filter((m) => m.id !== reply.id || m.content));
          setStatus("idle");
          return;
        }
        setMessages((all) => all.filter((m) => m.id !== reply.id));
        setError(err instanceof Error ? err.message : "Något gick fel.");
        setStatus("error");
      } finally {
        abortRef.current = null;
      }
    },
    [assistantId, conversationId],
  );

  const send = useCallback(
    (outgoing: OutgoingMessage) => {
      const userMessage: Message = {
        id: newId("msg"),
        role: "user",
        content: outgoing.text,
        createdAt: new Date().toISOString(),
        attachments: outgoing.attachments.length ? outgoing.attachments : undefined,
      };
      void run([...messages, userMessage]);
    },
    [messages, run],
  );

  /** Re-run the last request after an error. */
  const retry = useCallback(() => {
    if (messages.at(-1)?.role === "user") void run(messages);
  }, [messages, run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return {
    messages,
    status,
    error,
    isBusy: status === "submitted" || status === "streaming",
    send,
    retry,
    stop,
  };
}
