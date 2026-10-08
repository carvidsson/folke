/**
 * Synthetic Excel workbooks for tests (ADR-055): real OOXML (zip) built with JSZip, with shared
 * strings, date styles, empty cells and the layout of Scania's contract exports. Fictional values only.
 */
import JSZip from "jszip";

export type FixtureCell = string | number | { date: string } | { text: string; inline: true } | null | undefined;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function column(i: number) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const serial = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

/** `rows[i]` is sheet row `firstRow + i`; `cells[j]` is column A + j. Null/undefined cells are left out. */
export async function buildXlsx(sheets: { name: string; rows: FixtureCell[][]; firstRow?: number }[], { relsTargetFirst = false } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const shared: string[] = [];
  const sharedIndex = (s: string) => {
    const i = shared.indexOf(s);
    if (i >= 0) return i;
    shared.push(s);
    return shared.length - 1;
  };
  sheets.forEach((sheet, si) => {
    const first = sheet.firstRow ?? 1;
    const rows = sheet.rows
      .map((cells, ri) => {
        const r = first + ri;
        const xml = cells
          .map((c, ci) => {
            if (c === null || c === undefined) return "";
            const ref = `${column(ci)}${r}`;
            if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === "string") return `<c r="${ref}" t="s"><v>${sharedIndex(c)}</v></c>`;
            if ("date" in c) return `<c r="${ref}" s="1"><v>${serial(c.date)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.text)}</t></is></c>`;
          })
          .join("");
        return xml ? `<row r="${r}">${xml}</row>` : `<row r="${r}"/>`;
      })
      .join("");
    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="4"/></cellXfs></styleSheet>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) =>
        relsTargetFirst
          ? `<Relationship Target="worksheets/sheet${i + 1}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Id="rId${i + 1}"/>`
          : `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

/** The header row of Scania's contract exports, columns B–AN (as in the real exports, "Regnr" twice). */
export const SCANIA_HEADERS = [
  "Regnr", "Kundnamn", "KundNr", "AvtalsNr", "Regnr", "Avtalstyp", "Status", "Start Datum", "Slut Datum", "Faktureringskund",
  "FaktRef", "FaktKundNr", "ÅF (avtalssäljande)", "Distrikt", "Rep ÅF", "Fordonsslag", "ChNr", "Kontaktperson", "Mst",
  "Driftställe (nr)", "Driftställe (namn)", "Rep Datum", "Kred Datum", "Del Omf", "Del Omf Benämning", "Hgrp", "Ugrp",
  "Hgrp Benämning", "Rep Orsak", "AoNr", "AtgNr", "Arb Kost (egen)", "Mtrl Kost (egen)", "Arb Kost (främmande)",
  "Mtrl Kost (främmande)", "Tot Kost", "Ers Fakt Arb", "Ers Fakt Mtrl",
];

export interface ScaniaFixtureRow {
  date: string;
  mst: number | null;
  ao: string;
  hgrp: string;
  ugrp: string;
  name?: string;
  maintenance?: boolean;
  workshop?: string;
  labour?: number;
  material?: number;
  labourExt?: number;
  materialExt?: number;
  reason?: string;
  /** Leave the cost cells empty (an empty cell in the middle of a row). */
  emptyCosts?: boolean;
}

export const SYNTHETIC_VEHICLE = {
  regnr: "TST123",
  chassis: "9999001",
  customer: "Syntetiska Åkeriet AB",
  customerNumber: "880001",
  contract: "770001",
  contact: "Testa Testsson",
  siteNumber: "55501",
  site: "Testdepån Norr",
};

export function scaniaRows(rows: ScaniaFixtureRow[], v = SYNTHETIC_VEHICLE, { sumRow = true, start = "2024-01-15", end = "2027-01-14" } = {}): FixtureCell[][] {
  const out: FixtureCell[][] = [
    [null, "Kostnadsrapport serviceavtal (syntetisk)"],
    [],
    [null, "Urval: syntetiskt"],
    [],
    [null, ...SCANIA_HEADERS],
  ];
  let total = 0;
  for (const r of rows) {
    const [l, m, le, me] = [r.labour ?? 0, r.material ?? 0, r.labourExt ?? 0, r.materialExt ?? 0];
    total += l + m + le + me;
    const costs: FixtureCell[] = r.emptyCosts ? [null, null, null, null, null] : [l, m, le, me, l + m + le + me];
    out.push([
      null,
      v.regnr,
      v.customer,
      v.customerNumber,
      `${v.contract}     `,
      v.regnr,
      "1 Grönt Kort repavtal",
      "Aktiv",
      { date: start },
      { date: end },
      v.customer,
      "undefined",
      v.customerNumber,
      "Syntetisk Verkstad Väst",
      "Väst",
      r.workshop ?? "Syntetisk Verkstad Väst",
      "Lastbil",
      v.chassis,
      v.contact,
      r.mst,
      v.siteNumber,
      v.site,
      { date: r.date },
      { date: r.date },
      r.maintenance ? "U1" : "B1",
      r.maintenance ? "Underhåll (enligt plan)" : "Reparation chassi",
      r.hgrp,
      r.ugrp,
      r.name ?? `${r.hgrp} SYNTETISK GRUPP`,
      r.reason ?? "undefined",
      `${r.ao}     `,
      "1",
      ...costs,
      0,
      0,
    ]);
  }
  // The export's own total row: only "Tot Kost" (column AK).
  if (sumRow) out.push([null, ...Array(35).fill(null), Math.round(total * 100) / 100]);
  return out;
}

export async function scaniaWorkbook(rows: ScaniaFixtureRow[], v = SYNTHETIC_VEHICLE, options?: Parameters<typeof scaniaRows>[2]) {
  return buildXlsx([{ name: "Kostnader", rows: scaniaRows(rows, v, options) }]);
}
