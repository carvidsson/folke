"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { DocumentFileType } from "@/lib/domain/types";
import { safeObjectName } from "@/lib/files";
import type { ActionResult } from "@/server/admin/actions";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { chunkSections } from "./chunk";
import { extractDocument, UnsupportedDocumentError } from "./extract";

/**
 * Document lifecycle. Permission checks happen in the database: every write
 * that expresses a user decision goes through the user's own client (RLS +
 * triggers). The secret-key client is only used for storage and for writing
 * processing results, after the user client has proven access to the row.
 */

const BUCKET = "documents";
const MAX_BYTES = 50 * 1024 * 1024;

const FILE_TYPES: Record<string, { type: DocumentFileType; mime: string }> = {
  pdf: { type: "pdf", mime: "application/pdf" },
  docx: { type: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { type: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { type: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  txt: { type: "txt", mime: "text/plain" },
  md: { type: "md", mime: "text/markdown" },
  csv: { type: "csv", mime: "text/csv" },
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const uploadSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().positive().max(MAX_BYTES),
    title: z.string().trim().min(1).max(200),
    collectionId: z.uuid(),
    ownerGroupId: z.uuid(),
    shareGroupIds: z.array(z.uuid()).max(50),
    assistantIds: z.array(z.uuid()).min(1).max(10),
    validFrom: date,
    validUntil: date.nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(10),
    /** Pilot policy: internal documents without customer data only. */
    internalOnly: z.literal(true),
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.validFrom, { message: "validity" });

export type UploadRequest = z.input<typeof uploadSchema>;

export type CreateUploadResult =
  | { ok: true; documentId: string; path: string; token: string }
  | { ok: false; error: string };

function fileInfo(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPES[ext] ?? null;
}

/** Step 1: create the document row and a one-time signed upload URL. */
export async function createDocumentUploadAction(input: UploadRequest): Promise<CreateUploadResult> {
  const session = await getSession();
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Kontrollera uppgifterna i formuläret." };
  const v = parsed.data;
  const info = fileInfo(v.fileName);
  if (!info) return { ok: false, error: "Filtypen stöds inte. Använd PDF, Word, Excel, PowerPoint, text, Markdown eller CSV." };

  const supabase = await createSupabaseServerClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .insert({
      title: v.title,
      file_name: v.fileName,
      mime_type: info.mime,
      file_type: info.type,
      size_bytes: v.sizeBytes,
      collection_id: v.collectionId,
      owner_group_id: v.ownerGroupId,
      valid_from: v.validFrom,
      valid_until: v.validUntil,
      tags: v.tags,
      internal_only_attested_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !doc) {
    console.error("[documents] insert failed", error?.message);
    return { ok: false, error: "Du saknar behörighet att ladda upp dokument till den gruppen." };
  }

  const extraShares = v.shareGroupIds.filter((g) => g !== v.ownerGroupId);
  const [shares, links] = await Promise.all([
    extraShares.length
      ? supabase.from("document_shares").insert(extraShares.map((group_id) => ({ document_id: doc.id, group_id })))
      : Promise.resolve({ error: null }),
    supabase.from("document_assistants").insert(v.assistantIds.map((assistant_id) => ({ document_id: doc.id, assistant_id }))),
  ]);
  if (shares.error || links.error) {
    await supabase.from("documents").delete().eq("id", doc.id);
    return { ok: false, error: "Delningen kunde inte sparas. Du kan bara dela med dina egna grupper." };
  }

  const admin = createSupabaseAdminClient();
  const path = `${doc.id}/${safeObjectName(v.fileName)}`;
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (signError || !signed) {
    await supabase.from("documents").delete().eq("id", doc.id);
    return { ok: false, error: "Uppladdningen kunde inte förberedas." };
  }
  await admin.from("documents").update({ storage_path: path }).eq("id", doc.id);

  await logSecurityEvent("document.uploaded", {
    actorId: session.user.id,
    targetType: "documents",
    targetId: doc.id,
    metadata: { fileType: info.type, sizeBytes: v.sizeBytes },
  });
  return { ok: true, documentId: doc.id, path, token: signed.token };
}

/** Step 2 (after the browser uploaded the file): verify and process. */
export async function processDocumentAction(documentId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!z.uuid().safeParse(documentId).success) return { ok: false, error: "Ogiltigt dokument." };

  // Proves the caller uploaded this document (RLS + explicit uploader check).
  const supabase = await createSupabaseServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id, file_type, storage_path, size_bytes, processing_status, uploaded_by")
    .eq("id", documentId)
    .maybeSingle<{
      id: string;
      file_type: DocumentFileType;
      storage_path: string | null;
      size_bytes: number;
      processing_status: string;
      uploaded_by: string;
    }>();
  if (!doc || doc.uploaded_by !== session.user.id || !doc.storage_path) {
    return { ok: false, error: "Dokumentet hittades inte." };
  }
  if (doc.processing_status === "ready") return { ok: true };

  const admin = createSupabaseAdminClient();
  const setStatus = (fields: Record<string, unknown>) => admin.from("documents").update(fields).eq("id", doc.id);
  await setStatus({ processing_status: "processing", processing_error: null });

  try {
    const { data: file, error } = await admin.storage.from(BUCKET).download(doc.storage_path);
    if (error || !file) throw new UnsupportedDocumentError("Filen kunde inte hittas i lagringen.");
    if (file.size > MAX_BYTES) throw new UnsupportedDocumentError("Filen är större än 50 MB.");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractDocument(doc.file_type, bytes);
    const chunks = chunkSections(extracted.sections);
    if (chunks.length === 0) {
      throw new UnsupportedDocumentError("Ingen text kunde läsas ur filen. Skannade dokument stöds inte ännu.");
    }

    await admin.from("document_chunks").delete().eq("document_id", doc.id);
    for (let i = 0; i < chunks.length; i += 200) {
      const { error: insertError } = await admin.from("document_chunks").insert(
        chunks.slice(i, i + 200).map((c) => ({
          document_id: doc.id,
          chunk_index: c.index,
          content: c.content,
          location: c.location,
        })),
      );
      if (insertError) throw new Error(insertError.message);
    }

    await setStatus({
      processing_status: "ready",
      page_count: extracted.pageCount,
      char_count: chunks.reduce((n, c) => n + c.content.length, 0),
    });
    await logSecurityEvent("document.processed", {
      actorId: session.user.id,
      targetType: "documents",
      targetId: doc.id,
      metadata: { chunks: chunks.length },
    });
    revalidatePath("/knowledge");
    return { ok: true, message: "Dokumentet är uppladdat och väntar på granskning." };
  } catch (error) {
    const message =
      error instanceof UnsupportedDocumentError ? error.message : "Texten kunde inte läsas ur dokumentet.";
    console.error("[documents] processing failed", error);
    await setStatus({ processing_status: "failed", processing_error: message });
    revalidatePath("/knowledge");
    return { ok: false, error: message };
  }
}

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected", "archived", "pending"]),
  comment: z.string().trim().max(500).optional(),
});

/** Approve, reject, archive or reopen. Only reviewers pass RLS/trigger checks. */
export async function reviewDocumentAction(
  documentId: string,
  input: z.input<typeof reviewSchema>,
): Promise<ActionResult> {
  await getSession();
  const parsed = reviewSchema.safeParse(input);
  if (!z.uuid().safeParse(documentId).success || !parsed.success) return { ok: false, error: "Ogiltigt beslut." };
  if (parsed.data.decision === "rejected" && !parsed.data.comment) {
    return { ok: false, error: "Ange en motivering när du avvisar ett dokument." };
  }

  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("documents")
    .update({ review_status: parsed.data.decision, review_comment: parsed.data.comment ?? null }, { count: "exact" })
    .eq("id", documentId);
  if (error) {
    return {
      ok: false,
      error: error.message.startsWith("Dokumentet kan godkännas")
        ? error.message
        : "Du saknar behörighet att granska dokumentet.",
    };
  }
  if (!count) return { ok: false, error: "Du saknar behörighet att granska dokumentet." };

  revalidatePath("/knowledge");
  const messages = {
    approved: "Dokumentet är godkänt och kan nu användas som källa.",
    rejected: "Dokumentet har avvisats.",
    archived: "Dokumentet har arkiverats och används inte längre som källa.",
    pending: "Dokumentet har återställts till granskning.",
  };
  return { ok: true, message: messages[parsed.data.decision] };
}

export async function deleteDocumentAction(documentId: string): Promise<ActionResult> {
  await getSession();
  if (!z.uuid().safeParse(documentId).success) return { ok: false, error: "Ogiltigt dokument." };
  const supabase = await createSupabaseServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle<{ storage_path: string | null }>();
  const { error, count } = await supabase.from("documents").delete({ count: "exact" }).eq("id", documentId);
  if (error || !count) return { ok: false, error: "Du saknar behörighet att ta bort dokumentet." };

  if (doc?.storage_path) {
    await createSupabaseAdminClient().storage.from(BUCKET).remove([doc.storage_path]);
  }
  revalidatePath("/knowledge");
  return { ok: true, message: "Dokumentet har tagits bort." };
}

/** Short-lived download link, only for documents the caller may see. */
export async function getDownloadUrlAction(
  documentId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await getSession();
  if (!z.uuid().safeParse(documentId).success) return { ok: false, error: "Ogiltigt dokument." };
  const supabase = await createSupabaseServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id, storage_path, file_name")
    .eq("id", documentId)
    .maybeSingle<{ id: string; storage_path: string | null; file_name: string }>();
  if (!doc?.storage_path) return { ok: false, error: "Dokumentet hittades inte." };

  const { data, error } = await createSupabaseAdminClient()
    .storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, 60, { download: doc.file_name });
  if (error || !data) return { ok: false, error: "Nedladdningen kunde inte förberedas." };

  await logSecurityEvent("document.downloaded", {
    actorId: session.user.id,
    targetType: "documents",
    targetId: doc.id,
  });
  return { ok: true, url: data.signedUrl };
}
