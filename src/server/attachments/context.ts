import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ATTACHMENT_LIMITS } from "@/lib/attachments";
import type { Attachment } from "@/lib/domain/types";
import type { AttachmentPromptInput } from "@/server/ai/prompt";
import { conversationSignals, isFollowUp, retrievalQuery } from "@/server/chat/retrieval";
import type { HistoryRow } from "@/server/chat/turn";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { ATTACHMENT_BUCKET } from "./cleanup";

/**
 * Which attachments a chat turn uses, and how (ADR-045).
 *
 * An attachment is ACTIVE in a turn when it was attached to the current
 * message, attached to one of the two previous questions and the current
 * one is a follow-up, or the question explicitly refers to attachments or
 * names the file. Only active images and image-only PDFs are sent (at most
 * 4 and 2). Active documents are sent in full when they are short together,
 * otherwise their most relevant chunks. Inactive documents only contribute
 * chunks where the question's words occur. A conversation without
 * attachments costs nothing extra.
 */

export const ATTACHMENT_BUDGET = {
  /** Active documents up to this size are sent in full. */
  fullTextChars: 24_000,
  /** Otherwise: relevant chunks of active documents. */
  activeChars: 16_000,
  /** Word matches in documents that are not active. */
  inactiveChars: 6_000,
  inactiveChunks: 6,
  images: 4,
  inlinePdfs: 2,
} as const;

interface StoredAttachment {
  id: string;
  kind: "document" | "image";
  file_name: string;
  mime_type: string;
  file_type: string;
  content_mode: "text" | "pdf_inline" | "image" | null;
  char_count: number | null;
  storage_path: string | null;
  created_at: string;
}

export interface AttachmentExcerpt {
  attachmentId: string;
  name: string;
  location: string | null;
  content: string;
}

export interface AttachmentFile {
  attachmentId: string;
  name: string;
  /** data: URL (base64) – sent inline, never uploaded to the provider. */
  dataUrl: string;
}

export interface AttachmentContext {
  excerpts: AttachmentExcerpt[];
  images: AttachmentFile[];
  pdfs: AttachmentFile[];
  /** Structured Excel exports in the conversation (ADR-055): analysed only in Analysassistenten, never as text. */
  structured: number;
  stats: { attachments: number; active: number; fullText: boolean; excerpts: number; chars: number; images: number; pdfs: number };
}

export const EMPTY_ATTACHMENT_CONTEXT: AttachmentContext = {
  excerpts: [],
  images: [],
  pdfs: [],
  structured: 0,
  stats: { attachments: 0, active: 0, fullText: false, excerpts: 0, chars: 0, images: 0, pdfs: 0 },
};

const WORD = "[\\p{L}\\p{N}]";
/** Generic references to the user's own files (not to the knowledge base). */
const REFERS_TO_ATTACHMENTS = new RegExp(
  `(?<!${WORD})(bilag\\p{L}*|bifoga\\p{L}*|uppladda\\p{L}*|laddade upp|filen|filerna|bilden|bilderna|skärmdump\\p{L}*|fotot|foton|dokumentet jag|underlaget jag|det jag skickade)(?!${WORD})`,
  "iu",
);

/** Ids of the attachments the user referred to in this message. */
export function referencedAttachments(message: string, attachments: { id: string; file_name: string }[]): Set<string> {
  if (REFERS_TO_ATTACHMENTS.test(message)) return new Set(attachments.map((a) => a.id));
  const text = message.toLowerCase();
  return new Set(
    attachments
      .filter((a) => {
        const stem = a.file_name.replace(/\.[^.]+$/, "").toLowerCase().trim();
        return stem.length >= 4 && text.includes(stem);
      })
      .map((a) => a.id),
  );
}

/** Attachments of the two previous questions (stored on the user messages). */
export function recentAttachmentIds(history: Pick<HistoryRow, "role" | "attachments">[]): Set<string> {
  const users = history.filter((r) => r.role === "user");
  const previous = users.slice(-3, -1); // the current question is the last one
  return new Set(previous.flatMap((r) => (r.attachments ?? []).flatMap((a) => (a.attachmentId ? [a.attachmentId] : []))));
}

