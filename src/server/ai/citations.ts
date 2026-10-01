import "server-only";

/**
 * Citation check after an answer is complete.
 *
 * The model may only cite the numbered excerpts the server retrieved and
 * sent. Any other number (invented, or from an injected "source") is
 * removed from the stored answer, and only excerpts that are actually cited
 * are stored as the answer's sources. Citations are renumbered in order of
 * first use, so [n] in the stored text matches source n in the stored list.
 */

/** [1], [1, 2], and with a location note: [1, s. 4] or [2; avsnittet "Undantag"]. */
const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)((?:\s*[,;:]\s*|\s+)(?!\d)[^\]\n]{1,80})?\]/g;

export interface CitationResult {
  content: string;
  /**
   * 1-based indices (as sent to the model) of the excerpts the answer cites,
   * in order of first use. In `content`, excerpt cited[i] is numbered i + 1.
   */
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
    const renumbered = [...new Set(valid.map((n) => cited.indexOf(n) + 1))];
    return renumbered.length ? `[${renumbered.join(", ")}${note ?? ""}]` : "";
  });
  const cleaned = removed ? content.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ") : content;
  return { content: separateCustomerCitations(cleaned), cited, removed };
}

const STAFF_SECTION = /^[ \t]*(?:#{1,6}[ \t]*)?\**Underlag för medarbetaren\**:?[ \t]*$/im;
const MARKER = /[ \t]*\[\d{1,3}(?:\s*,\s*\d{1,3})*(?:(?:\s*[,;:]\s*|\s+)(?!\d)[^\]\n]{1,80})?\]/g;

/**
 * Customer-ready texts (fixed source rule): when an answer has the section
 * "Underlag för medarbetaren", no source markers may remain in the customer
 * text before it. Markers found there are removed and listed in the staff
 * section instead, so traceability is kept (the cited sources are stored
 * with the answer as before). Answers without the section are unchanged.
 */
export function separateCustomerCitations(text: string): string {
  const match = STAFF_SECTION.exec(text);
  if (!match) return text;
  const customer = text.slice(0, match.index);
  const staff = text.slice(match.index);
  const moved = customer.match(MARKER)?.map((m) => m.trim()) ?? [];
  if (!moved.length) return text;
  const cleanCustomer = customer.replace(MARKER, "").replace(/[ \t]+([.,;:!?])/g, "$1");
  const missing = [...new Set(moved)].filter((m) => !staff.includes(m));
  const note = missing.length ? `\n- Källor för uppgifterna i texten: ${missing.join(" ")}` : "";
  const [heading, ...rest] = staff.split("\n");
  return `${cleanCustomer}${heading}${note}${rest.length ? `\n${rest.join("\n")}` : ""}`;
}
