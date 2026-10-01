import "server-only";

import type { SourceReference } from "@/lib/domain/types";
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
  snippet: string | null;
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
    })),
    sources: rows.map((c) => ({
      id: String(c.chunk_id),
      documentId: c.document_id,
      title: c.title,
      excerpt: excerptFor(c.snippet, c.content),
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
 */
export function filterHistory(rows: HistoryRow[], readableDocumentIds: Set<string>): ProviderMessage[] {
  return rows
    .filter((m) => m.role !== "assistant" || (m.sources ?? []).every((s) => readableDocumentIds.has(s.documentId)))
    .map(({ role, content }) => ({ role, content }));
}

/** Sources of the cited excerpts, in citation order. */
export function citedSources(sources: SourceReference[], cited: number[]): SourceReference[] {
  return cited.flatMap((n) => (sources[n - 1] ? [sources[n - 1]] : []));
}
