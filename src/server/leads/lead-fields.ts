import "server-only";

/**
 * Deterministic parser for the form text HubSpot puts in a lead's first
 * message ("Label: value" lines, verified against the real inbox).
 *
 * Rules: only known labels start a field; any other line continues the
 * current free-text field (customers write "Jag undrar också: …"). A value
 * that is missing, a placeholder ("Virtuell", "-", mileage 0) or does not
 * match its format gives null – the parser never invents a value.
 *
 * `personal` holds the customer's own details for redaction only. It must
 * never leave the server or reach an AI provider.
 */

type Field =
  | "source"
  | "name"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "regnr"
  | "subject"
  | "message"
  | "brand"
  | "model"
  | "carUrl"
  | "mileage"
  | "page"
  | "facility"
  | "ignored"
  | "extra"
  | "contactVia"
  | "tradeInRegnr"
  | "tradeInMileage"
  | "company";

const LABELS: Record<string, Field> = {
  "källa": "source",
  namn: "name",
  fname_lname: "name",
  "förnamn": "firstName",
  efternamn: "lastName",
  "e-post": "email",
  epost: "email",
  email: "email",
  telefon: "phone",
  mobilnummer: "phone",
  registreringsnummer: "regnr",
  "ämne": "subject",
  "lead meddelande": "message",
  meddelande: "message",
  "märke": "brand",
  modell: "model",
  "bilkort url": "carUrl",
  "mätarställning": "mileage",
  "skickat från sida": "page",
  conversion_uri: "page",
  "anläggning": "facility",
  facility: "facility",
  // The dealer's own address, not the customer's: not needed.
  facility_email: "ignored",
  "extra info": "extra",
  "kontaktas via": "contactVia",
  "inbytesbil regnr": "tradeInRegnr",
  "inbytesbil mätarställning": "tradeInMileage",
  bolag: "company",
};

/** Fields whose value may continue on the following lines. */
const FREE_TEXT: ReadonlySet<Field> = new Set(["message", "extra"]);

export type LeadFormat = "listing" | "website" | "facility_form" | "unknown";

export interface ParsedLead {
  format: LeadFormat;
  source: string | null;
  vehicle: string | null;
  brand: string | null;
  model: string | null;
  /** Only a value in Swedish plate format; "Virtuell" and other placeholders give null. */
  regnr: string | null;
  /**
   * What the registration number field contained (ADR-048): a plate, the dealer system's placeholder
   * "Virtuell" (used for listings without a physical car, e.g. incoming or to order – a signal, not a
   * vehicle status), something else, or nothing. The number itself is never stored.
   */
  regnrKind: RegnrKind | null;
  carUrl: string | null;
  mileageKm: number | null;
  page: string | null;
  facility: string | null;
  contactVia: string | null;
  hasTradeIn: boolean;
  /** The form's company field ("Bolag") is filled in: the customer gave a company (lead-needs-1). */
  hasCompany: boolean;
  contact:{ name: boolean; email: boolean; phone: boolean };
  /** Customer free text (contains personal data – redact before any use). */
  message: string | null;
  /** For redaction only. */
  personal: { names: string[]; emails: string[]; phones: string[]; other: string[] };
}

const PLATE = /^[A-ZÅÄÖ]{3} ?\d{2}[A-Z0-9]$/i;
const EMPTY = /^(-|–|—|n\/a|ingen|inget|null|undefined)?$/i;

function clean(value: string | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim() ?? "";
  return EMPTY.test(v) ? null : v;
}

