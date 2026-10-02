import "server-only";

import type { SourceReference } from "@/lib/domain/types";
import { stripCitationMarkers } from "@/server/ai/citations";
import { stockholmDate } from "@/server/ai/prompt";
import type { ContextChunk, ProviderMessage } from "@/server/ai/types";

/**
 * Pure helpers for one chat turn (kept separate from the route handler so
 * they can be unit tested).
 */

export interface SearchRow {
  chunk_id: number;
  document_id: string;
  title: string;
  content: string;
  location: string | null;
  ai_data_class: "internal" | "synthetic" | "approved";
  snippet?: string | null;
  /** Document metadata (search_document_context). */
  chunk_index?: number;
  valid_from?: string | null;
  valid_until?: string | null;
  uploaded_at?: string | null;
  /** Re-read because an earlier answer in the conversation cited it. */
  reused?: boolean;
}

/** Query-focused excerpt for source cards (falls back to the chunk start). */
export function excerptFor(snippet: string | null, content: string) {
  const text = (snippet?.trim() || content).replace(/\s+/g, " ");
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

export function toContext(rows: SearchRow[]): { context: ContextChunk[]; sources: SourceReference[] } {
  return {
    context: rows.map((c, i) => ({
      index: i + 1,
      documentId: c.document_id,
      title: c.title,
      content: c.content,
      location: c.location,
      snippet: c.snippet?.trim() || null,
      dataClass: c.ai_data_class,
      validFrom: c.valid_from ?? null,
      validUntil: c.valid_until ?? null,
      uploadedAt: c.uploaded_at ? stockholmDate(new Date(c.uploaded_at)) : null,
      reused: c.reused ?? false,
    })),
    sources: rows.map((c) => ({
      id: String(c.chunk_id),
      documentId: c.document_id,
      title: c.title,
      excerpt: excerptFor(c.snippet ?? null, c.content),
      location: c.location,
    })),
  };
}

export interface HistoryRow extends ProviderMessage {
  sources: SourceReference[] | null;
}

/**
 * Earlier answers are only sent again if every document they were based on
 * is still readable by the user. Otherwise a revoked or removed document
 * could reach the model through an old answer.
 *
 * Source markers are removed from earlier answers: their numbers referred
 * to that turn's sources, and an earlier answer is never a source in itself
 * (the chunks it cited are re-read instead, see ./retrieval.ts).
 */
export function filterHistory(rows: HistoryRow[], readableDocumentIds: Set<string>): ProviderMessage[] {
  return rows
    .filter((m) => m.role !== "assistant" || (m.sources ?? []).every((s) => readableDocumentIds.has(s.documentId)))
    .map(({ role, content }) => ({ role, content: role === "assistant" ? stripCitationMarkers(content) : content }));
}

/** Sources of the cited excerpts, in citation order. */
export function citedSources(sources: SourceReference[], cited: number[]): SourceReference[] {
  return cited.flatMap((n) => (sources[n - 1] ? [sources[n - 1]] : []));
}
