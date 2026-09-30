import "server-only";

import { CANNED_REPLIES, type CannedReply } from "@/mocks/responses";

import type { AIProvider, ChatCompletionInput } from "../types";

/**
 * Mock provider: streams canned Swedish replies with realistic pacing.
 * Makes no network calls and needs no API key.
 */

function pickReply(assistantId: string, prompt: string): CannedReply | null {
  const replies = CANNED_REPLIES[assistantId];
  if (!replies?.length) return null;
  const text = prompt.toLowerCase();
  return (
    replies.find((r) => r.keywords.some((k) => text.includes(k))) ??
    replies.find((r) => r.keywords.length === 0) ??
    replies[0]
  );
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** Splits text into small word-ish chunks to imitate token streaming. */
function chunk(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

export const mockProvider: AIProvider = {
  id: "mock",

  async *streamChat({ assistant, messages, signal }: ChatCompletionInput) {
    const prompt = messages.findLast((m) => m.role === "user")?.content ?? "";
    const reply = pickReply(assistant.id, prompt);

    // Simulated "thinking" / retrieval latency.
    await sleep(900, signal);

    if (!reply) {
      yield { type: "text", delta: "Jag har inget svar att visa i prototypen." };
      yield { type: "done" };
      return;
    }

    if (reply.sources.length) yield { type: "sources", sources: reply.sources };

    for (const piece of chunk(reply.content)) {
      await sleep(18 + Math.random() * 30, signal);
      yield { type: "text", delta: piece };
    }
    yield { type: "done" };
  },
};