/** Free text keeps its line breaks. */
function cleanText(value: string | undefined): string | null {
  const v = (value ?? "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
  return EMPTY.test(v) ? null : v;
}

export type RegnrKind = "plate" | "virtual" | "other";

/** Case- and whitespace-insensitive; "Virtuell", " VIRTUELL ", "virtuell." count as virtual. */
export function regnrKind(value: string | null): RegnrKind | null {
  if (!value) return null;
  if (PLATE.test(value)) return "plate";
  if (value.toLowerCase().replace(/[^a-zåäö]/g, "") === "virtuell") return "virtual";
  return "other";
}

function plate(value: string | null): string | null {
  if (!value || !PLATE.test(value)) return null;
  return value.replace(/\s/g, "").toUpperCase();
}

function mileage(value: string | null): number | null {
  if (!value || !/^\d{1,3}(?:[  ]?\d{3})*(?:\s?(km|mil))?$/i.test(value)) return null;
  const n = Number(value.replace(/[^\d]/g, ""));
  // 0 is the listing feeds' placeholder (seen in almost every lead): unknown, not "new".
  if (!Number.isFinite(n) || n <= 0) return null;
  return /mil$/i.test(value) ? n * 10 : n;
}

function url(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The car from the subject line, when its form is one we have seen. */
export function vehicleFromSubject(subject: string | null): string | null {
  if (!subject) return null;
  const patterns = [
    /^Nytt meddelande angående:\s*(.+)$/i,
    /^Ang\.\s*(.+)$/i,
    /^[A-ZÅÄÖ]{3} ?\d{2}[A-Z0-9]\s+-\s+(.+)$/i,
  ];
  for (const p of patterns) {
    const m = p.exec(subject.trim());
    if (m) return clean(m[1]);
  }
  return null;
}

function label(raw: string): Field | undefined {
  return LABELS[raw.replace(/\s+/g, " ").trim().toLowerCase()];
}

export function parseLeadText(text: string | null | undefined): ParsedLead {
  const values: Partial<Record<Field, string>> = {};
  let current: Field | null = null;
  let recognised = 0;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^([^:]{2,40}):[ \t]?(.*)$/.exec(line);
    const field = m ? label(m[1]) : undefined;
    if (m && field) {
      recognised++;
      current = field;
      // A repeated label keeps the first value (never merge two sources).
      if (values[field] === undefined) values[field] = m[2];
      continue;
    }
    if (current && FREE_TEXT.has(current) && line) {
      values[current] = `${values[current] ?? ""}\n${line}`.trim();
    }
  }

  const format: LeadFormat =
    recognised < 2
      ? "unknown"
      : values.source !== undefined
        ? "listing"
        : values.page !== undefined
          ? "website"
          : values.facility !== undefined
            ? "facility_form"
            : "unknown";

  const source = clean(values.source) ?? (format === "website" ? "Hemsida" : null);
  const subject = clean(values.subject);
  const name = clean(values.name);
  const first = clean(values.firstName);
  const last = clean(values.lastName);
  const email = clean(values.email);
  const phone = clean(values.phone);
  const company = clean(values.company);
  const names = [name, first, last, first && last ? `${first} ${last}` : null].filter((v): v is string => Boolean(v));
  const regnrRaw = clean(values.regnr);
  const tradeIn = clean(values.tradeInRegnr);

  return {
    format,
    source,
    vehicle: vehicleFromSubject(subject),
    brand: clean(values.brand),
    model: clean(values.model),
    regnr: plate(regnrRaw),
    regnrKind: regnrKind(regnrRaw),
    carUrl: url(clean(values.carUrl)),
    mileageKm: mileage(clean(values.mileage)),
    page: url(clean(values.page)),
    facility: clean(values.facility),
    contactVia: clean(values.contactVia),
    hasTradeIn: Boolean(tradeIn),
    hasCompany: Boolean(company),
    contact: { name: names.length > 0, email: Boolean(email), phone: Boolean(phone) },
    message: [cleanText(values.message), cleanText(values.extra)].filter(Boolean).join("\n") || null,
    personal: {
      names,
      emails: email ? [email] : [],
      phones: phone ? [phone] : [],
      other: [company, tradeIn].filter((v): v is string => Boolean(v)),
    },
  };
}
