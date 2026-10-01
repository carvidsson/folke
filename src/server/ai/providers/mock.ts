import "server-only";

import type { AIProvider, ChatCompletionInput, ContextChunk } from "../types";

/**
 * Mock provider – makes no network calls and sends no data anywhere.
 *
 * It answers "extractively": it quotes the most relevant retrieved excerpts
 * with correct [n] citations. That exercises the whole pipeline (access
 * control, retrieval, citations, persistence, cost tracking) without an AI
 * vendor, which is required until a vendor is approved.
 */

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

function firstSentences(text: string, max = 240) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return `${end > 80 ? cut.slice(0, end + 1) : cut.trimEnd()}…`;
}

export function composeMockAnswer(context: ContextChunk[]): string {
  const note =
    "_Mockläge: inget AI-anrop görs. Svaret består av utdrag ur kunskapsbanken som matchar din fråga._";
  if (!context.length) {
    return `${note}\n\nJag hittade inga godkända dokument som matchar frågan och som du har behörighet till. Prova andra sökord, eller be en ansvarig att ladda upp och godkänna underlag.`;
  }
  const lines = context
    .slice(0, 4)
    .map((c) => `- **${c.title}**${c.location ? ` (${c.location})` : ""}: ${firstSentences(c.snippet || c.content, 320)} [${c.index}]`);
  return `${note}\n\nFöljande avsnitt är mest relevanta:\n\n${lines.join("\n")}`;
}

/** Rough token estimate (≈4 characters per token) for usage tracking. */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export const mockProvider: AIProvider = {
  id: "mock",

  async *streamChat({ system, messages, context, signal }: ChatCompletionInput) {
    await sleep(500, signal);
    const answer = composeMockAnswer(context);
    for (const piece of answer.match(/\S+\s*|\s+/g) ?? [answer]) {
      await sleep(12, signal);
      yield { type: "text", delta: piece };
    }
    yield {
      type: "usage",
      model: "mock",
      inputTokens: estimateTokens(system + messages.map((m) => m.content).join("\n")),
      outputTokens: estimateTokens(answer),
    };
  },
};
