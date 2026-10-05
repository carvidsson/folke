import "server-only";

/**
 * Redaction of lead dialogues before AI analysis (ADR-046).
 *
 * Removes e-mail addresses, phone numbers, personnummer, registration
 * numbers, links, addresses, signatures and the names we know (the
 * customer's from the form, the sender names HubSpot reports). Sellers are
 * replaced by stable pseudonyms ("Säljare 2"), mapped back on the server.
 * Business context (car, price, questions) is kept.
 *
 * Pattern-based redaction cannot guarantee that every name in free text is
 * found. `leaksPersonalData` is therefore a second check: a dialogue that
 * still contains a known value or a pattern is not sent at all.
 */

export interface KnownPersonalData {
  /** Customer names, e-mail addresses, phone numbers and other identifiers. */
  customer: string[];
  /** Seller name → pseudonym ("Säljare 1"). The name and each part of it are replaced. */
  sellers: Map<string, string>;
  /**
   * Display names that are replaced only as a whole – e.g. HubSpot's sender
   * name "<seller> <company>", whose parts include ordinary words like "Bil".
   */
  literals?: Map<string, string>;
}

/**
 * Words that are never treated as parts of a name: the company, places and
 * brands occur in display names but are business context in the text.
 */
const NOT_NAME_PARTS = new Set([
  "bil",
  "bilar",
  "börjessons",
  "börjessonsbil",
  "ab",
  "alingsås",
  "volkswagen",
  "vw",
  "audi",
  "skoda",
  "škoda",
  "seat",
  "cupra",
  "begbil",
  "transportbilar",
  "försäljning",
  "sälj",
  "service",
]);

