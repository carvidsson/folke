import { describe, expect, it } from "vitest";

import {
  CARRIED_MAX,
  DOCUMENT_SHARE,
  RETRIEVAL_BUDGETS,
  classifyQuery,
  conversationSignals,
  isFollowUp,
  retrievalQuery,
  selectContext,
} from "./retrieval";
import type { HistoryRow, SearchRow } from "./turn";

/** Retrieval for a chat turn (ADR-042). */

let nextId = 1;
const chunk = (documentId: string, index: number, length = 300): SearchRow => ({
  chunk_id: nextId++,
  document_id: documentId,
  chunk_index: index,
  title: `Dokument ${documentId}`,
  content: "x".repeat(length),
  location: `Sida ${index + 1}`,
  ai_data_class: "approved",
});
const many = (documentId: string, n: number, length = 300) => Array.from({ length: n }, (_, i) => chunk(documentId, i, length));
/** Interleaves lists by rank (a1, b1, a2, b2 …). */
const interleave = (...lists: SearchRow[][]) =>
  Array.from({ length: Math.max(...lists.map((l) => l.length)) }).flatMap((_, i) => lists.flatMap((l) => (l[i] ? [l[i]] : [])));
const perDocument = (rows: SearchRow[]) =>
  rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.document_id]: (acc[r.document_id] ?? 0) + 1 }), {});

describe("query scope", () => {
  it.each([
    "Vilka kampanjer finns för märke A?",
    "Jämför märke A och märke B",
    "Jämför samtliga kampanjer mot varandra.",
    "Ställ märke A:s och märke B:s kampanjer mot varandra",
    "Finns det några aktuella bra kampanjer på märke A?",
    "Ge mig en översikt över erbjudandena",
    "Lista alla modeller med privatleasing",
  ])("treats overviews and comparisons as broad: %s", (q) => {
    expect(classifyQuery(q)).toBe("broad");
  });

  it.each(["Vad kostar privatleasing för modell X?", "Hur lång är nybilsgarantin?", "Vilken räntesats gäller?"])(
    "treats fact questions as focused: %s",
    (q) => expect(classifyQuery(q)).toBe("focused"),
  );

  it("uses whole words, also with Swedish letters", () => {
    expect(classifyQuery("Hur fungerar allavägsdäck?")).toBe("focused");
    expect(classifyQuery("Gör en överblick")).toBe("broad");
  });
});

describe("follow-up questions", () => {
  const previous = "Finns det några aktuella kampanjer på märke A?";

  it("short questions and questions that refer back continue the previous question", () => {
    expect(isFollowUp("Vilken skulle passa en barnfamilj?", previous)).toBe(true);
    expect(
      isFollowUp("Kan du förklara närmare hur villkoren skiljer sig åt för dessa när kunden har företagsleasing via oss?", previous),
    ).toBe(true);
    expect(isFollowUp("Vilken skulle passa en barnfamilj?", null)).toBe(false);
  });

  it("a long new question stands on its own", () => {
    const q = "Hur lång tid tar det normalt att få en ny bil levererad om kunden beställer en fabriksorder i höst?";
    expect(isFollowUp(q, previous)).toBe(false);
    expect(retrievalQuery(q, previous, false)).toBe(q);
  });

  it("searches a follow-up together with the previous question", () => {
    expect(retrievalQuery("Vilken passar en barnfamilj?", previous, true)).toBe(`Vilken passar en barnfamilj?\n${previous}`);
  });
});

describe("conversation signals", () => {
  const source = (id: string) => ({ id, documentId: "A", title: "t", excerpt: "e", location: null });
  const rows: HistoryRow[] = [
    { role: "user", content: "Fråga 1", sources: null },
    { role: "assistant", content: "Svar 1 [1]", sources: [source("5")] },
    { role: "user", content: "Fråga 2", sources: null },
    { role: "assistant", content: "Svar 2 [1] [2]", sources: [source("7"), source("9"), source("7"), source("x")] },
    { role: "user", content: "Fråga 3", sources: null },
  ];

  it("finds the previous question and the chunks the two latest answers cited, newest first", () => {
    expect(conversationSignals(rows)).toEqual({ previousUserMessage: "Fråga 2", citedChunkIds: [7, 9, 5] });
  });

  it("is empty for the first question", () => {
    expect(conversationSignals([rows[0]])).toEqual({ previousUserMessage: null, citedChunkIds: [] });
  });

  it("keeps earlier sources after a failed turn without an answer", () => {
    const failed = [...rows.slice(0, 3), { role: "user" as const, content: "Fråga 3", sources: null }];
    expect(conversationSignals(failed)).toEqual({ previousUserMessage: "Fråga 2", citedChunkIds: [5] });
  });

  it("skips an answer that was cut off before citing anything (the chain does not break)", () => {
    const cut: HistoryRow[] = [
      ...rows,
      { role: "assistant", content: "Långt svar som avbröts", sources: [] },
      { role: "user", content: "Fråga 4", sources: null },
    ];
    expect(conversationSignals(cut)).toEqual({ previousUserMessage: "Fråga 3", citedChunkIds: [7, 9, 5] });
  });

  it("uses only the two latest answers with sources", () => {
    const longer: HistoryRow[] = [
      { role: "user", content: "a", sources: null },
      { role: "assistant", content: "b", sources: [source("1")] },
      ...rows,
    ];
    expect(conversationSignals(longer).citedChunkIds).toEqual([7, 9, 5]);
  });

  it(`carries at most ${CARRIED_MAX} chunks`, () => {
    expect(CARRIED_MAX).toBe(16);
    const sources = Array.from({ length: 30 }, (_, i) => source(String(i + 1)));
    const r = conversationSignals([
      { role: "user", content: "a", sources: null },
      { role: "assistant", content: "b", sources },
      { role: "user", content: "c", sources: null },
    ]);
    expect(r.citedChunkIds).toHaveLength(CARRIED_MAX);
  });
});

