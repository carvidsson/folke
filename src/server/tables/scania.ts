import "server-only";

import { parseSwedishNumber, readWorkbook, serialToDate, type CellValue, type Sheet } from "./xlsx";

/**
 * Scania service and repair contract exports ("Kostnader", 2026-10-08) – the first analysis package for
 * structured Excel in Analysassistenten. A sheet is a Scania export only when every required header is
 * on one row; any other workbook keeps the ordinary document handling. Each transaction keeps its file,
 * sheet and original row; the export's own sum row is recognised, checked against the transactions and
 * never counted as one.
 */

/** Headers that must all be present on the header row (column mapping from the real exports: B–AN, row 5). */
export const REQUIRED_HEADERS = [
  "Regnr",
  "Kundnamn",
  "KundNr",
  "AvtalsNr",
  "Avtalstyp",
  "Start Datum",
  "Slut Datum",
  "Rep ÅF",
  "ChNr",
  "Mst",
  "Driftställe (nr)",
  "Driftställe (namn)",
  "Rep Datum",
  "Del Omf",
  "Del Omf Benämning",
  "Hgrp",
  "Ugrp",
  "Hgrp Benämning",
  "Rep Orsak",
  "AoNr",
  "AtgNr",
  "Arb Kost (egen)",
  "Mtrl Kost (egen)",
  "Arb Kost (främmande)",
  "Mtrl Kost (främmande)",
  "Tot Kost",
] as const;

const OPTIONAL_HEADERS = ["Status", "Kred Datum", "Kontaktperson", "Ers Fakt Arb", "Ers Fakt Mtrl"] as const;

type Header = (typeof REQUIRED_HEADERS)[number] | (typeof OPTIONAL_HEADERS)[number];

export interface ScaniaTransaction {
  /** Stable within the dataset: "<file>:<row>". */
  id: string;
  /** 1-based position of the file in the analysis (the model only ever sees this number). */
  file: number;
  fileName: string;
  sheet: string;
  row: number;
  regnr: string;
  chassis: string | null;
  customerName: string | null;
  customerNumber: string | null;
  /** Personal data: shown to the owner only, never sent to the model. */
  contact: string | null;
  contract: { number: string | null; type: string | null; status: string | null; start: string | null; end: string | null };
  workshop: string | null;
  site: { number: string | null; name: string | null };
  repairDate: string | null;
  creditDate: string | null;
  /** Odometer (km) as exported; may be missing or inconsistent. */
  odometer: number | null;
  scope: { code: string | null; name: string | null };
  group: { main: string | null; sub: string | null; name: string | null };
  /** Free text: shown to the owner only, never sent to the model in V1. */
  reason: string | null;
  order: string | null;
  action: string | null;
  costs: { labourOwn: number; materialOwn: number; labourExternal: number; materialExternal: number; total: number };
}

export interface ScaniaFile {
  fileName: string;
  sheet: string;
  headerRow: number;
  transactions: ScaniaTransaction[];
  /** The export's own total row, if any, and whether it equals the sum of the transactions (to the öre). */
  sumRow: { row: number; total: number; matches: boolean } | null;
  warnings: string[];
}

const EMPTY = new Set(["", "undefined", "null", "-"]);

function text(cell: CellValue | undefined): string | null {
  if (!cell) return null;
  const raw = cell.type === "text" ? cell.value : cell.type === "number" ? String(cell.value) : cell.type === "date" ? cell.value : null;
  const t = raw?.trim() ?? null;
  return t === null || EMPTY.has(t.toLowerCase()) ? null : t;
}

function number(cell: CellValue | undefined): number | null {
  if (!cell) return null;
  if (cell.type === "number") return cell.value;
  if (cell.type === "text") return EMPTY.has(cell.value.trim().toLowerCase()) ? null : parseSwedishNumber(cell.value);
  return null;
}

function date(cell: CellValue | undefined): string | null {
  if (!cell) return null;
  if (cell.type === "date") return cell.value;
  // A serial without a date format, within plausible years (1990–2100).
  if (cell.type === "number" && cell.value > 32_874 && cell.value < 73_051) return serialToDate(cell.value);
  if (cell.type === "text" && /^\d{4}-\d{2}-\d{2}/.test(cell.value.trim())) return cell.value.trim().slice(0, 10);
  return null;
}

/** The header row of a Scania export in the first rows of the sheet, with each header's column. */
function findHeader(sheet: Sheet): { row: number; columns: Map<Header, number> } | null {
  for (const r of sheet.rows.slice(0, 25)) {
    const columns = new Map<Header, number>();
    r.cells.forEach((c, i) => {
      const h = c?.type === "text" ? (c.value.trim() as Header) : null;
      // The first column with a header wins (the export repeats "Regnr").
      if (h && ([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS] as string[]).includes(h) && !columns.has(h)) columns.set(h, i);
    });
    if (REQUIRED_HEADERS.every((h) => columns.has(h))) return { row: r.row, columns };
  }
  return null;
}

