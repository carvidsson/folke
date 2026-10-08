import "server-only";

import type { Dataset } from "./analyses";

/**
 * Identifiers in structured Excel analysis never reach the AI provider (ADR-055). Registration and
 * chassis numbers become "Fordon N", customers "Kund N", contract numbers "Avtal N", sites
 * "Driftställe N" and files "Fil N"; contact persons have no alias – they are never in the brief, and a
 * name the user types becomes "[namn]". Aliases are mapped back on the server, also while streaming.
 */

export interface TablePseudonyms {
  hide(text: string): string;
  reveal(text: string): string;
  /** Every real identifier value, for the last check before a call. */
  identifiers: string[];
  vehicleAlias(regnr: string): string;
  contractAlias(number: string): string;
  siteAlias(name: string): string;
  /** "Fordon 2" → 2 (the dataset's vehicle number), or null. */
  vehicleNumber(alias: string): number | null;
}

const ALIAS = /\b(Fordon|Kund|Avtal|Driftställe|Fil) (\d{1,3})(?!\d)/g;
export const ALIAS_WORDS = ["Fordon ", "Kund ", "Avtal ", "Driftställe ", "Fil "] as const;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "ABC123" also as "ABC 123", "abc-123". */
function regnrPattern(regnr: string) {
  const m = regnr.replace(/[\s-]/g, "").match(/^([A-Za-zÅÄÖåäö]+)(\d.*)$/);
  const body = m ? `${escape(m[1])}[\\s-]?${escape(m[2])}` : escape(regnr);
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

function wordPattern(text: string, caseSensitive = false) {
  const t = text.trim().replace(/\s+/g, " ");
  const body = escape(t).replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, caseSensitive ? "gu" : "giu");
}

/** The name without a legal form ("Åkeri Exempel AB" → "Åkeri Exempel"), when that is still specific. */
function withoutLegalForm(name: string) {
  const bare = name.replace(/\s+(AB|Aktiebolag|HB|KB|Ek\.? ?för\.?|i likvidation)\.?$/i, "").trim();
  return bare !== name && bare.length >= 4 ? bare : null;
}