const EMAIL = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/gu;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const PERSONNUMMER = /\b(?:19|20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-+ ]?\d{4}\b/g;
// Swedish and international numbers: +46 70-123 45 67, 0701234567, 031-12 34 56 …
const PHONE = /(?:\+|00)\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d){5,10}\b|\b0\d{1,3}[\s/-]?\d(?:[\s-]?\d){4,8}\b/g;
// Long digit runs (8+ digits with spaces) that are not caught above.
const LONG_NUMBER = /\b\d(?:[ -]?\d){7,}\b/g;
// Engine codes ("TSI 150", "TDI 115") look like plates but are business context.
const PLATE = /\b(?!TSI|TDI|GTI|GTE|GTD|EVO|KWH|DSG)[A-ZÅÄÖ]{3} ?\d{2}[A-Z0-9]\b/g;
// Customers also write plates in lower case ("abc12d"; verified 2026-10-04). Without a space in any case;
// with a space only after "reg.nr" and the like – "kör 150" and "för 205" are ordinary text.
const PLATE_ANY_CASE = /\b(?!tsi|tdi|gti|gte|gtd|evo|kwh|dsg)[a-zåäö]{3}\d{2}[a-zåäö0-9]\b/gi;
const PLATE_AFTER_LABEL = /(\breg(?:istrerings)?\.?\s*(?:nr|nummer|nummret)?\.?:?\s*)[a-zåäö]{3} \d{2}[a-zåäö0-9]\b/gi;
// Vehicle identification numbers (17 characters, letters and digits, no I, O or Q).
const VIN = /\b(?=[A-HJ-NPR-Z0-9]{0,16}\d)(?=[A-HJ-NPR-Z0-9]{0,16}[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/gi;
// A date of birth on its own (YYMMDD or YYYYMMDD) – the first part of a personnummer. Round prices and
// mileages ("579900", "100000") are not valid dates and are kept.
const BIRTH_DATE = /\b(?:19|20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g;
// Social media handles ("@företaget").
const HANDLE = /(?<![\p{L}\d._-])@[\p{L}\d._]{2,}/gu;
const POSTAL = /\b\d{3} ?\d{2}\s+[A-ZÅÄÖ][a-zåäö]+/g;
const STREET = /\b[A-ZÅÄÖ][a-zåäö]+(?:gatan|vägen|gränd|torget|backen|stigen|allén|platsen|leden)\s+\d+\s?[A-Za-z]?\b/g;
const GREETING = /\b(Hej|Hejsan|Hallå|Tjena|Hi|Hello|Dear|Bästa|Kära)(\s+)([A-ZÅÄÖ][a-zåäöéü]+(?:\s+[A-ZÅÄÖ][a-zåäöéü]+)?)/g;
const SIGN_OFF = /^(?:mvh|m\.v\.h\.?|med vänlig(?:a)? hälsning(?:ar)?|vänlig(?:a)? hälsning(?:ar)?|hälsningar|trevlig dag|best regards|kind regards|regards|\/\/)\b.*$/i;
/**
 * Quoted history in e-mail replies: everything from the quote header on is
 * dropped. Verified header shapes: "Den fre 4 sep. 2026 17:21 <name> <",
 * "lör 5 sep. 2026 kl. 09:28 skrev <name> <", "tisdag 8 september 2026
 * 08:15:00 +0200, <address>:", "On … wrote:", "Från: …", "-----Original-----".
 */
function isQuoteHeader(line: string): boolean {
  const l = line.trim();
  if (/^(?:Från|From|Skickat|Sent):\s/i.test(l)) return true;
  if (/^-{2,}\s*(?:Ursprungligt meddelande|Original Message|Vidarebefordrat meddelande|Forwarded message)/i.test(l)) return true;
  if (/^_{10,}$/.test(l)) return true;
  const year = /\b20\d{2}\b/.test(l);
  if (year && /\b(?:skrev|wrote)\b|<|@|mailto/i.test(l)) return true;
  return /^Den\s.{0,40}\b20\d{2}\b.{0,20}\d{1,2}[:.]\d{2}/i.test(l);
}

/** Mail-client footers that say nothing about the dialogue. */
const CLIENT_FOOTER = /^(?:Skickat från|Sent from|Hämta|Get) (?:min |my )?(?:iPhone|iPad|Outlook|Android|Samsung|Mail)/i;

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A literal value as a whole word: not part of a longer word. Digits do not
 * protect it – a quoted header can glue a name to a time ("17:21Anna").
 */
function wordPattern(value: string, flags: string): RegExp {
  return new RegExp(`(?<!\\p{L})${escape(value)}(?!\\p{L})`, flags);
}

/** Whole-word, case-insensitive replacement of a literal value. */
/**
 * Name parts that are also everyday Swedish words ("per år", "bo i Göteborg", "max 1000 mil"): as part
 * of a name they are matched only when capitalised (verified 2026-10-04: a seller whose first name is also an everyday word turned
 * "1500 mil per år" into "1500 mil Säljare 24 år").
 */
const WORD_NAME_PARTS = new Set(["per", "bo", "max", "dag", "sten", "tor", "vide", "ek"]);

function replaceLiteral(text: string, value: string, replacement: string): string {
  const v = value.trim();
  if (v.length < 2) return text;
  if (WORD_NAME_PARTS.has(v.toLowerCase())) return text.replace(wordPattern(v[0].toUpperCase() + v.slice(1).toLowerCase(), "gu"), replacement);
  return text.replace(wordPattern(v, "giu"), replacement);
}

/** The values to search for: the full value and, for names, each part of 3+ letters. */
function variants(value: string): string[] {
  const parts = value
    .split(/\s+/)
    .filter((p) => p.length >= 3 && /^\p{L}/u.test(p) && !NOT_NAME_PARTS.has(p.toLowerCase()));
  return [value, ...parts].sort((a, b) => b.length - a.length);
}

function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex(isQuoteHeader);
  const kept = cut >= 0 ? lines.slice(0, cut) : lines;
  return kept.filter((l) => !l.trim().startsWith(">") && !CLIENT_FOOTER.test(l.trim())).join("\n");
}

/**
 * A signature on the sign-off line itself ("mvh namn", "Mvh. Förnamn Efternamn, telefon, e-post"; verified
 * 2026-10-04): the rest of the line is replaced, however long.
 */
const SIGN_OFF_INLINE =
  /^(\s*(?:mvh|m\.v\.h\.?|med vänlig(?:a)? hälsning(?:ar)?|vänlig(?:a)? hälsning(?:ar)?|hälsningar|best regards|kind regards|regards)[,.!:]?)[ \t]+\S.*$/i;
/** An e-mail address written with spaces ("namn@folke. example"). */
const EMAIL_SPACED = /[\p{L}\d._%+-]+[ \t]?@[ \t]?[\p{L}\d-]+(?:[ \t]?\.[ \t]?[\p{L}\d-]+)+/gu;
/** A name glued to the sign-off ("MvhNamn"; verified 2026-10-04). */
const GLUED_SIGN_OFF = /\b(mvh|Mvh|MVH)(\p{Lu}[\p{L}-]+)/gu;
/** A name signed with a slash at the end of a line ("… kvar? /Namn"). */
const SLASH_NAME = /(^|[\s.!?])\/{1,2}[ \t]?\p{Lu}[\p{L}-]+(?:[ \t]\p{Lu}[\p{L}-]+)?[ \t]*$/gmu;
/** An address label; its value – on the same line or the next – is an address. */
const ADDRESS_LABEL = /^\s*(?:faktura\s?-?adress|leveransadress|hemadress|postadress|adress|address)\s*[:.]?\s*(.*)$/i;

/**
 * Replaces up to four lines after a sign-off ("Mvh") – typically name, title, phone, address – and a
 * name on the sign-off line itself; and the value after an address label.
 */
function redactSignatures(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const address = ADDRESS_LABEL.exec(lines[i]);
    if (address) {
      if (address[1].trim()) {
        out.push(lines[i].slice(0, lines[i].length - address[1].length) + "[adress]");
        continue;
      }
      out.push(lines[i]);
      while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
      if (i + 1 < lines.length) {
        i++;
        out.push("[adress]");
      }
      continue;
    }
    out.push(lines[i].replace(SIGN_OFF_INLINE, "$1 [namn]"));
    if (SIGN_OFF.test(lines[i].trim())) {
      let skipped = 0;
      while (i + 1 < lines.length && skipped < 4 && lines[i + 1].trim().length <= 80) {
        i++;
        if (lines[i].trim()) skipped++;
      }
      if (skipped > 0) out.push("[signatur]");
    }
  }
  return out.join("\n");
}

export function redactText(input: string, known: KnownPersonalData): string {
  let text = stripQuotedHistory(input.replace(/\r\n/g, "\n"));
  text = redactSignatures(text.replace(GLUED_SIGN_OFF, "$1 [namn]")).replace(SLASH_NAME, "$1/[namn]");
  text = text.replace(EMAIL, "[e-post]").replace(EMAIL_SPACED, "[e-post]").replace(URL_PATTERN, "[länk]");
  text = text.replace(PERSONNUMMER, "[personnummer]").replace(PHONE, "[telefon]").replace(VIN, "[vin]").replace(LONG_NUMBER, "[nummer]");
  text = text.replace(BIRTH_DATE, "[nummer]").replace(HANDLE, "[konto]");
  text = text.replace(PLATE, "[regnr]").replace(PLATE_AFTER_LABEL, "$1[regnr]").replace(PLATE_ANY_CASE, "[regnr]");
  text = text.replace(STREET, "[adress]").replace(POSTAL, "[adress]");
  // Whole display names first, then sellers (pseudonyms), then the customer's own values.
  const literals = [...(known.literals ?? new Map<string, string>())].sort((a, b) => b[0].length - a[0].length);
  for (const [value, alias] of literals) text = replaceLiteral(text, value, alias);
  const sellers = [...known.sellers.entries()].flatMap(([name, alias]) => variants(name).map((v) => [v, alias] as const));
  for (const [value, alias] of sellers.sort((a, b) => b[0].length - a[0].length)) text = replaceLiteral(text, value, alias);
  for (const value of known.customer.flatMap(variants)) text = replaceLiteral(text, value, "[kund]");
  text = text.replace(GREETING, (match, word: string, space: string, name: string) =>
    /^Säljare$/.test(name.split(/\s+/)[0]) ? match : `${word}${space}[namn]`,
  );
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * True if a redacted text still contains something that looks like personal
 * data or one of the known values. Such a dialogue is not sent.
 */
export function leaksPersonalData(text: string, known: KnownPersonalData): boolean {
  return leakReason(text, known) !== null;
}

export type LeakReason = "email" | "personnummer" | "phone" | "customer" | "seller";

/** Why a redacted text is still unsafe (for counts and tests – never log the text). */
export function leakReason(text: string, known: KnownPersonalData): LeakReason | null {
  if (new RegExp(EMAIL.source, "u").test(text)) return "email";
  if (new RegExp(PERSONNUMMER.source).test(text)) return "personnummer";
  if (new RegExp(PHONE.source).test(text)) return "phone";
  const lower = text.toLowerCase();
  const present = (v: string) => {
    const t = v.trim();
    if (t.length < 3) return false;
    // Same rule as replaceLiteral: an everyday word counts as a name only when capitalised.
    if (WORD_NAME_PARTS.has(t.toLowerCase())) return wordPattern(t[0].toUpperCase() + t.slice(1).toLowerCase(), "u").test(text);
    return wordPattern(t.toLowerCase(), "u").test(lower);
  };
  if (known.customer.flatMap(variants).some(present)) return "customer";
  if ([...known.sellers.keys()].flatMap(variants).some(present)) return "seller";
  if ([...(known.literals?.keys() ?? [])].some(present)) return "seller";
  return null;
}

/** Capitalised words that are business context, never names. */
const BUSINESS_WORDS = new Set(
  [
    "säljare", "kund", "börjessons", "blocket", "wayke", "hemsida", "alingsås", "göteborg", "borås", "sverige",
    "volkswagen", "audi", "skoda", "škoda", "seat", "cupra", "porsche", "tesla", "volvo", "toyota", "kia", "bmw", "mercedes",
    "golf", "passat", "polo", "tiguan", "touareg", "tayron", "taigo", "arteon", "caddy", "multivan", "transporter", "amarok",
    "crafter", "california", "troc", "t-roc", "t-cross", "id", "buzz", "born", "formentor", "leon", "ateca", "arona", "ibiza",
    "octavia", "superb", "kodiaq", "karoq", "kamiq", "enyaq", "elroq", "fabia", "scala",
    "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag",
    "januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december",
    "jag", "vi", "du", "ni", "han", "hon", "de", "det", "den", "hej", "tack", "mvh", "ok", "okej",
    "teams", "google", "swish", "klarna", "santander", "volkswagen finans", "trafikverket", "transportstyrelsen",
  ].map((w) => w.toLowerCase()),
);

/**
 * A capitalised word that does not start a sentence or a line: after any
 * character other than . ! ? on the same line (also "] Anna", ": Anna"),
 * or glued to a digit ("17:21Anna").
 */
const MID_SENTENCE_CAPITALISED = /(?<=[^\s.!?][^\S\n]+|\d)(\p{Lu}\p{Ll}{2,})(?!\p{L})/gu;

/**
 * Run-level safety net for names the form does not know (a third person,
 * a colleague): a capitalised word in mid-sentence that is not a business
 * word, never occurs in lower case in the run and occurs in only one
 * dialogue is replaced by "[namn]". Ordinary words and repeated model or
 * place names are kept. Over-masking is accepted; under-masking is not.
 */
export function maskRareCapitalised(texts: string[]): string[] {
  const lower = new Set<string>();
  const dialoguesWith = new Map<string, number>();
  for (const text of texts) {
    for (const w of text.match(/\p{Ll}{3,}/gu) ?? []) lower.add(w);
    for (const w of new Set([...text.matchAll(MID_SENTENCE_CAPITALISED)].map((m) => m[1]))) {
      dialoguesWith.set(w, (dialoguesWith.get(w) ?? 0) + 1);
    }
  }
  const rare = (w: string) =>
    !BUSINESS_WORDS.has(w.toLowerCase()) && !lower.has(w.toLowerCase()) && (dialoguesWith.get(w) ?? 0) <= 1;
  return texts.map((text) => text.replace(MID_SENTENCE_CAPITALISED, (w) => (rare(w) ? "[namn]" : w)));
}

/** Stable pseudonyms in order of first appearance: "Säljare 1", "Säljare 2" … */
export function pseudonymise(actorIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of actorIds) if (!map.has(id)) map.set(id, `Säljare ${map.size + 1}`);
  return map;
}
