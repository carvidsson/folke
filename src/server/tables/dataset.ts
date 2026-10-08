import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ATTACHMENT_BUCKET } from "@/server/attachments/cleanup";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { buildDataset, type Dataset } from "./analyses";
import { parseScaniaExport, type ScaniaFile } from "./scania";

/**
 * The structured Excel attachments of a conversation (ADR-055). The user's own client lists them, so
 * RLS proves ownership before anything else; only then does the secret-key client download the stored
 * originals. Nothing derived is stored: the table is parsed from the original, and kept in memory per
 * attachment for a while so an unchanged file is not parsed again every turn. Deleting the attachment
 * (or the conversation) removes all there is.
 */

interface StoredTable {
  id: string;
  file_name: string;
  size_bytes: number;
  storage_path: string | null;
  char_count: number | null;
  created_at: string;
}

const CACHE_MS = 30 * 60_000;
const CACHE_MAX = 40;
/** Parsed files (or null: not a Scania export), by attachment id, size and path. */
const cache = new Map<string, { at: number; file: ScaniaFile | null }>();

function cached(key: string) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) return undefined;
  return hit.file;
}

function remember(key: string, file: ScaniaFile | null) {
  cache.set(key, { at: Date.now(), file });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export interface TableDataset extends Dataset {
  attachmentIds: string[];
}

/**
 * The conversation's Scania exports, oldest upload first (so "Fil 1" and "Fordon 1" stay the same
 * when more files are added). Null when it has none – then the ordinary chat handles the turn.
 */
export async function loadTableDataset(supabase: SupabaseClient, conversationId: string): Promise<TableDataset | null> {
  // RLS: only the owner's attachments of this conversation.
  const { data, error } = await supabase
    .from("conversation_attachments")
    .select("id, file_name, size_bytes, storage_path, char_count, created_at")
    .eq("conversation_id", conversationId)
    .eq("status", "ready")
    .eq("file_type", "xlsx")
    .order("created_at", { ascending: true })
    .returns<StoredTable[]>();
  if (error) {
    console.error("[tables] could not list attachments", error.code);
    return null;
  }
  if (!data?.length) return null;

  const admin = createSupabaseAdminClient();
  const files: ScaniaFile[] = [];
  const ids: string[] = [];
  for (const row of data) {
    if (!row.storage_path) continue;
    const key = `${row.id}:${row.size_bytes}:${row.storage_path}`;
    let file = cached(key);
    if (file === undefined) {
      const { data: blob } = await admin.storage.from(ATTACHMENT_BUCKET).download(row.storage_path);
      if (!blob) continue;
      file = await parseScaniaExport(new Uint8Array(await blob.arrayBuffer()), row.file_name);
      remember(key, file);
    }
    if (!file) continue;
    // Uploaded before structured analysis existed: its text chunks (raw rows) are removed, so the
    // ordinary attachment search can never send them.
    if ((row.char_count ?? 0) > 0) await removeTextChunks(row.id);
    const n = files.length + 1;
    files.push({ ...file, transactions: file.transactions.map((t) => ({ ...t, file: n, id: `${n}:${t.row}` })) });
    ids.push(row.id);
  }
  if (!files.length) return null;
  return { ...buildDataset(files), attachmentIds: ids };
}

/** Called only for an attachment the user's client just listed (ownership proven). */
export async function removeTextChunks(attachmentId: string) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("conversation_attachment_chunks").delete().eq("attachment_id", attachmentId);
  if (!error) await admin.from("conversation_attachments").update({ char_count: 0 }).eq("id", attachmentId);
  else console.error("[tables] could not remove text chunks", { attachment: attachmentId, code: error.code });
}

/** Only for tests. */
export function clearTableCache() {
  cache.clear();
}
