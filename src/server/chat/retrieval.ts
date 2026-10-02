import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SourceReference } from "@/lib/domain/types";
import type { DocumentDataClass } from "@/server/ai/guard";
import type { ContextChunk } from "@/server/ai/types";

import { toContext, type HistoryRow, type SearchRow } from "./turn";

/**
 * Retrieval for one chat turn (ADR-042). Everything runs under the user's
 * own Supabase client, so RLS decides which chunks exist at all.
 *
 *   1. Conversation-aware query: a follow-up question is searched together
 *      with the previous user question.
 *   2. The chunks the previous answer cited are re-read from the database
 *      (never the answer text itself) and kept when they are still relevant.
 *   3. Scope: broad questions (overviews, comparisons, "all …") get a larger
 *      budget than focused fact questions.
 *   4. Diversity: the context is picked from a larger candidate pool so one
 *      document cannot fill it just because it has more or longer chunks
 *      while other relevant documents have matching chunks. Documents that
 *      are not relevant are never added for diversity.
 *
 * Document metadata (title, validity, upload date, page) is sent with every
 * chunk (see buildSystemPrompt), so document-wide facts such as validity do
 * not depend on which chunk happened to be retrieved.
 */

export type QueryScope = "focused" | "broad";

export interface RetrievalBudget {
  /** Maximum number of chunks in the context. */
  maxChunks: number;
  /** Maximum total characters of chunk text in the context. */
  maxChars: number;
  /** Candidates requested from the database. */
  candidates: number;
  /** A document is relevant when one of its chunks ranks within this many candidates. */
  relevantWithin: number;
}

export const RETRIEVAL_BUDGETS: Record<QueryScope, RetrievalBudget> = {
  focused: { maxChunks: 20, maxChars: 16_000, candidates: 60, relevantWithin: 10 },
  broad: { maxChunks: 60, maxChars: 40_000, candidates: 150, relevantWithin: 30 },
};

/** Largest share of the budget one document may take while other relevant documents have chunks left. */
export const DOCUMENT_SHARE = 0.6;
/** At most this many chunks are carried over from the previous answer. */
export const CARRIED_MAX = 12;

const WORD = "[\\p{L}\\p{N}]";
const term = (pattern: string) => new RegExp(`(?<!${WORD})(?:${pattern})(?!${WORD})`, "iu");

/** Overviews, comparisons and "all …" questions. Generic Swedish wording only. */
const BROAD = term(
  [
    "alla",
    "samtliga",
    "varje",
    "vilka",
    "lista\\p{L}*",
    "översikt\\p{L}*",
    "överblick\\p{L}*",
    "sammanfatta\\p{L}*",
    "sammanställ\\p{L}*",
    "jämför\\p{L}*",
    "skillnad\\p{L}*",
    "kontra",
    "versus",
    "vs",
    "mot varandra",
    "ställ[^.?!]{0,80}\\smot",
    "finns det några",
    "vad finns det",
    "utbud\\p{L}*",
  ].join("|"),
);

/** Words that point back to something earlier in the conversation (not common words like "det"). */
const REFERS_BACK = term(
  ["dem", "dom", "dessa", "denna", "deras", "samma", "båda", "bägge", "vilken av", "vilket av", "vilka av", "ovan", "nämnda", "förra"].join(
    "|",
  ),
);

const FOLLOW_UP_MAX_WORDS = 14;