const ROUND = (n: number) => Math.round(n * 100) / 100;

/** The Scania export in a workbook, or null when it is not one (then nothing here applies to the file). */
export async function parseScaniaExport(bytes: Uint8Array, fileName: string, file = 1): Promise<ScaniaFile | null> {
  let sheets: Sheet[];
  try {
    sheets = await readWorkbook(bytes);
  } catch {
    return null;
  }
  for (const sheet of sheets) {
    const header = findHeader(sheet);
    if (!header) continue;
    const col = (r: { cells: (CellValue | undefined)[] }, h: Header) => (header.columns.has(h) ? r.cells[header.columns.get(h)!] : undefined);
    const transactions: ScaniaTransaction[] = [];
    const warnings: string[] = [];
    let sumRow: ScaniaFile["sumRow"] = null;
    let partsMismatch = 0;
    let unreadDates = 0;
    for (const r of sheet.rows) {
      if (r.row <= header.row || !r.cells.some(Boolean)) continue;
      const regnr = text(col(r, "Regnr"));
      const order = text(col(r, "AoNr"));
      const total = number(col(r, "Tot Kost"));
      if (!regnr && !order && !text(col(r, "AvtalsNr"))) {
        // No vehicle, contract or work order: the export's total row when it carries a total.
        if (total !== null && !sumRow) sumRow = { row: r.row, total, matches: false };
        else warnings.push(`Rad ${r.row} saknar fordon och arbetsorder och räknas inte.`);
        continue;
      }
      if (!regnr) {
        warnings.push(`Rad ${r.row} saknar registreringsnummer och räknas inte.`);
        continue;
      }
      const costs = {
        labourOwn: number(col(r, "Arb Kost (egen)")) ?? 0,
        materialOwn: number(col(r, "Mtrl Kost (egen)")) ?? 0,
        labourExternal: number(col(r, "Arb Kost (främmande)")) ?? 0,
        materialExternal: number(col(r, "Mtrl Kost (främmande)")) ?? 0,
        total: total ?? 0,
      };
      if (Math.abs(costs.labourOwn + costs.materialOwn + costs.labourExternal + costs.materialExternal - costs.total) > 0.01) partsMismatch++;
      const repairDate = date(col(r, "Rep Datum"));
      if (!repairDate) unreadDates++;
      transactions.push({
        id: `${file}:${r.row}`,
        file,
        fileName,
        sheet: sheet.name,
        row: r.row,
        regnr,
        chassis: text(col(r, "ChNr")),
        customerName: text(col(r, "Kundnamn")),
        customerNumber: text(col(r, "KundNr")),
        contact: text(col(r, "Kontaktperson")),
        contract: { number: text(col(r, "AvtalsNr")), type: text(col(r, "Avtalstyp")), status: text(col(r, "Status")), start: date(col(r, "Start Datum")), end: date(col(r, "Slut Datum")) },
        workshop: text(col(r, "Rep ÅF")),
        site: { number: text(col(r, "Driftställe (nr)")), name: text(col(r, "Driftställe (namn)")) },
        repairDate,
        creditDate: date(col(r, "Kred Datum")),
        odometer: number(col(r, "Mst")),
        scope: { code: text(col(r, "Del Omf")), name: text(col(r, "Del Omf Benämning")) },
        group: { main: text(col(r, "Hgrp")), sub: text(col(r, "Ugrp")), name: text(col(r, "Hgrp Benämning")) },
        reason: text(col(r, "Rep Orsak")),
        order,
        action: text(col(r, "AtgNr")),
        costs,
      });
    }
    if (sumRow) {
      const sum = ROUND(transactions.reduce((s, t) => s + t.costs.total, 0));
      sumRow.matches = Math.abs(sum - sumRow.total) < 0.005;
      if (!sumRow.matches) warnings.push(`Summaraden (rad ${sumRow.row}) stämmer inte med transaktionerna.`);
    }
    if (partsMismatch) warnings.push(`${partsMismatch} rader där total kostnad inte är summan av arbete och material.`);
    if (unreadDates) warnings.push(`${unreadDates} rader saknar läsbart reparationsdatum.`);
    if (!transactions.length) warnings.push("Inga transaktionsrader hittades.");
    return { fileName, sheet: sheet.name, headerRow: header.row, transactions, sumRow, warnings };
  }
  return null;
}
