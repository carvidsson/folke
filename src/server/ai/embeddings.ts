import "server-only";

import { embeddingModel } from "./models";
import { createEmbeddings } from "./providers/openai";
import { recordEmbeddingUsage } from "./usage";

/**
 * Query embedding for hybrid search. Call ONLY after the data guard allowed
 * an external call for this conversation (synthetic conversation, user with
 * AI test access). Returns null on failure: search then falls back to full
 * text, and the answer can still be generated.
 */
export async function embedQuery(
  text: string,
  meta: { userId: string; assistantId: string; conversationId: string },
  signal?: AbortSignal,
): Promise<{ vector: string; model: string } | null> {
  const model = embeddingModel();
  try {
    const { vectors, tokens } = await createEmbeddings(model.id, model.dimensions, [text.slice(0, 8000)], signal);
    await recordEmbeddingUsage({ ...meta, model: model.id, tokens });
    return { vector: `[${vectors[0].join(",")}]`, model: model.id };
  } catch (error) {
    console.error("[ai/embeddings] query embedding failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
