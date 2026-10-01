import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { chunkSections } from "./chunk";
import { extractDocument, UnsupportedDocumentError } from "./extract";

/** Builds a minimal valid single-page PDF with the given text. */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

async function zip(files: Record<string, string>) {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return new Uint8Array(await z.generateAsync({ type: "uint8array" }));
}

describe("extractDocument", () => {
  it("extracts text per page from PDF", async () => {
    const result = await extractDocument("pdf", minimalPdf("Laddkabel omfattas av garantin"));
    expect(result.pageCount).toBe(1);
    expect(result.sections[0]).toMatchObject({ location: "s. 1" });
    expect(result.sections[0].text).toContain("Laddkabel omfattas av garantin");
  });

  it("extracts rows per sheet from XLSX", async () => {
    const bytes = await zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Resultat" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Anläggning</t></si><si><t>Norr</t></si><si><t>Rörelseresultat</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1100000</v></c></row></sheetData></worksheet>',
    });
    const result = await extractDocument("xlsx", bytes);
    expect(result.sections).toEqual([
      { location: "Flik: Resultat", text: "Anläggning | Rörelseresultat\nNorr | 1100000" },
    ]);
  });

  it("extracts text per slide from PPTX", async () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const bytes = await zip({
      "ppt/slides/slide1.xml": slide("Rutin för garantiärenden"),
      "ppt/slides/slide2.xml": slide("Bifoga felkoder &amp; foton"),
    });
    const result = await extractDocument("pptx", bytes);
    expect(result.sections).toEqual([
      { location: "Bild 1", text: "Rutin för garantiärenden" },
      { location: "Bild 2", text: "Bifoga felkoder & foton" },
    ]);
  });

  it("decodes UTF-8 text files", async () => {
    const result = await extractDocument("txt", new TextEncoder().encode("﻿Åtgärd: byt laddkabel"));
    expect(result.sections[0].text).toBe("Åtgärd: byt laddkabel");
  });

  it("rejects files whose content does not match the declared type", async () => {
    await expect(extractDocument("pdf", new TextEncoder().encode("hej"))).rejects.toBeInstanceOf(UnsupportedDocumentError);
    await expect(extractDocument("docx", minimalPdf("x"))).rejects.toBeInstanceOf(UnsupportedDocumentError);
    await expect(extractDocument("txt", new Uint8Array([0x68, 0x00, 0x69]))).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });
});

describe("chunkSections", () => {
  it("keeps short sections whole and preserves locations", () => {
    const chunks = chunkSections([
      { location: "s. 1", text: "Första sidan har en kort text om garantin." },
      { location: "s. 2", text: "Andra sidan handlar om laddkablar och tillbehör." },
    ]);
    expect(chunks.map((c) => [c.index, c.location])).toEqual([
      [0, "s. 1"],
      [1, "s. 2"],
    ]);
  });

  it("splits long text into overlapping chunks on natural boundaries", () => {
    const sentence = "Garantin gäller i tjugofyra månader från leveransdagen. ";
    const text = sentence.repeat(60);
    const chunks = chunkSections([{ location: null, text }], 400, 80);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(400);
      expect(c.content.endsWith(".")).toBe(true);
    }
    // Overlap: the start of each chunk appears at the end of the previous one.
    const firstWords = chunks[1].content.split(" ").slice(0, 3).join(" ");
    expect(chunks[0].content).toContain(firstWords);
  });

  it("drops whitespace-only sections", () => {
    expect(chunkSections([{ location: "s. 1", text: "   \n\n  " }])).toEqual([]);
  });
});
