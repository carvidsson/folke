import { describe, expect, it } from "vitest";

import { DEFAULT_TABLE_QUERY, formatRowRefs, formatTableCell, type TableQuery } from "@/lib/tables/query";
import { buildXlsx, scaniaWorkbook, SYNTHETIC_VEHICLE, type ScaniaFixtureRow } from "../../../tests/fixtures/xlsx";

import { addMonths, buildDataset, costsAnalysis, forecastAnalysis, monthsBetween, occasions, partsAnalysis, qualityAnalysis, repeatPairs, runAnalysis } from "./analyses";
import { buildTableBrief, buildTableSystemPrompt, fallbackAnswer, tableResult } from "./brief";
import { previousQuery } from "./chat";
import { planToQuery, readQuestion, type TablePlan } from "./planner";
import { assertNoTableIdentifiers, tablePseudonyms, tableStreamRevealer } from "./pseudonyms";
import { parseScaniaExport } from "./scania";
import { parseSwedishNumber, readWorkbook } from "./xlsx";

// --- Synthetic data (fictional vehicles, customers and people) -------------------------------------

const FIRST: ScaniaFixtureRow[] = [
  { date: "2024-02-01", mst: 100_000, ao: "A1", hgrp: "10", ugrp: "25", name: "10 BROMSAR", labour: 1000, material: 500 },
  // Same work order and group: the same occasion.
  { date: "2024-02-02", mst: 100_050, ao: "A1", hgrp: "10", ugrp: "25", name: "10 BROMSAR", labour: 200 },
  // Same work order, another group: another occasion.
  { date: "2024-02-03", mst: 100_100, ao: "A1", hgrp: "16", ugrp: "20", name: "16 ELSYSTEM", material: 300 },
  { date: "2024-03-01", mst: 101_000, ao: "M1", hgrp: "40", ugrp: "30", name: "40 SERVICEAVTAL", maintenance: true, labour: 900 },
  { date: "2024-04-01", mst: 102_000, ao: "A4", hgrp: "12", ugrp: "05", name: "12 FJÄDRING", emptyCosts: true },
  { date: "2024-06-20", mst: 110_000, ao: "A2", hgrp: "10", ugrp: "25", name: "10 BROMSAR", workshop: "Syntetisk Verkstad Öst", labour: 3000, materialExt: 250 },
  { date: "2024-09-01", mst: 115_000, ao: "M2", hgrp: "40", ugrp: "30", name: "40 SERVICEAVTAL", maintenance: true, labour: 950 },
  // The odometer decreases: no km for this pair, and no per-km figures for the vehicle.
  { date: "2025-03-01", mst: 105_000, ao: "A3", hgrp: "10", ugrp: "25", name: "10 BROMSAR", labour: 800 },
];
const SECOND_VEHICLE = { ...SYNTHETIC_VEHICLE, regnr: "TST456", chassis: "9999002", customer: "Fiktiva Transporter AB", customerNumber: "880002", contract: "770002", contact: "Prova Provsson", siteNumber: "55502", site: "Provdepån Syd" };
const SECOND: ScaniaFixtureRow[] = [
  { date: "2025-01-10", mst: 200_000, ao: "B1", hgrp: "03", ugrp: "01", name: "03 BRÄNSLE", labour: 1000 },
  { date: "2025-08-10", mst: 230_000, ao: "B2", hgrp: "03", ugrp: "01", name: "03 BRÄNSLE", labour: 2000 },
];
const FILE_NAMES = ["Avtalsexport TST123 Syntetiska Åkeriet.xlsx", "Avtalsexport TST456.xlsx"];

async function dataset() {
  const a = (await parseScaniaExport(await scaniaWorkbook(FIRST), FILE_NAMES[0], 1))!;
  const b = (await parseScaniaExport(await scaniaWorkbook(SECOND, SECOND_VEHICLE, { start: "2025-01-01", end: "2027-12-31" }), FILE_NAMES[1], 2))!;
  return buildDataset([a, b]);
}

const q = (over: Partial<TableQuery>): TableQuery => ({ ...DEFAULT_TABLE_QUERY, ...over });

// --- Reader -------------------------------------------------------------------------------------

