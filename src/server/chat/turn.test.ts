import { describe, expect, it } from "vitest";

import { citedSources, excerptFor, filterHistory, toContext, type HistoryRow, type SearchRow } from "./turn";

const row = (id: number, documentId: string, dataClass: SearchRow["ai_data_class"] = "synthetic"): SearchRow => ({
  chunk_id: id,
  document_id: documentId,
  title: `Dokument ${id}`,
  content: `Innehåll ${id}`,
  location: null,
  ai_data_class: dataClass,
  snippet: null,
});

describe("context from search results", () => {
  it("numbers excerpts and keeps each document's data class", () => {
    const { context, sources } = toContext([row(10, "a"), row(11, "b", "internal")]);
    expect(context.map((c) => [c.index, c.dataClass])).toEqual([
      [1, "synthetic"],
      [2, "internal"],
    ]);
    expect(sources.map((s) => s.id)).toEqual(["10", "11"]);
  });

  it("uses the matching passage as excerpt and shortens long text", () => {
    expect(excerptFor("  träff  här ", "hela texten")).toBe("träff här");
    expect(excerptFor(null, "a".repeat(500))).toHaveLength(398);
  });
});

describe("cited sources", () => {
  it("returns only the excerpts the answer cites, in citation order", () => {
    const { sources } = toContext([row(1, "a"), row(2, "b"), row(3, "c")]);
    expect(citedSources(sources, [3, 1]).map((s) => s.documentId)).toEqual(["c", "a"]);
    expect(citedSources(sources, [])).toEqual([]);
  });
});

describe("history after revoked access", () => {
  const source = (documentId: string) => ({ id: "1", documentId, title: "t", excerpt: "e", location: null });
  const history: HistoryRow[] = [
    { role: "user", content: "Fråga 1", sources: null },
    { role: "assistant", content: "Svar från dokument A", sources: [source("A")] },
    { role: "user", content: "Fråga 2", sources: null },
    { role: "assistant", content: "Svar från dokument B", sources: [source("B")] },
    { role: "assistant", content: "Svar utan källor", sources: [] },
  ];

  it("drops earlier answers based on documents the user can no longer read", () => {
    const result = filterHistory(history, new Set(["A"]));
    expect(result.map((m) => m.content)).toEqual(["Fråga 1", "Svar från dokument A", "Fråga 2", "Svar utan källor"]);
  });

  it("removes source markers from earlier answers, whose numbers no longer apply", () => {
    const result = filterHistory(
      [
        { role: "user", content: "Fråga [1]", sources: null },
        { role: "assistant", content: "Pris 3 495 kr/mån [1]. Ränta 3,9 % [2, s. 4].", sources: [] },
      ],
      new Set(),
    );
    expect(result.map((m) => m.content)).toEqual(["Fråga [1]", "Pris 3 495 kr/mån. Ränta 3,9 %."]);
  });

  it("never sends stored source metadata to the model", () => {
    for (const m of filterHistory(history, new Set(["A", "B"]))) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
  });
});
