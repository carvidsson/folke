"use server";

import { z } from "zod";

import { ATTACHMENT_LIMITS, attachmentProblem, attachmentType, type AttachmentKind, type AttachmentStatus } from "@/lib/attachments";
import { safeObjectName } from "@/lib/files";
import type { ActionResult } from "@/server/admin/actions";
import { attachmentsEnabled } from "@/server/ai/guard";
import { getSession } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { ATTACHMENT_BUCKET, cleanUpAttachmentFiles } from "./cleanup";
import { processAttachment, type AttachmentRow } from "./processing";

/**
 * Conversation attachments (ADR-045). Every action proves ownership with
 * the user's own client (RLS: owner only) before the secret-key client
 * touches Storage or processing fields. Disabled unless FOLKE_AI_ATTACHMENTS
 * is "on". Errors are in Swedish; logs never contain file names or content.
 */

const DISABLED = "Bilagor är inte aktiverade.";

const createSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  /** The conversation the file will be sent in, if it already exists (for its limits). */
  conversationId: z.uuid().nullable(),
});

export type CreateAttachmentResult =
  | { ok: true; attachmentId: string; kind: AttachmentKind; path: string; token: string }
  | { ok: false; error: string };

/** Step 1: the attachment row and a one-time signed upload URL. */
export async function createAttachmentUploadAction(input: z.input<typeof createSchema>): Promise<CreateAttachmentResult> {
  const { user } = await getSession();
  if (!attachmentsEnabled()) return { ok: false, error: DISABLED };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Ogiltig fil." };
  const v = parsed.data;
  const problem = attachmentProblem(v.fileName, v.sizeBytes);
  const info = attachmentType(v.fileName);
  if (problem || !info) return { ok: false, error: problem ?? "Filtypen stöds inte." };

  const supabase = await createSupabaseServerClient();
  if (v.conversationId) {
    const { data: existing } = await supabase
      .from("conversation_attachments")
      .select("size_bytes")
      .eq("conversation_id", v.conversationId);
    const rows = (existing ?? []) as { size_bytes: number }[];
    if (rows.length >= ATTACHMENT_LIMITS.perConversation) {
      return { ok: false, error: `En konversation kan ha högst ${ATTACHMENT_LIMITS.perConversation} bilagor.` };
    }
    if (rows.reduce((n, r) => n + Number(r.size_bytes), 0) + v.sizeBytes > ATTACHMENT_LIMITS.conversationBytes) {
      return { ok: false, error: "Konversationens bilagor får tillsammans vara högst 100 MB." };
    }
  }

  const { data: row, error } = await supabase
    .from("conversation_attachments")
    .insert({ kind: info.kind, file_name: v.fileName, file_type: info.fileType, mime_type: info.mime, size_bytes: v.sizeBytes })
    .select("id")
    .single<{ id: string }>();
  if (error || !row) {
    console.error("[attachments] insert failed", error?.message);
    return { ok: false, error: "Bilagan kunde inte förberedas." };
  }

  const admin = createSupabaseAdminClient();
  const path = `${user.id}/${row.id}/${safeObjectName(v.fileName)}`;
  const { data: signed, error: signError } = await admin.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
  if (signError || !signed) {
    await supabase.from("conversation_attachments").delete().eq("id", row.id);
    return { ok: false, error: "Uppladdningen kunde inte förberedas." };
  }
  await admin.from("conversation_attachments").update({ storage_path: path }).eq("id", row.id);
  return { ok: true, attachmentId: row.id, kind: info.kind, path, token: signed.token };
}

async function ownAttachment(attachmentId: string) {
  if (!z.uuid().safeParse(attachmentId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("conversation_attachments")
    .select("id, user_id, kind, file_type, size_bytes, storage_path, status, conversation_id, file_name")
    .eq("id", attachmentId)
    .maybeSingle<AttachmentRow & { status: AttachmentStatus; conversation_id: string | null; file_name: string }>();
  return data;
}

/** Step 2 (after the browser uploaded the file): verify and read it. */
export async function processAttachmentAction(attachmentId: string): Promise<ActionResult> {
  const { user } = await getSession();
  if (!attachmentsEnabled()) return { ok: false, error: DISABLED };
  const row = await ownAttachment(attachmentId);
  if (!row || row.user_id !== user.id) return { ok: false, error: "Bilagan hittades inte." };
  if (row.status === "ready") return { ok: true };
  const result = await processAttachment(row);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Removes an attachment and its file. A sent message keeps a "removed" note. */
export async function removeAttachmentAction(attachmentId: string): Promise<ActionResult> {
  await getSession();
  if (!z.uuid().safeParse(attachmentId).success) return { ok: false, error: "Ogiltig bilaga." };
  const supabase = await createSupabaseServerClient();
  // RLS: only the owner's row can be deleted; the trigger queues the file.
  const { count, error } = await supabase.from("conversation_attachments").delete({ count: "exact" }).eq("id", attachmentId);
  if (error || !count) return { ok: false, error: "Bilagan kunde inte tas bort." };
  await cleanUpAttachmentFiles();
  return { ok: true, message: "Bilagan har tagits bort." };
}

export interface ConversationAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  createdAt: string;
}

/** The attachments of one of the user's own conversations (RLS: owner only). */
export async function listConversationAttachmentsAction(conversationId: string): Promise<ConversationAttachment[]> {
  await getSession();
  if (!z.uuid().safeParse(conversationId).success) return [];
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("conversation_attachments")
    .select("id, file_name, kind, mime_type, size_bytes, status, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at");
  return ((data ?? []) as { id: string; file_name: string; kind: AttachmentKind; mime_type: string; size_bytes: number; status: AttachmentStatus; created_at: string }[]).map(
    (r) => ({ id: r.id, name: r.file_name, kind: r.kind, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes), status: r.status, createdAt: r.created_at }),
  );
}