export function tablePseudonyms(ds: Dataset): TablePseudonyms {
  const t = ds.transactions;
  const vehicles = ds.vehicles;
  const customers: string[] = [];
  const contracts: string[] = [];
  const sites: string[] = [];
  for (const x of t) {
    const customer = x.customerName ?? x.customerNumber;
    if (customer && !customers.includes(customer)) customers.push(customer);
    if (x.contract.number && !contracts.includes(x.contract.number)) contracts.push(x.contract.number);
    if (x.site.name && !sites.includes(x.site.name)) sites.push(x.site.name);
  }
  const nameOf = new Map<string, string>();
  vehicles.forEach((v, i) => nameOf.set(`Fordon ${i + 1}`, v));
  customers.forEach((c, i) => nameOf.set(`Kund ${i + 1}`, c));
  contracts.forEach((c, i) => nameOf.set(`Avtal ${i + 1}`, c));
  sites.forEach((s, i) => nameOf.set(`Driftställe ${i + 1}`, s));
  ds.files.forEach((f, i) => nameOf.set(`Fil ${i + 1}`, f.fileName));

  // Replacements, most specific first.
  const replacements: [RegExp, string][] = [];
  const add = (value: string | null | undefined, alias: string, pattern = wordPattern) => {
    if (value && value.trim().length >= 2) replacements.push([pattern(value), alias]);
  };
  ds.files.forEach((f, i) => {
    add(f.fileName, `Fil ${i + 1}`);
    add(f.fileName.replace(/\.xlsx$/i, ""), `Fil ${i + 1}`);
  });
  const customerAlias = (x: (typeof t)[number]) => `Kund ${customers.indexOf((x.customerName ?? x.customerNumber)!) + 1}`;
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  for (const x of t) {
    if (x.customerName && once(`cn:${x.customerName}`)) {
      add(x.customerName, customerAlias(x));
      add(withoutLegalForm(x.customerName), customerAlias(x));
    }
    if (x.customerNumber && once(`cnr:${x.customerNumber}`)) add(x.customerNumber, (x.customerName ?? x.customerNumber) ? customerAlias(x) : "[kund]");
    if (x.site.name && once(`sn:${x.site.name}`)) add(x.site.name, `Driftställe ${sites.indexOf(x.site.name) + 1}`);
    if (x.site.number && x.site.name && once(`snr:${x.site.number}`)) add(x.site.number, `Driftställe ${sites.indexOf(x.site.name) + 1}`);
    if (x.contract.number && once(`ct:${x.contract.number}`)) add(x.contract.number, `Avtal ${contracts.indexOf(x.contract.number) + 1}`);
    if (x.chassis && once(`ch:${x.chassis}`)) add(x.chassis, `Fordon ${vehicles.indexOf(x.regnr) + 1}`);
    if (once(`rn:${x.regnr}`)) add(x.regnr, `Fordon ${vehicles.indexOf(x.regnr) + 1}`, regnrPattern);
    if (x.contact && once(`kp:${x.contact}`)) {
      add(x.contact, "[namn]");
      // A part of the name alone, only when written as a name (capitalised).
      for (const part of x.contact.split(/[\s,]+/)) if (part.length >= 3 && /^\p{Lu}/u.test(part)) replacements.push([wordPattern(part, true), "[namn]"]);
    }
  }
  replacements.sort((a, b) => b[0].source.length - a[0].source.length);

  const identifiers = [
    ...vehicles,
    ...customers,
    ...contracts,
    ...sites,
    ...ds.files.map((f) => f.fileName),
    ...t.flatMap((x) => [x.chassis, x.customerNumber, x.contact, x.site.number]),
  ].filter((v): v is string => !!v && v.trim().length >= 3);

  return {
    identifiers: [...new Set(identifiers)],
    hide(text) {
      let out = text;
      for (const [re, alias] of replacements) out = out.replace(re, alias);
      return out;
    },
    reveal(text) {
      return text.replace(ALIAS, (match) => nameOf.get(match) ?? match);
    },
    vehicleAlias: (regnr) => `Fordon ${vehicles.indexOf(regnr) + 1}`,
    contractAlias: (number) => `Avtal ${contracts.indexOf(number) + 1}`,
    siteAlias: (name) => `Driftställe ${sites.indexOf(name) + 1}`,
    vehicleNumber(alias) {
      const n = Number(alias.match(/^Fordon (\d{1,3})$/)?.[1]);
      return Number.isInteger(n) && n >= 1 && n <= vehicles.length ? n : null;
    },
  };
}

/** Maps aliases back while text streams: a chunk that ends inside a possible alias is held back. */
export function tableStreamRevealer(p: TablePseudonyms) {
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

function holdFrom(text: string): number {
  for (let i = Math.max(0, text.length - 16); i < text.length; i++) {
    const tail = text.slice(i);
    if (i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) continue;
    for (const word of ALIAS_WORDS) {
      if (word.startsWith(tail)) return i;
      if (tail.startsWith(word) && /^\d{0,3}$/.test(tail.slice(word.length))) return i;
    }
  }
  return text.length;
}

/**
 * Last check before a call (ADR-055): no real identifier – registration or chassis number, customer
 * name or number, contract number, site, contact person or file name – in what is sent. Throws.
 */
export function assertNoTableIdentifiers(text: string, p: TablePseudonyms) {
  const flat = text.toLowerCase();
  const compact = flat.replace(/[\s-]/g, "");
  for (const id of p.identifiers) {
    const v = id.toLowerCase().trim();
    const hit = /^\d+$/.test(v) ? new RegExp(`(?<!\\d)${v}(?!\\d)`).test(flat) : flat.includes(v) || (v.length >= 5 && compact.includes(v.replace(/[\s-]/g, "")));
    if (hit) throw new Error("Table chat: identifier in outgoing material");
  }
}