export async function buildAttachmentContext(
  supabase: SupabaseClient,
  input: {
    conversationId: string;
    message: string;
    currentIds: string[];
    history: Pick<HistoryRow, "role" | "content" | "sources" | "attachments">[];
    /** Query embedding for hybrid search (only when attachments may go to the provider). */
    embed: ((text: string) => Promise<{ vector: string; model: string } | null>) | null;
  },
): Promise<AttachmentContext> {
  // RLS: only the owner's attachments of this conversation.
  const { data } = await supabase
    .from("conversation_attachments")
    .select("id, kind, file_name, file_type, mime_type, content_mode, char_count, storage_path, created_at")
    .eq("conversation_id", input.conversationId)
    .eq("status", "ready")
    .order("created_at", { ascending: false });
  const all = (data ?? []) as StoredAttachment[];
  if (all.length === 0) return EMPTY_ATTACHMENT_CONTEXT;

  const signals = conversationSignals(input.history);
  const followUp = isFollowUp(input.message, signals.previousUserMessage);
  const current = new Set(input.currentIds);
  const recent = followUp ? recentAttachmentIds(input.history) : new Set<string>();
  const referenced = referencedAttachments(input.message, all);
  const isActive = (a: StoredAttachment) => current.has(a.id) || recent.has(a.id) || referenced.has(a.id);
  // Current attachments first, then the most recent.
  const active = all.filter(isActive).sort((a, b) => Number(current.has(b.id)) - Number(current.has(a.id)));

  const admin = createSupabaseAdminClient();
  const asDataUrl = async (a: StoredAttachment): Promise<AttachmentFile | null> => {
    if (!a.storage_path) return null;
    const { data: file } = await admin.storage.from(ATTACHMENT_BUCKET).download(a.storage_path);
    if (!file) return null;
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return { attachmentId: a.id, name: a.file_name, dataUrl: `data:${a.mime_type};base64,${base64}` };
  };
  const [images, pdfs] = await Promise.all([
    Promise.all(active.filter((a) => a.content_mode === "image").slice(0, ATTACHMENT_BUDGET.images).map(asDataUrl)),
    Promise.all(active.filter((a) => a.content_mode === "pdf_inline").slice(0, ATTACHMENT_BUDGET.inlinePdfs).map(asDataUrl)),
  ]);

  const textDocs = all.filter((a) => a.content_mode === "text");
  const activeDocs = textDocs.filter(isActive);
  const activeChars = activeDocs.reduce((n, a) => n + (a.char_count ?? 0), 0);
  const fullText = activeDocs.length > 0 && activeChars <= ATTACHMENT_BUDGET.fullTextChars;
  const names = new Map(textDocs.map((a) => [a.id, a.file_name]));
  const excerpts: AttachmentExcerpt[] = [];

  if (fullText) {
    const { data: chunks } = await supabase
      .from("conversation_attachment_chunks")
      .select("attachment_id, chunk_index, content, location")
      .in("attachment_id", activeDocs.map((a) => a.id))
      .order("chunk_index");
    for (const doc of activeDocs) {
      for (const c of ((chunks ?? []) as { attachment_id: string; content: string; location: string | null }[]).filter((x) => x.attachment_id === doc.id)) {
        excerpts.push({ attachmentId: doc.id, name: doc.file_name, location: c.location, content: c.content });
      }
    }
  }

  // Search: relevant chunks of large active documents, and word matches in the others.
  const searchNeeded = textDocs.length > 0 && (!fullText || textDocs.length > activeDocs.length);
  if (searchNeeded) {
    const query = retrievalQuery(input.message, signals.previousUserMessage, followUp);
    const embedding = input.embed ? await input.embed(query) : null;
    const { data: hits, error } = await supabase.rpc("search_conversation_attachments", {
      p_conversation_id: input.conversationId,
      p_query: query,
      p_embedding: embedding?.vector ?? null,
      p_embedding_model: embedding?.model ?? null,
      p_limit: 60,
    });
    if (error) console.error("[attachments] search failed", error.message);
    const rows = (hits ?? []) as { attachment_id: string; chunk_index: number; content: string; location: string | null; fts_match: boolean }[];
    const activeIds = new Set(activeDocs.map((a) => a.id));
    let chars = 0;
    if (!fullText) {
      for (const r of rows.filter((x) => activeIds.has(x.attachment_id))) {
        if (chars + r.content.length > ATTACHMENT_BUDGET.activeChars) continue;
        excerpts.push({ attachmentId: r.attachment_id, name: names.get(r.attachment_id) ?? "", location: r.location, content: r.content });
        chars += r.content.length;
      }
    }
    let inactiveChars = 0;
    let inactiveCount = 0;
    for (const r of rows.filter((x) => !activeIds.has(x.attachment_id) && x.fts_match)) {
      if (inactiveCount >= ATTACHMENT_BUDGET.inactiveChunks || inactiveChars + r.content.length > ATTACHMENT_BUDGET.inactiveChars) break;
      excerpts.push({ attachmentId: r.attachment_id, name: names.get(r.attachment_id) ?? "", location: r.location, content: r.content });
      inactiveChars += r.content.length;
      inactiveCount++;
    }
  }

  const keptImages = images.filter((x): x is AttachmentFile => Boolean(x));
  const keptPdfs = pdfs.filter((x): x is AttachmentFile => Boolean(x));
  return {
    excerpts,
    images: keptImages,
    pdfs: keptPdfs,
    structured: all.filter((a) => a.file_type === "xlsx" && a.content_mode === "text" && a.char_count === 0).length,
    stats: {
      attachments: all.length,
      active: active.length,
      fullText,
      excerpts: excerpts.length,
      chars: excerpts.reduce((n, e) => n + e.content.length, 0),
      images: keptImages.length,
      pdfs: keptPdfs.length,
    },
  };
}