describe("structured Excel reader", () => {
  it("keeps every value at its column, reads dates and keeps the original row numbers", async () => {
    const bytes = await buildXlsx([{ name: "Blad", firstRow: 3, rows: [["a", null, "c"], [], [1.5, { date: "2024-02-29" }, { text: "inline", inline: true }]] }]);
    const [sheet] = await readWorkbook(bytes);
    expect(sheet.name).toBe("Blad");
    expect(sheet.rows.map((r) => r.row)).toEqual([3, 4, 5]);
    expect(sheet.rows[0].cells[1]).toBeUndefined();
    expect(sheet.rows[0].cells[2]).toEqual({ type: "text", value: "c" });
    expect(sheet.rows[2].cells).toEqual([
      { type: "number", value: 1.5 },
      { type: "date", value: "2024-02-29" },
      { type: "text", value: "inline" },
    ]);
  });

  it("finds sheets through the relationships whatever the attribute order", async () => {
    const bytes = await buildXlsx([{ name: "Första", rows: [["x"]] }, { name: "Andra", rows: [["y"]] }], { relsTargetFirst: true });
    expect((await readWorkbook(bytes)).map((s) => s.name)).toEqual(["Första", "Andra"]);
  });

  it("reads Swedish number formats and refuses ambiguous ones", () => {
    expect(parseSwedishNumber("1 234,50")).toBe(1234.5);
    expect(parseSwedishNumber("1 234,50 kr")).toBe(1234.5);
    expect(parseSwedishNumber("-1145")).toBe(-1145);
    expect(parseSwedishNumber("12.5")).toBe(12.5);
    expect(parseSwedishNumber("1,234.50")).toBeNull();
    expect(parseSwedishNumber("abc")).toBeNull();
  });

  it("formats cells and row references for the table", () => {
    expect(formatTableCell(1751796.57, "kr")).toBe("1 751 797 kr");
    expect(formatTableCell(null, "km")).toBe("–");
    expect(formatRowRefs([{ file: 1, fileName: "a.xlsx", sheet: "Kostnader", rows: [6, 7] }])).toBe("a.xlsx, rad 6, 7");
    expect(formatRowRefs([{ file: 1, fileName: "a.xlsx", sheet: "Kostnader", rows: [6] }], false)).toBe("Fil 1, rad 6");
  });
});

// --- Schema -------------------------------------------------------------------------------------

describe("Scania export recognition", () => {
  it("maps the export, trims values, reads 'undefined' as empty and checks the sum row", async () => {
    const file = (await parseScaniaExport(await scaniaWorkbook(FIRST), "a.xlsx"))!;
    expect(file.headerRow).toBe(5);
    expect(file.transactions).toHaveLength(FIRST.length);
    const t = file.transactions[0];
    expect(t.row).toBe(6);
    expect(t.contract.number).toBe(SYNTHETIC_VEHICLE.contract);
    expect(t.order).toBe("A1");
    expect(t.reason).toBeNull();
    expect(t.repairDate).toBe("2024-02-01");
    expect(t.contract.start).toBe("2024-01-15");
    expect(t.costs).toEqual({ labourOwn: 1000, materialOwn: 500, labourExternal: 0, materialExternal: 0, total: 1500 });
    // The row with empty cost cells: no value has moved into another column.
    const empty = file.transactions.find((x) => x.order === "A4")!;
    expect(empty.costs.total).toBe(0);
    expect(empty.group).toEqual({ main: "12", sub: "05", name: "12 FJÄDRING" });
    expect(empty.odometer).toBe(102_000);
    expect(empty.workshop).toBe("Syntetisk Verkstad Väst");
    // The sum row is recognised, matches and is not a transaction.
    expect(file.sumRow).toEqual({ row: 6 + FIRST.length, total: 7900, matches: true });
    expect(file.transactions.some((x) => x.row === file.sumRow!.row)).toBe(false);
    expect(file.warnings).toEqual([]);
  });

  it("reports a sum row that does not match", async () => {
    const bytes = await buildXlsx([{ name: "Kostnader", rows: [...(await import("../../../tests/fixtures/xlsx")).scaniaRows(FIRST, SYNTHETIC_VEHICLE, { sumRow: false }), [null, ...Array(35).fill(null), 1]] }]);
    const file = (await parseScaniaExport(bytes, "a.xlsx"))!;
    expect(file.sumRow?.matches).toBe(false);
    expect(file.warnings.join(" ")).toMatch(/stämmer inte/);
  });

  it("does not treat other workbooks as Scania exports", async () => {
    expect(await parseScaniaExport(await buildXlsx([{ name: "Blad1", rows: [["Datum", "Belopp"], [{ date: "2024-01-01" }, 100]] }]), "x.xlsx")).toBeNull();
    // One required column missing is enough.
    const rows = (await import("../../../tests/fixtures/xlsx")).scaniaRows(FIRST).map((r) => r.map((c) => (c === "AoNr" ? "Order" : c)));
    expect(await parseScaniaExport(await buildXlsx([{ name: "Kostnader", rows }]), "y.xlsx")).toBeNull();
    expect(await parseScaniaExport(new Uint8Array([1, 2, 3]), "z.xlsx")).toBeNull();
  });
});

