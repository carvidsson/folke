import "server-only";

/**
 * Citation check after an answer is complete.
 *
 * The model may only cite the numbered excerpts the server retrieved and
 * sent. Any other number (invented, or from an injected "source") is
 * removed from the stored answer, and only excerpts that are actually cited
 * are stored as the answer's sources.
 */

/** [1], [1, 2], and with a location note: [1, s. 4] or [2; avsnittet "Undantag"]. */
const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)((?:\s*[,;:]\s*|\s+)(?!\d)[^\]\n]{1,80})?\]/g;

export interface CitationResult {
  content: string;
  /** 1-based indices of retrieved excerpts that the answer cites, in order of first use. */
  cited: number[];
  /** Number of citation numbers that did not match any retrieved excerpt. */
  removed: number;
}

export function verifyCitations(answer: string, contextSize: number): CitationResult {
  const cited: number[] = [];
  let removed = 0;
  const content = answer.replace(CITATION, (_match, list: string, note: string | undefined) => {
    const valid = list
      .split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => {
        const ok = Number.isInteger(n) && n >= 1 && n <= contextSize;
        if (!ok) removed++;
        return ok;
      });
    for (const n of valid) if (!cited.includes(n)) cited.push(n);
    return valid.length ? `[${valid.join(", ")}${note ?? ""}]` : "";
  });
  return { content: removed ? content.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ") : content, cited, removed };
}
