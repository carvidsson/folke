import "server-only";

import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { AIProviderError } from "./errors";
import { DataGuardError, assertEmbeddable } from "./guard";
import { beginAIRequest, finishAIRequest } from "./limits";
import { embeddingModel } from "./models";
import { createEmbeddings } from "./providers/openai";
import { recordEmbeddingUsage } from "./usage";

/**
 * Embedding indexing for documents approved for OpenAI (and synthetic test
 * documents). Callers MUST have checked that the user may trigger it
 * (system administrator). Uses the secret-key client for chunk embeddings
 * and index status, which users cannot write.
 *
 * Only the chunk text is sent – no titles, ids, user data or metadata.
 * The database rejects embeddings for documents that are not approved or
 * synthetic, also if the document is revoked while indexing runs.
 */

const BATCH = 100;

export interface IndexResult {
  status: "ready" | "failed";
  chunks: number;
  tokens: number;
  error?: string;
}

function indexErrorMessage(error: unknown): string {
  if (error instanceof DataGuardError) return "Dokumentet är inte godkänt för OpenAI.";
  if (error instanceof AIProviderError) return error.userMessage;
  const message = error instanceof Error ? error.message : "";
  if (/budget|minut|samtidig/i.test(message)) return message;
  if (/godkända för OpenAI|syntetiska/.test(message)) return "Godkännandet återkallades under indexeringen.";
  return "Indexeringen misslyckades. Försök igen.";
}

export async function indexDocument(documentId: string, actorId: string): Promise<IndexResult> {
  const admin = createSupabaseAdminClient();
  const model = embeddingModel();
  const { data: doc } = await admin
    .from("documents")
    .select("id, ai_data_class, processing_status")
    .eq("id", documentId)
    .maybeSingle<{ id: string; ai_data_class: string; processing_status: string }>();
  if (!doc) return { status: "failed", chunks: 0, tokens: 0, error: "Dokumentet hittades inte." };

  const setStatus = (fields: Record<string, unknown>) =>
    admin.from("documents").update(fields).eq("id", documentId).eq("ai_data_class", doc.ai_data_class);

  let requestId: string | null = null;
  let tokens = 0;
  let embedded = 0;
  try {
    assertEmbeddable([doc]);
    await setStatus({ ai_index_status: "indexing", ai_index_error: null });

    const { data: rows, error } = await admin
      .from("document_chunks")
      .select("id, content, embedding_model, embedded_at")
      .eq("document_id", documentId)
      .order("chunk_index");
    if (error) throw new Error(error.message);
    const pending = ((rows ?? []) as { id: number; content: string; embedding_model: string | null; embedded_at: string | null }[])
      .filter((c) => !c.embedded_at || c.embedding_model !== model.id);

    if (pending.length) {
      // Indexing is checked against the monthly budget (not the per-user
      // chat limits); usage is recorded on the administrator who started it.
      const limit = await beginAIRequest(null, "embedding");
      if (!limit.ok) throw new Error(limit.message);
      requestId = limit.requestId;

      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const result = await createEmbeddings(model.id, model.dimensions, batch.map((c) => c.content));
        tokens += result.tokens;
        await recordEmbeddingUsage({
          userId: actorId,
          model: model.id,
          tokens: result.tokens,
          dataClass: doc.ai_data_class === "synthetic" ? "synthetic" : "internal",
          purpose: "indexing",
        });
        for (const [j, chunk] of batch.entries()) {
          const { error: updateError } = await admin
            .from("document_chunks")
            .update({
              embedding: `[${result.vectors[j].join(",")}]`,
              embedding_model: model.id,
              embedded_at: new Date().toISOString(),
            })
            .eq("id", chunk.id);
          if (updateError) throw new Error(updateError.message);
          embedded++;
        }
      }
    }

    await setStatus({ ai_index_status: "ready", ai_index_error: null, ai_indexed_at: new Date().toISOString() });
    if (requestId) await finishAIRequest(requestId, "completed");
    return { status: "ready", chunks: embedded, tokens };
  } catch (error) {
    const message = indexErrorMessage(error);
    console.error("[ai/indexing] failed", error instanceof Error ? error.name : "unknown");
    await setStatus({ ai_index_status: "failed", ai_index_error: message });
    if (requestId) await finishAIRequest(requestId, "failed");
    return { status: "failed", chunks: embedded, tokens, error: message };
  }
}