describe("context selection", () => {
  it("keeps the budgets and document share of ADR-042 unchanged", () => {
    expect(RETRIEVAL_BUDGETS).toEqual({
      focused: { maxChunks: 20, maxChars: 16_000, candidates: 60, relevantWithin: 10 },
      broad: { maxChunks: 60, maxChars: 40_000, candidates: 150, relevantWithin: 30 },
    });
    expect(DOCUMENT_SHARE).toBe(0.6);
  });

  it("re-read chunks are never pushed out by a full broad context", () => {
    const carried = many("Q", 16, 800);
    const ranked = interleave(many("A", 80, 900), many("B", 80, 900));
    const rows = selectContext(ranked, carried, "broad", { followUp: true });
    expect(rows.filter((r) => r.reused)).toHaveLength(16);
    expect(rows.reduce((n, r) => n + r.content.length, 0)).toBeLessThanOrEqual(RETRIEVAL_BUDGETS.broad.maxChars);
  });

  it("uses about 20 chunks for focused questions instead of 6", () => {
    const rows = selectContext(many("A", 40), [], "focused", { followUp: false });
    expect(rows).toHaveLength(RETRIEVAL_BUDGETS.focused.maxChunks);
  });

  it("does not let a document with more chunks fill the context when another relevant document has matches", () => {
    // A ranks first in every position; B is relevant (rank 2) but has fewer chunks.
    const a = many("A", 50);
    const b = many("B", 15);
    const ranked = [a[0], b[0], ...a.slice(1), ...b.slice(1)];
    const counts = perDocument(selectContext(ranked, [], "focused", { followUp: false }));
    expect(counts.B).toBeGreaterThanOrEqual(8);
    expect(counts.A).toBeLessThanOrEqual(Math.ceil(RETRIEVAL_BUDGETS.focused.maxChunks * 0.6));
  });

  it("does not let a document with longer chunks take the whole character budget", () => {
    const a = many("A", 30, 1200);
    const b = many("B", 30, 300);
    const rows = selectContext(interleave(a, b), [], "focused", { followUp: false });
    const chars = (id: string) => rows.filter((r) => r.document_id === id).reduce((n, r) => n + r.content.length, 0);
    expect(chars("A")).toBeLessThanOrEqual(RETRIEVAL_BUDGETS.focused.maxChars * 0.6);
    expect(perDocument(rows).B).toBeGreaterThan(5);
  });

  it("never adds irrelevant documents just for diversity", () => {
    const a = many("A", 40);
    const c = many("C", 5); // only far down the ranking
    const rows = selectContext([...a, ...c], [], "focused", { followUp: false });
    expect(perDocument(rows).C).toBeUndefined();
    expect(rows).toHaveLength(20);
  });

  it("gives broad questions a much larger overview across documents", () => {
    const a = many("A", 77, 290);
    const b = many("B", 28, 630);
    const rows = selectContext(interleave(a, b), [], "broad", { followUp: false });
    const counts = perDocument(rows);
    expect(rows.length).toBeGreaterThan(40);
    expect(counts.B).toBe(28);
    expect(counts.A).toBeGreaterThan(20);
    expect(rows.reduce((n, r) => n + r.content.length, 0)).toBeLessThanOrEqual(RETRIEVAL_BUDGETS.broad.maxChars);
  });

  it("re-reads the previous answer's chunks for follow-ups, marks them and avoids duplicates", () => {
    const a = many("A", 10);
    const carried = [a[7], a[8]];
    const rows = selectContext([...a.slice(0, 3), a[7]], carried, "focused", { followUp: true });
    expect(rows.filter((r) => r.reused).map((r) => r.chunk_id).sort()).toEqual([a[7].chunk_id, a[8].chunk_id].sort());
    expect(new Set(rows.map((r) => r.chunk_id)).size).toBe(rows.length);
  });

  it("drops earlier chunks when a new, unrelated question does not concern their document", () => {
    const old = many("OLD", 3);
    const rows = selectContext(many("NEW", 10), old, "focused", { followUp: false });
    expect(rows.some((r) => r.document_id === "OLD")).toBe(false);
  });

  it("orders documents by relevance and chunks in reading order", () => {
    const a = many("A", 6);
    const b = many("B", 6);
    const ranked = [b[4], a[2], b[1], a[5], a[0]];
    const rows = selectContext(ranked, [], "focused", { followUp: false });
    expect(rows.map((r) => [r.document_id, r.chunk_index])).toEqual([
      ["B", 1],
      ["B", 4],
      ["A", 0],
      ["A", 2],
      ["A", 5],
    ]);
  });
});
