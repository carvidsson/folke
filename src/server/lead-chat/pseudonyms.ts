import "server-only";

/**
 * Seller names never reach the AI provider (ADR-050). Each seller the user may see gets a stable alias
 * ("Säljare 3", by actor id) for the turn; the brief, the user's question and the history use the
 * aliases, and the answer is mapped back to names on the server – also while it streams.
 */

export interface Pseudonyms {
  aliasOf: Map<string, string>;
  nameOf: Map<string, string>;
  /** Real names in the text → aliases (full names, then unique first names). */
  hide(text: string): string;
  /** Aliases in the text → real names. */
  reveal(text: string): string;
}

const ALIAS = /Säljare (\d{1,3})(?!\d)/g;

/**
 * First names that are also ordinary Swedish words ("per telefon", "hans svar", "1 jan"). Alone, they
 * only count as a name when written as one (capitalised) – otherwise ordinary text would be garbled
 * and a seller could be named where nobody meant one.
 */
export const NAME_WORDS = new Set(
  "per hans dag jan maj max sten stig björn axel love liv vilja rut sol bror dan tor".split(" "),
);

function firstNamePattern(first: string, escape: (s: string) => string) {
  const word = NAME_WORDS.has(first.toLowerCase());
  const head = word ? escape(first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()) : escape(first);
  return new RegExp(`(?<!\\p{L})${head}(?:s(?!\\p{L}))?(?!\\p{L})`, word ? "gu" : "giu");
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `sellers`: the sellers the user may see (they get aliases). `others`: every other known seller
 * name – masked as "[namn]" if the user types one, never revealed or mapped.
 */
export function pseudonymsFor(sellers: { id: string; name: string }[], others: string[] = []): Pseudonyms {
  const sorted = [...sellers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const aliasOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const [i, s] of sorted.entries()) {
    aliasOf.set(s.id, `Säljare ${i + 1}`);
    nameOf.set(`Säljare ${i + 1}`, s.name);
  }
  const visible = new Set(sorted.map((s) => s.name.toLowerCase()));
  const hidden = [...new Set(others.filter((n) => n.trim() && !visible.has(n.toLowerCase())))];
  const word = (text: string) => new RegExp(`(?<!\\p{L})${escape(text)}(?:s(?!\\p{L}))?(?!\\p{L})`, "giu");
  const replacements: [RegExp, string][] = [];
  // Full names first, longest first.
  const full = [...sorted.map((s) => ({ name: s.name, to: aliasOf.get(s.id)! })), ...hidden.map((name) => ({ name, to: "[namn]" }))];
  for (const x of full.sort((p, q) => q.name.length - p.name.length)) replacements.push([word(x.name), x.to]);
  // Then first names: one only a visible seller has becomes that seller's alias; any other – shared,
  // or a seller the user may not see – cannot be mapped and becomes "[namn]". Never sent as typed.
  const firstOf = (name: string) => name.split(/\s+/)[0] ?? "";
  const owners = new Map<string, string[]>();
  for (const x of [...sorted.map((s) => ({ name: s.name, to: aliasOf.get(s.id)! })), ...hidden.map((name) => ({ name, to: "[namn]" }))]) {
    const first = firstOf(x.name);
    if (first.length < 3 || first === x.name) continue;
    owners.set(first.toLowerCase(), [...(owners.get(first.toLowerCase()) ?? []), x.to]);
  }
  for (const [first, to] of owners) replacements.push([firstNamePattern(first, escape), to.length === 1 ? to[0] : "[namn]"]);
  return {
    aliasOf,
    nameOf,
    hide(text) {
      let out = text;
      for (const [re, alias] of replacements) out = out.replace(re, alias);
      return out;
    },
    reveal(text) {
      return text.replace(ALIAS, (match) => nameOf.get(match) ?? match);
    },
  };
}

/**
 * Maps aliases back while text streams: a chunk that ends inside a possible alias ("Sälj", "Säljare 1")
 * is held back until the next chunk shows where it ends.
 */
export function streamRevealer(p: Pseudonyms) {
  let pending = "";
  return {
    push(delta: string): string {
      const text = pending + delta;
      const cut = holdFrom(text);
      pending = text.slice(cut);
      return p.reveal(text.slice(0, cut));
    },
    flush(): string {
      const out = p.reveal(pending);
      pending = "";
      return out;
    },
  };
}

/** Index from which the text may still be the start of an alias. */
function holdFrom(text: string): number {
  const word = "Säljare ";
  for (let i = Math.max(0, text.length - 12); i < text.length; i++) {
    const tail = text.slice(i);
    if (word.startsWith(tail)) return i;
    if (tail.startsWith(word) && /^\d{0,3}$/.test(tail.slice(word.length))) return i;
  }
  return text.length;
}

/** Stored per-dialogue texts may mention aliases of the run that classified them – never the chat's. */
export function neutralizeStoredAliases(text: string): string {
  return text.replace(/Säljare \d+/g, "säljaren").replace(/\{\{A-\d+\}\}/g, "säljaren");
}

/** Stored combined analyses refer to sellers as {{A-123}} (HubSpot user id): the chat's alias instead. */
export function aliasSellerTokens(text: string, p: Pseudonyms): string {
  return text.replace(/\{\{(A-\d+)\}\}/g, (_m, id: string) => p.aliasOf.get(id) ?? "en säljare");
}

/**
 * Last check before a lead call (ADR-050): the brief and the earlier answers never contain a HubSpot
 * id (thread, inbox or user), a seller token or a HubSpot link. Throws – a hit is a bug upstream.
 */
export function assertNoIdentifiers(text: string) {
  if (/\{\{A-\d+\}\}|\bA-\d{5,}\b|(?<!\d)\d{8,}(?!\d)|hubspot\.com|live-messages/i.test(text)) {
    throw new Error("Lead chat: identifier in outgoing material");
  }
}
