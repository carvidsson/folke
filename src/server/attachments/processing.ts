import "server-only";

import { ATTACHMENT_LIMITS, type AttachmentFileType, type AttachmentKind } from "@/lib/attachments";
import { attachmentsExternalAllowed } from "@/server/ai/guard";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { embeddingModel } from "@/server/ai/models";
import { createEmbeddings } from "@/server/ai/providers/openai";
import { recordEmbeddingUsage } from "@/server/ai/usage";
import { chunkSections } from "@/server/documents/chunk";
import { assertImageSignature, extractDocument, UnsupportedDocumentError, type ImageFileType } from "@/server/documents/extract";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { ATTACHMENT_BUCKET } from "./cleanup";

/**
 * Processing of an uploaded attachment (ADR-045). Callers MUST have proven
 * that the user owns the attachment (user client + RLS). Uses the secret-key
 * client for the file and the processing fields only.
 *
 * Documents: text is extracted and chunked like the knowledge base, and
 * embedded when attachment content may go to the external provider. A PDF
 * without a text layer (e.g. scanned) is kept as a file the model reads
 * itself, within small limits; there is no separate OCR. Images: the type is
 * verified; the model receives the image itself.
 */

export interface AttachmentRow {
  id: string;
  user_id: string;
  kind: AttachmentKind;
  file_type: AttachmentFileType;
  size_bytes: number;
  storage_path: string | null;
}

export type ProcessResult = { ok: true } | { ok: false; error: string };

const EMBED_BATCH = 100;

export async function processAttachment(row: AttachmentRow): Promise<ProcessResult> {
  const admin = createSupabaseAdminClient();
  const set = (fields: Record<string, unknown>) => admin.from("conversation_attachments").update(fields).eq("id", row.id);
  await set({ status: "processing", error: null });

  try {
    if (!row.storage_path) throw new UnsupportedDocumentError("Filen kunde inte hittas.");
    const { data: file, error } = await admin.storage.from(ATTACHMENT_BUCKET).download(row.storage_path);
    if (error || !file) throw new UnsupportedDocumentError("Filen kunde inte hittas. Ladda upp den igen.");
    const max = row.kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.documentBytes;
    if (file.size > max) throw new UnsupportedDocumentError(`Filen är större än ${max / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (row.kind === "image") {
      assertImageSignature(row.file_type as ImageFileType, bytes);
      await set({ status: "ready", content_mode: "image", size_bytes: file.size });
      return { ok: true };
    }

    const extracted = await extractDocument(row.file_type as Exclude<AttachmentFileType, ImageFileType>, bytes);
    const chunks = chunkSections(extracted.sections);
    const chars = chunks.reduce((n, c) => n + c.content.length, 0);

    if (chunks.length === 0) {
      // No text layer: only small PDFs may be read by the model as files.
      if (row.file_type !== "pdf") throw new UnsupportedDocumentError("Ingen text kunde läsas ur filen.");
      if (file.size > ATTACHMENT_LIMITS.inlinePdfBytes || (extracted.pageCount ?? 0) > ATTACHMENT_LIMITS.inlinePdfPages) {
        throw new UnsupportedDocumentError(
          `PDF:en saknar läsbar text och är för stor för att läsas som bild (högst ${ATTACHMENT_LIMITS.inlinePdfPages} sidor och ${ATTACHMENT_LIMITS.inlinePdfBytes / 1024 / 1024} MB).`,
        );
      }
      await set({ status: "ready", content_mode: "pdf_inline", page_count: extracted.pageCount, char_count: 0 });
      return { ok: true };
    }
    if (chars > ATTACHMENT_LIMITS.maxTextChars) {
      throw new UnsupportedDocumentError("Dokumentet innehåller för mycket text (mer än 500 000 tecken). Dela upp det i mindre delar.");
    }

    const vectors = attachmentsExternalAllowed() ? await embed(row, chunks.map((c) => c.content)) : null;
    await admin.from("conversation_attachment_chunks").delete().eq("attachment_id", row.id);
    const model = embeddingModel();
    for (let i = 0; i < chunks.length; i += 200) {
      const { error: insertError } = await admin.from("conversation_attachment_chunks").insert(
        chunks.slice(i, i + 200).map((c) => ({
          attachment_id: row.id,
          chunk_index: c.index,
          content: c.content,
          location: c.location,
          embedding: vectors ? `[${vectors[c.index].join(",")}]` : null,
          embedding_model: vectors ? model.id : null,
        })),
      );
      if (insertError) throw new Error(insertError.message);
    }
    await set({ status: "ready", content_mode: "text", page_count: extracted.pageCount, char_count: chars });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof UnsupportedDocumentError
        ? error.message
        : error instanceof Error && /budget|minut|samtidig/i.test(error.message)
          ? error.message
          : "Filen kunde inte läsas in. Försök igen.";
    // Never the file content: only the attachment id and the error type.
    console.error("[attachments] processing failed", { attachment: row.id, error: error instanceof Error ? error.name : "unknown" });
    await set({ status: "failed", error: message });
    return { ok: false, error: message };
  }
}

/**
 * Embeddings for hybrid search within the conversation, counted as
 * attachment_indexing. Like knowledge-base indexing, only the monthly budget
 * is checked: attaching several files at once must not use up the user's
 * questions per minute. The cost is recorded on the user, so it still counts
 * towards their daily budget.
 */
async function embed(row: AttachmentRow, texts: string[]): Promise<number[][]> {
  const limit = await beginAIRequest(null, "embedding");
  if (!limit.ok) throw new Error(limit.message);
  const model = embeddingModel();
  const vectors: number[][] = [];
  let tokens = 0;
  try {
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const result = await createEmbeddings(model.id, model.dimensions, texts.slice(i, i + EMBED_BATCH));
      vectors.push(...result.vectors);
      tokens += result.tokens;
    }
    await finishAIRequest(limit.requestId, "completed");
    return vectors;
  } catch (error) {
    await finishAIRequest(limit.requestId, "failed");
    throw error;
  } finally {
    if (tokens) {
      await recordEmbeddingUsage({ userId: row.user_id, model: model.id, tokens, dataClass: "internal", purpose: "attachment_indexing" });
    }
  }
}