export function classifyQuery(text: string): QueryScope {
  return BROAD.test(text) ? "broad" : "focused";
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** A short question, or one that refers back, continues the previous one. */
export function isFollowUp(text: string, previousUserMessage: string | null): boolean {
  if (!previousUserMessage) return false;
  return wordCount(text) <= FOLLOW_UP_MAX_WORDS || REFERS_BACK.test(text);
}

/** Search text: the question, plus the previous question for follow-ups. */
export function retrievalQuery(message: string, previousUserMessage: string | null, followUp: boolean): string {
  const text = followUp && previousUserMessage ? `${message}\n${previousUserMessage}` : message;
  return text.slice(0, 2000);
}

export interface ConversationSignals {
  /** The user question before the current one, if any. */
  previousUserMessage: string | null;
  /** Chunk ids the previous answer cited (its stored, verified sources). */
  citedChunkIds: number[];
}

/**
 * Reads the conversation (chronological, ending with the current question)
 * for the previous question and the chunks the previous answer cited.
 */
export function conversationSignals(rows: Pick<HistoryRow, "role" | "content" | "sources">[]): ConversationSignals {
  let end = rows.length;
  if (end && rows[end - 1].role === "user") end--;
  let previousUserMessage: string | null = null;
  let lastAnswer: (typeof rows)[number] | null = null;
  for (let i = end - 1; i >= 0; i--) {
    if (!lastAnswer && rows[i].role === "assistant" && previousUserMessage === null) lastAnswer = rows[i];
    if (rows[i].role === "user") {
      previousUserMessage = rows[i].content;
      break;
    }
  }
  const citedChunkIds = [
    ...new Set((lastAnswer?.sources ?? []).map((s) => Number(s.id)).filter((n) => Number.isSafeInteger(n) && n > 0)),
  ].slice(0, CARRIED_MAX);
  return { previousUserMessage, citedChunkIds };
}

interface Picked extends SearchRow {
  reused: boolean;
}

/**
 * Picks the context from ranked candidates (best first) and re-read chunks
 * from the previous answer. Pure, so it can be unit tested.
 *
 * Order in the prompt: documents in order of relevance, chunks in reading
 * order within each document (so neighbouring pages stay together).
 */
export function selectContext(
  ranked: SearchRow[],
  carried: SearchRow[],
  scope: QueryScope,
  { followUp }: { followUp: boolean },
): SearchRow[] {
  const budget = RETRIEVAL_BUDGETS[scope];
  const relevant = new Set(ranked.slice(0, budget.relevantWithin).map((r) => r.document_id));
  // Earlier sources stay when the question continues the conversation or
  // still concerns their document.
  const keep = carried.filter((c) => followUp || relevant.has(c.document_id)).slice(0, CARRIED_MAX);
  for (const c of keep) relevant.add(c.document_id);

  const documents = Math.max(relevant.size, 1);
  const capChunks = Math.max(Math.ceil(budget.maxChunks / documents), Math.ceil(budget.maxChunks * DOCUMENT_SHARE));
  const capChars = Math.max(Math.ceil(budget.maxChars / documents), Math.ceil(budget.maxChars * DOCUMENT_SHARE));

  const picked: Picked[] = [];
  const seen = new Set<number>();
  const perDocument = new Map<string, { chunks: number; chars: number }>();
  let chars = 0;

  const tryAdd = (row: SearchRow, reused: boolean, capped: boolean) => {
    if (seen.has(row.chunk_id) || picked.length >= budget.maxChunks) return;
    const length = row.content.length;
    if (chars + length > budget.maxChars) return;
    const used = perDocument.get(row.document_id) ?? { chunks: 0, chars: 0 };
    if (capped && (used.chunks >= capChunks || used.chars + length > capChars)) return;
    seen.add(row.chunk_id);
    picked.push({ ...row, reused });
    perDocument.set(row.document_id, { chunks: used.chunks + 1, chars: used.chars + length });
    chars += length;
  };

  for (const row of keep) tryAdd(row, true, false);
  const candidates = ranked.filter((r) => relevant.has(r.document_id));
  for (const row of candidates) tryAdd(row, false, true);
  // Space that other documents could not use goes to the remaining relevant chunks.
  for (const row of candidates) tryAdd(row, false, false);

  const documentOrder = new Map<string, number>();
  for (const row of [...keep, ...candidates]) {
    if (!documentOrder.has(row.document_id)) documentOrder.set(row.document_id, documentOrder.size);
  }
  return picked.sort(
    (a, b) =>
      documentOrder.get(a.document_id)! - documentOrder.get(b.document_id)! ||
      (a.chunk_index ?? 0) - (b.chunk_index ?? 0) ||
      a.chunk_id - b.chunk_id,
  );
}

export interface RetrievalStats {
  scope: QueryScope;
  followUp: boolean;
  usedVectorSearch: boolean;
  candidates: number;
  chunks: number;
  chars: number;
  documents: number;
  reused: number;
}

export interface RetrievalResult {
  context: ContextChunk[];
  sources: SourceReference[];
  stats: RetrievalStats;
}

export async function retrieveContext(
  supabase: SupabaseClient,
  input: {
    assistantId: string;
    message: string;
    /** The conversation so far, chronological, ending with the current question. */
    history: Pick<HistoryRow, "role" | "content" | "sources">[];
    dataClass: DocumentDataClass | null;
    /** Query embedding (only when the data guard allows an external call). */
    embed: ((text: string) => Promise<{ vector: string; model: string } | null>) | null;
  },
): Promise<RetrievalResult> {
  const signals = conversationSignals(input.history);
  const followUp = isFollowUp(input.message, signals.previousUserMessage);
  const scope = classifyQuery(input.message);
  const query = retrievalQuery(input.message, signals.previousUserMessage, followUp);
  const embedding = input.embed ? await input.embed(query) : null;

  const [search, carried] = await Promise.all([
    supabase.rpc("search_document_context", {
      p_assistant_id: input.assistantId,
      p_query: query,
      p_embedding: embedding?.vector ?? null,
      p_embedding_model: embedding?.model ?? null,
      p_data_class: input.dataClass,
      p_limit: RETRIEVAL_BUDGETS[scope].candidates,
    }),
    signals.citedChunkIds.length
      ? supabase.rpc("get_document_context_chunks", {
          p_assistant_id: input.assistantId,
          p_chunk_ids: signals.citedChunkIds,
          p_data_class: input.dataClass,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (search.error) console.error("[chat/retrieval] search failed", search.error.message);
  if (carried.error) console.error("[chat/retrieval] earlier sources could not be read", carried.error.message);

  // Keep the previous answer's citation order for the re-read chunks.
  const order = new Map(signals.citedChunkIds.map((id, i) => [id, i]));
  const earlier = ((carried.data ?? []) as SearchRow[]).sort(
    (a, b) => (order.get(a.chunk_id) ?? 0) - (order.get(b.chunk_id) ?? 0),
  );
  const ranked = (search.data ?? []) as SearchRow[];
  const rows = selectContext(ranked, earlier, scope, { followUp });
  const { context, sources } = toContext(rows);
  return {
    context,
    sources,
    stats: {
      scope,
      followUp,
      usedVectorSearch: Boolean(embedding),
      candidates: ranked.length,
      chunks: rows.length,
      chars: rows.reduce((n, r) => n + r.content.length, 0),
      documents: new Set(rows.map((r) => r.document_id)).size,
      reused: rows.filter((r) => r.reused).length,
    },
  };
}
