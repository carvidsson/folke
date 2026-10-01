import "server-only";

import type { ExtractedSection } from "./extract";

/**
 * Splits extracted text into overlapping chunks for full-text retrieval.
 * Chunks never cross section boundaries, so each keeps its location
 * (page/sheet/slide) for citations.
 */

export interface Chunk {
  index: number;
  content: string;
  location: string | null;
}

export const CHUNK_TARGET = 1200;
export const CHUNK_OVERLAP = 200;

function normalize(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Best cut position at or before `max`: paragraph, line, sentence, word. */
function cutPoint(text: string, max: number) {
  if (text.length <= max) return text.length;
  const window = text.slice(0, max);
  for (const sep of ["\n\n", "\n", ". ", "? ", "! ", " "]) {
    const at = window.lastIndexOf(sep);
    if (at > max * 0.5) return at + sep.length;
  }
  return max;
}

export function chunkSections(sections: ExtractedSection[], target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    let rest = normalize(section.text);
    while (rest.length > 0) {
      const end = cutPoint(rest, target);
      const content = rest.slice(0, end).trim();
      if (content.length >= 20 || (content && chunks.length === 0)) {
        chunks.push({ index: chunks.length, content, location: section.location });
      }
      if (end >= rest.length) break;
      // Step back for overlap, aligned to a word boundary.
      const back = Math.max(end - overlap, 1);
      const space = rest.indexOf(" ", back);
      const next = space > 0 && space < end ? space + 1 : end;
      rest = rest.slice(next);
    }
  }
  return chunks;
}