// --- Analyses (expected values worked out by hand from the fixtures) ---------------------------------

describe("analyses", () => {
  it("counts one occasion per work order and group", async () => {
    const ds = await dataset();
    const list = occasions(ds.transactions);
    // A1 bromsar (2 rows), A1 elsystem, M1, A4, A2, M2, A3, B1, B2.
    expect(list).toHaveLength(9);
    const a1 = list.find((o) => o.order === "A1" && o.group.main === "10")!;
    expect(a1.rows.map((r) => r.row)).toEqual([6, 7]);
    expect(a1.total).toBe(1700);
    expect(a1.date).toBe("2024-02-01");
    expect(a1.odometer).toBe(100_050);
  });

  it("finds repeats within the window, with days, km and references", async () => {
    const ds = await dataset();
    const twelve = repeatPairs(ds, q({ windowMonths: 12 }));
    expect(twelve.map((p) => `${p.first.order}>${p.second.order}`).sort()).toEqual(["A1>A2", "A2>A3", "B1>B2"]);
    const a1a2 = twelve.find((p) => p.first.order === "A1")!;
    expect(a1a2.days).toBe(140);
    expect(a1a2.km).toBe(9_950);
    // The odometer decreased: no km.
    expect(twelve.find((p) => p.first.order === "A2")!.km).toBeNull();
    expect(repeatPairs(ds, q({ windowMonths: 6 })).map((p) => p.second.order)).toEqual(["A2"]);
    expect(repeatPairs(ds, q({ windowMonths: 3 }))).toHaveLength(0);
    // Planned maintenance only on request: M1 → M2 is exactly six months.
    expect(repeatPairs(ds, q({ windowMonths: 6, includeMaintenance: true })).map((p) => p.second.order).sort()).toEqual(["A2", "M2"]);
    // Same workshop: A1 and A3 are at Väst, A2 at Öst.
    expect(repeatPairs(ds, q({ windowMonths: 12, sameWorkshop: true })).map((p) => p.second.order)).toEqual(["B2"]);
    expect(repeatPairs(ds, q({ windowMonths: 12, vehicle: 1 })).map((p) => p.second.order).sort()).toEqual(["A2", "A3"]);
    const table = runAnalysis(ds, q({ windowMonths: 12, sort: "cost", limit: 1 }));
    expect(table.rows[0].cells.orders).toBe("A1 → A2");
    expect(table.rows[0].refs).toEqual([{ file: 1, fileName: FILE_NAMES[0], sheet: "Kostnader", rows: [6, 7, 11] }]);
    expect(table.lines[0]).toMatch(/^3 granskningskandidater/);
  });

  it("sums costs without the sum rows, and per 1 000 km only for consistent odometers", async () => {
    const ds = await dataset();
    const byVehicle = costsAnalysis(ds, q({ analysis: "costs", by: "vehicle" }));
    const first = byVehicle.rows.find((r) => r.cells.key === "TST123")!;
    const second = byVehicle.rows.find((r) => r.cells.key === "TST456")!;
    expect(first.cells.total).toBe(7900);
    expect(first.cells.perKkm).toBeNull();
    expect(second.cells.total).toBe(3000);
    expect(second.cells.km).toBe(30_000);
    expect(second.cells.perKkm).toBe(100);
    const types = costsAnalysis(ds, q({ analysis: "costs", by: "cost_type" }));
    expect(types.rows.map((r) => r.cells.total)).toEqual([9850, 800, 0, 250]);
    const years = costsAnalysis(ds, q({ analysis: "costs", by: "year" }));
    expect(years.rows.map((r) => [r.cells.key, r.cells.total])).toEqual([["2024", 7100], ["2025", 3800]]);
    expect(costsAnalysis(ds, q({ analysis: "costs", by: "workshop" })).rows.map((r) => r.cells.key)).toContain("Syntetisk Verkstad Öst");
  });

  it("extrapolates a contract only with enough history and states it says nothing about profitability", async () => {
    const ds = await dataset();
    const f = forecastAnalysis(ds, q({ analysis: "forecast" }));
    const second = f.rows.find((r) => r.cells.vehicle === "TST456")!;
    expect(second.cells).toMatchObject({ cost: 3000, elapsed: 8, remaining: 28, perMonth: 375, rest: 10_500, projected: 13_500 });
    expect(f.lines.join(" ")).toMatch(/ingenting om lönsamhet/);
    expect(monthsBetween("2025-01-01", "2025-08-10")).toBe(7);
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("explains that replaced parts cannot be determined, and what export is needed", async () => {
    const ds = await dataset();
    const parts = partsAnalysis(ds);
    expect(parts.lines.join(" ")).toMatch(/inga artikelnummer/);
    expect(parts.lines.join(" ")).toMatch(/artikelnummer \(reservdelsnummer\)/);
    expect(parts.rows).toEqual([]);
    const quality = qualityAnalysis(ds);
    expect(quality.rows[0].cells).toMatchObject({ rows: 8, orders: 6, decreases: 1 });
  });
});

// --- Personal data --------------------------------------------------------------------------------

describe("pseudonymisation", () => {
  const forbidden = [
    "TST123",
    "TST456",
    "9999001",
    "Syntetiska Åkeriet",
    "880001",
    "770001",
    "Testa",
    "Testsson",
    "Prova Provsson",
    "55501",
    "Testdepån",
    "Provdepån",
    ...FILE_NAMES,
  ];

  it("no identifier reaches the brief or the prompt for any analysis", async () => {
    const ds = await dataset();
    const p = tablePseudonyms(ds);
    const queries: TableQuery[] = [
      q({ analysis: "repeats", windowMonths: 24, includeMaintenance: true }),
      ...(["vehicle", "contract", "year", "month", "workshop", "site", "group", "subgroup", "cost_type"] as const).map((by) => q({ analysis: "costs", by })),
      q({ analysis: "forecast" }),
      q({ analysis: "quality" }),
      q({ analysis: "parts" }),
    ];
    for (const query of queries) {
      const brief = buildTableBrief(ds, tableResult(runAnalysis(ds, query), query), p);
      const system = buildTableSystemPrompt({ organization: "Org.", assistant: "Assistent." }, brief, { today: "2026-10-08" });
      for (const value of forbidden) expect(system.toLowerCase(), `${query.analysis}/${query.by}: ${value}`).not.toContain(value.toLowerCase());
      expect(() => assertNoTableIdentifiers(system, p)).not.toThrow();
      // Work orders and row references are not in the brief either.
      expect(system).not.toMatch(/A1 → A2|xlsx, rad/);
    }
  });

  it("hides identifiers the user types, in any common form, and reveals aliases", async () => {
    const p = tablePseudonyms(await dataset());
    const hidden = p.hide("Hur går det för tst 123 och TST-456? Fråga Testsson på Syntetiska Åkeriet AB (kundnr 880001), avtal 770001, Testdepån Norr.");
    for (const value of ["tst 123", "TST-456", "Testsson", "Syntetiska Åkeriet", "880001", "770001", "Testdepån"]) expect(hidden).not.toContain(value);
    expect(hidden).toContain("Fordon 1");
    expect(hidden).toContain("Fordon 2");
    expect(hidden).toContain("[namn]");
    expect(hidden).toContain("Kund 1");
    expect(p.reveal("Fordon 2 hos Kund 1 på Fil 1")).toBe(`TST456 hos ${SYNTHETIC_VEHICLE.customer} på ${FILE_NAMES[0]}`);
    // A lowercase ordinary word is not a name.
    expect(p.hide("testa gärna igen")).toBe("testa gärna igen");
  });

  it("reveals aliases split across streamed chunks", async () => {
    const r = tableStreamRevealer(tablePseudonyms(await dataset()));
    const out = ["Ford", "on 1 och For", "don", " 2 har Fil", " 2."].map((d) => r.push(d)).join("") + r.flush();
    expect(out).toBe(`TST123 och TST456 har ${FILE_NAMES[1]}.`);
  });

  it("the last check stops a contact person, a chassis number or a file name", async () => {
    const p = tablePseudonyms(await dataset());
    expect(() => assertNoTableIdentifiers("Kontakt: Testa Testsson", p)).toThrow();
    expect(() => assertNoTableIdentifiers("chassi 9999001", p)).toThrow();
    expect(() => assertNoTableIdentifiers(`fil ${FILE_NAMES[1]}`, p)).toThrow();
    expect(() => assertNoTableIdentifiers("Fordon 1 kostade 9 999 001 kr", p)).not.toThrow();
  });

  it("the answer without AI is the server's own text", async () => {
    const ds = await dataset();
    const result = tableResult(runAnalysis(ds, q({ analysis: "parts" })), q({ analysis: "parts" }));
    expect(fallbackAnswer(result)).toMatch(/går inte att avgöra/);
  });
});

// --- Follow-up questions -----------------------------------------------------------------------------

describe("reading questions", () => {
  const valid = { vehicleNumber: (a: string) => (/^Fordon [12]$/.test(a) ? Number(a.slice(7)) : null) };

  it("follows a conversation with fixed rules", () => {
    let query = readQuestion("Vilka reparationer återkommer inom 12 månader?", null, valid);
    expect(query).toEqual({ kind: "analysis", query: q({ analysis: "repeats", windowMonths: 12 }) });
    const step = (text: string) => {
      const next = readQuestion(text, query.kind === "analysis" ? query.query : null, valid);
      query = next;
      return next.kind === "analysis" ? next.query : null;
    };
    expect(step("Visa bara de som skett inom sex månader.")).toMatchObject({ analysis: "repeats", windowMonths: 6 });
    expect(step("Vilka gäller samma verkstad?")).toMatchObject({ analysis: "repeats", windowMonths: 6, sameWorkshop: true });
    expect(step("Sortera efter högst kostnad.")).toMatchObject({ analysis: "repeats", sort: "cost", sameWorkshop: true });
    expect(step("Visa de fem mest intressanta.")).toMatchObject({ sort: "cost", limit: 5 });
    expect(step("Jämför fordonen.")).toMatchObject({ analysis: "costs", by: "vehicle", limit: null });
    expect(step("Visa kostnad per år")).toMatchObject({ analysis: "costs", by: "year" });
    expect(step("Vilka reservdelar har bytts flera gånger inom 24 månader?")).toMatchObject({ analysis: "parts" });
    expect(readQuestion("Hej!", null, valid)).toEqual({ kind: "analysis", query: q({ analysis: "quality" }) });
  });

  it("accepts only valid planner proposals", () => {
    const plan: TablePlan = {
      kind: "analysis",
      clarify_text: null,
      analysis: "repeats",
      window_months: 5,
      same_workshop: "yes",
      include_maintenance: "keep",
      vehicle: { op: "set", alias: "Fordon 9" },
      group: { op: "set", code: "99; drop" },
      sort: "cost",
      limit: { op: "set", count: 5000 },
      by: "keep",
    };
    const turn = planToQuery(plan, q({ windowMonths: 12 }), { vehicleNumber: valid.vehicleNumber, groups: new Set(["10"]) });
    expect(turn).toEqual({ kind: "analysis", query: q({ windowMonths: 12, sameWorkshop: true, sort: "cost", limit: 100 }) });
    expect(planToQuery({ ...plan, kind: "other" }, null, { vehicleNumber: valid.vehicleNumber, groups: new Set() })).toEqual({ kind: "other" });
    expect(planToQuery({ ...plan, group: { op: "set", code: "10" }, vehicle: { op: "set", alias: "Fordon 2" } }, null, { vehicleNumber: valid.vehicleNumber, groups: new Set(["10"]) })).toMatchObject({
      query: { group: "10", vehicle: 2 },
    });
  });

  it("finds the previous query in the stored answers", () => {
    const stored = tableResult({ title: "t", lines: [], columns: [], rows: [], prompts: [] }, q({ analysis: "costs", by: "year" }));
    expect(previousQuery([{ role: "assistant", sources: [stored] }, { role: "user", sources: null }])).toEqual(q({ analysis: "costs", by: "year" }));
    expect(previousQuery([{ role: "assistant", sources: [{ ...stored, query: { analysis: "sql" } as unknown as TableQuery }] }])).toBeNull();
  });
});