export interface AttachmentMeta {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: "document" | "image";
  status: string;
  conversation_id: string | null;
}

/**
 * The attachments sent with a message: the user's own (RLS), ready, and
 * either unsent or already in this conversation; within the conversation's
 * limits.
 */
export async function checkAttachments(
  supabase: SupabaseClient,
  ids: string[],
  conversationId: string | null,
): Promise<{ ok: true; rows: AttachmentMeta[] } | { ok: false; error: string }> {
  const { data } = await supabase
    .from("conversation_attachments")
    .select("id, file_name, mime_type, size_bytes, kind, status, conversation_id")
    .in("id", ids);
  const rows = (data ?? []) as AttachmentMeta[];
  const usable = rows.filter((r) => r.status === "ready" && (r.conversation_id === null || r.conversation_id === conversationId));
  if (usable.length !== ids.length) return { ok: false, error: "En eller flera bilagor kunde inte användas. Ladda upp dem igen." };
  if (conversationId) {
    const { data: existing } = await supabase
      .from("conversation_attachments")
      .select("id, size_bytes")
      .eq("conversation_id", conversationId);
    const all = new Map(((existing ?? []) as { id: string; size_bytes: number }[]).map((r) => [r.id, Number(r.size_bytes)]));
    for (const r of rows) all.set(r.id, Number(r.size_bytes));
    if (all.size > ATTACHMENT_LIMITS.perConversation) {
      return { ok: false, error: `En konversation kan ha högst ${ATTACHMENT_LIMITS.perConversation} bilagor.` };
    }
    if ([...all.values()].reduce((a, b) => a + b, 0) > ATTACHMENT_LIMITS.conversationBytes) {
      return { ok: false, error: "Konversationens bilagor får tillsammans vara högst 100 MB." };
    }
  }
  return { ok: true, rows };
}

/** The prompt section for this turn, or null when no attachment is used. */
export function attachmentPrompt(ctx: AttachmentContext): AttachmentPromptInput | null {
  if (!ctx.excerpts.length && !ctx.images.length && !ctx.pdfs.length && !ctx.structured) return null;
  return {
    structured: ctx.structured,
    excerpts: ctx.excerpts.map(({ name, location, content }) => ({ name, location, content })),
    files: [
      ...ctx.images.map((f) => ({ name: f.name, kind: "bild" as const })),
      ...ctx.pdfs.map((f) => ({ name: f.name, kind: "pdf" as const })),
    ],
  };
}

/** Metadata stored on the user message (no content). */
export function messageAttachments(rows: { id: string; file_name: string; mime_type: string; size_bytes: number; kind: "document" | "image" }[]): Omit<Attachment, "id">[] {
  return rows.map((r) => ({ attachmentId: r.id, name: r.file_name, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes), kind: r.kind }));
}
