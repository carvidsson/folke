import "server-only";

import JSZip from "jszip";

/**
 * A structured reader for Excel workbooks (2026-10-08). Unlike the text extraction for search
 * (documents/extract.ts), it keeps every cell at its column (empty cells never shift values), reads
 * dates from the cell's number format, and keeps the sheet and the original row number of every row –
 * so a calculation can always be traced back to its cells. Pure: bytes in, cells out; nothing is sent
 * anywhere.
 */

export type CellValue = { type: "text"; value: string } | { type: "number"; value: number } | { type: "date"; value: string } | { type: "bool"; value: boolean } | { type: "error"; value: string };

export interface SheetRow {
  /** Original row number in the sheet (1-based, as Excel shows it). */
  row: number;
  /** Cells by zero-based column index (A = 0); a missing entry is an empty cell. */
  cells: (CellValue | undefined)[];
}

export interface Sheet {
  name: string;
  rows: SheetRow[];
}

const XML_ENTITIES: [RegExp, string][] = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
];

function decode(text: string) {
  let out = text;
  for (const [re, ch] of XML_ENTITIES) out = out.replace(re, ch);
  return out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}

/** "AN" → 39 (zero-based column index). */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 39 → "AN". */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** An Excel serial date (1900 system) as YYYY-MM-DD; the time of day is dropped. */
export function serialToDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

/** Built-in date formats (14–22, 45–47) or a custom format with day, month or year parts. */
function dateFormat(id: number, custom: Map<number, string>): boolean {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
  const code = custom.get(id);
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dy]/i.test(bare) || (/m/i.test(bare) && !/[0#]/.test(bare));
}

/**
 * Swedish and plain number formats as text: "1 234,50", "1 234,50 kr", "-1145", "1,234.50" is NOT
 * guessed (ambiguous). Null when the text is not a number.
 */
export function parseSwedishNumber(text: string): number | null {
  const t = text.replace(/[\s  ]/g, "").replace(/(kr|sek|:-)$/i, "");
  if (/^-?\d+(,\d+)?$/.test(t)) return Number(t.replace(",", "."));
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return null;
}

export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(bytes);
  const shared: string[] = [];
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedXml) {
    for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    }
  }
  const styles = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  const custom = new Map([...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), decode(m[2])]));
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const styleIsDate = [...cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)].map((m) => dateFormat(Number(m[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0), custom));

  // Sheets in workbook order, through the relationships (sheetN.xml is not always the N:th sheet).
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  // Attribute order varies between writers.
  const target = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].flatMap((m) => {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1];
      const to = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      return id && to ? [[id, to.replace(/^\/?xl\//, "")] as const] : [];
    }),
  );
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(m[0].match(/name="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/r:id="([^"]+)"/)?.[1];
    const path = rid && target.get(rid) ? `xl/${target.get(rid)}` : null;
    const xml = path ? await zip.file(path)?.async("string") : undefined;
    if (!xml) continue;
    const rows: SheetRow[] = [];
    for (const rowXml of xml.match(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const row = Number(rowXml.match(/\br="(\d+)"/)?.[1]);
      const cells: (CellValue | undefined)[] = [];
      for (const cell of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = cell.match(/\br="([A-Z]+)\d+"/)?.[1];
        if (!ref) continue;
        const t = cell.match(/\bt="(\w+)"/)?.[1];
        const s = Number(cell.match(/\bs="(\d+)"/)?.[1] ?? 0);
        const v = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = cell.match(/<is>([\s\S]*?)<\/is>/)?.[1];
        let value: CellValue | undefined;
        if (t === "s" && v !== undefined) value = { type: "text", value: shared[Number(v)] ?? "" };
        else if (t === "inlineStr" && inline !== undefined) value = { type: "text", value: decode((inline.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join("")) };
        else if (t === "str" && v !== undefined) value = { type: "text", value: decode(v) };
        else if (t === "b" && v !== undefined) value = { type: "bool", value: v === "1" };
        else if (t === "e" && v !== undefined) value = { type: "error", value: decode(v) };
        else if (v !== undefined && v !== "") {
          const n = Number(v);
          value = Number.isFinite(n) ? (styleIsDate[s] ? { type: "date", value: serialToDate(n) } : { type: "number", value: n }) : { type: "text", value: decode(v) };
        }
        if (value && !(value.type === "text" && value.value === "")) cells[columnIndex(ref)] = value;
      }
      if (Number.isFinite(row)) rows.push({ row, cells });
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
