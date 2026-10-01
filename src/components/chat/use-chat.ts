"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { streamChat } from "@/lib/chat/client";
import type { ConversationMode } from "@/lib/chat/protocol";
import type { Attachment, Message } from "@/lib/domain/types";

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export interface OutgoingMessage {
  text: string;
  attachments: Attachment[];
}

function tempId() {
  return `tmp-${crypto.randomUUID()}`;
}

/**
 * Client-side chat state. The server stores every message; this hook mirrors
 * the stream and keeps the UI responsive. A new conversation gets its URL as
 * soon as the server has created it.
 */
export function useChat({
  assistantId,
  conversationId: initialConversationId,
  initialMessages = [],
  mode = "standard",
}: {
  assistantId: string;
  conversationId: string | null;
  initialMessages?: Message[];
  /** Requested mode for a NEW conversation (the server decides and verifies). */
  mode?: ConversationMode;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | null>(initialConversationId);
  const lastOutgoing = useRef<OutgoingMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [engine, setEngine] = useState<{ provider: "mock" | "openai"; model: string | null } | null>(null);

  const send = useCallback(
    async (outgoing: OutgoingMessage, { isRetry = false } = {}) => {
      lastOutgoing.current = outgoing;
      const reply: Message = { id: tempId(), role: "assistant", content: "", createdAt: new Date().toISOString() };
      const userMessage: Message = {
        id: tempId(),
        role: "user",
        content: outgoing.text,
        createdAt: new Date().toISOString(),
        attachments: outgoing.attachments.length ? outgoing.attachments : undefined,
      };
      setMessages((all) => [...(isRetry ? all : [...all, userMessage]), reply]);
      setStatus("submitted");
      setError(null);

      const update = (fn: (m: Message) => Message) =>
        setMessages((all) => all.map((m) => (m.id === reply.id ? fn(m) : m)));

      const controller = new AbortController();
      abortRef.current = controller;
      let createdConversation = false;

      try {
        await streamChat(
          {
            assistantId,
            conversationId: conversationId.current,
            mode: conversationId.current ? undefined : mode,
            message: {
              content: outgoing.text,
              attachments: outgoing.attachments.map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes })),
            },
          },
          (event) => {
            if (event.type === "conversation") {
              setEngine({ provider: event.provider, model: event.model });
              if (event.created) {
                conversationId.current = event.conversationId;
                createdConversation = true;
                window.history.replaceState(null, "", `/chat/${event.conversationId}`);
              }
            }
            if (event.type === "sources") update((m) => ({ ...m, sources: event.sources }));
            if (event.type === "text") {
              setStatus("streaming");
              update((m) => ({ ...m, content: m.content + event.delta }));
            }
            // The server's final version: invalid citations removed, only cited sources.
            if (event.type === "done") {
              update((m) => ({
                ...m,
                content: event.content || m.content,
                sources: event.sources.length ? event.sources : undefined,
              }));
            }
            if (event.type === "error") throw new Error(event.message);
          },
          controller.signal,
        );
        setStatus("idle");
      } catch (err) {
        if (controller.signal.aborted) {
          setMessages((all) => all.filter((m) => m.id !== reply.id || m.content));
          setStatus("idle");
        } else {
          setMessages((all) => all.filter((m) => m.id !== reply.id));
          setError(err instanceof Error ? err.message : "Något gick fel.");
          setStatus("error");
        }
      } finally {
        abortRef.current = null;
        // Refresh server components (sidebar history) once the new
        // conversation exists.
        if (createdConversation) router.refresh();
      }
    },
    [assistantId, mode, router],
  );

  /** Re-send the last message after an error (the server removed the failed question). */
  const retry = useCallback(() => {
    if (lastOutgoing.current) void send(lastOutgoing.current, { isRetry: true });
  }, [send]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return {
    messages,
    status,
    error,
    isBusy: status === "submitted" || status === "streaming",
    engine,
    send: (outgoing: OutgoingMessage) => void send(outgoing),
    retry,
    stop,
  };
}
