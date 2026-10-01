import "server-only";

import JSZip from "jszip";

import type { DocumentFileType } from "@/lib/domain/types";

/**
 * Text extraction for uploaded documents. Runs on the server only; no data
 * leaves the application. Returns text per logical section (page, sheet,
 * slide) so citations can point to a location.
 */

export interface ExtractedSection {
  /** Human-readable location, e.g. "s. 3", "Flik: Resultat", "Bild 4". */
  location: string | null;
  text: string;
}

export interface ExtractionResult {
  sections: ExtractedSection[];
  pageCount: number | null;
}

export class UnsupportedDocumentError extends Error {}

const ZIP_TYPES: DocumentFileType[] = ["docx", "xlsx", "pptx"];

/** Verifies that the bytes match the declared type (magic numbers). */
export function assertFileSignature(type: DocumentFileType, bytes: Uint8Array) {
  const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (type === "pdf" && !startsWith([0x25, 0x50, 0x44, 0x46])) {
    throw new UnsupportedDocumentError("Filen är inte en giltig PDF.");
  }
  if (ZIP_TYPES.includes(type) && !startsWith([0x50, 0x4b, 0x03, 0x04])) {
    throw new UnsupportedDocumentError("Filen är inte ett giltigt Office-dokument.");
  }
  if (["txt", "md", "csv"].includes(type) && bytes.subarray(0, 4096).includes(0)) {
    throw new UnsupportedDocumentError("Filen verkar inte vara en textfil.");
  }
}

function decodeXml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function naturalOrder(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return {
    pageCount: totalPages,
    sections: (text as string[]).map((t, i) => ({ location: `s. ${i + 1}`, text: t })),
  };
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return { pageCount: null, sections: [{ location: null, text: value }] };
}

async function extractXlsx(bytes: Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(bytes);
  const shared: string[] = [];
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedXml) {
    for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    }
  }

  // Sheet names in workbook order.
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeXml(m[1]));

  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort(naturalOrder);

  const sections: ExtractedSection[] = [];
  for (const [i, file] of sheetFiles.entries()) {
    const xml = await zip.file(file)!.async("string");
    const rows: string[] = [];
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const type = cell.match(/ t="(\w+)"/)?.[1];
        const v = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = cell.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
        const value = type === "s" && v !== undefined ? shared[Number(v)] : type === "inlineStr" ? inline : v;
        if (value !== undefined && value !== "") cells.push(decodeXml(String(value)));
      }
      if (cells.length) rows.push(cells.join(" | "));
    }
    if (rows.length) sections.push({ location: `Flik: ${names[i] ?? i + 1}`, text: rows.join("\n") });
  }
  return { pageCount: null, sections };
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort(naturalOrder);
  const sections: ExtractedSection[] = [];
  for (const [i, file] of slides.entries()) {
    const xml = await zip.file(file)!.async("string");
    const paragraphs = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => decodeXml((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")))
      .filter(Boolean);
    if (paragraphs.length) sections.push({ location: `Bild ${i + 1}`, text: paragraphs.join("\n") });
  }
  return { pageCount: slides.length, sections };
}

function extractText(bytes: Uint8Array): ExtractionResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  return { pageCount: null, sections: [{ location: null, text }] };
}

export async function extractDocument(type: DocumentFileType, bytes: Uint8Array): Promise<ExtractionResult> {
  assertFileSignature(type, bytes);
  switch (type) {
    case "pdf":
      return extractPdf(bytes);
    case "docx":
      return extractDocx(bytes);
    case "xlsx":
      return extractXlsx(bytes);
    case "pptx":
      return extractPptx(bytes);
    case "txt":
    case "md":
    case "csv":
      return extractText(bytes);
  }
}
