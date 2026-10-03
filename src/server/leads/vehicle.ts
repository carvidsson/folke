import "server-only";

import type { ParsedLead } from "./lead-fields";

/**
 * Brand and model of the car a lead is about (ADR-048) – deterministic and
 * conservative. Sources, in order of trust:
 *   fields  – the form's Märke/Modell fields (listing leads)
 *   subject – the listing title in the subject ("Nytt meddelande angående: Audi Q4 …")
 *   page    – a campaign or brand page on the website (/kampanjer/skoda/skoda-elroq)
 * Nothing is inferred from the inbox's name, and e-mail leads are not read.
 * When a value cannot be established it is null ("Ej identifierad").
 *
 * Verified against 1 002 real leads in 30 days (2026-10): brand fields in
 * 486, subject cars in 353, website pages in 188, e-mail without car in 284.
 */

/** Our brands: models are matched against this catalogue (aliases → canonical name). */
const CATALOGUE: Record<string, [string, string[]][]> = {
  Volkswagen: [
    ["ID. Buzz", ["id buzz", "idbuzz", "id. buzz"]],
    ["ID. Polo", ["id. polo", "id polo", "idpolo"]],
    ["ID.3", ["id3", "id.3"]],
    ["ID.4", ["id4", "id.4"]],
    ["ID.5", ["id5", "id.5"]],
    ["ID.7", ["id7", "id.7"]],
    ["Golf", ["golf"]],
    ["Polo", ["polo"]],
    ["Tiguan", ["tiguan"]],
    ["T-Roc", ["t-roc", "troc"]],
    ["T-Cross", ["t-cross", "tcross"]],
    ["Taigo", ["taigo"]],
    ["Passat", ["passat"]],
    ["Arteon", ["arteon"]],
    ["Touareg", ["touareg"]],
    ["Touran", ["touran"]],
    ["Tayron", ["tayron"]],
    ["up!", ["up!", "e-up!", "up", "e-up"]],
    ["Caddy", ["caddy"]],
    ["Transporter", ["transporter"]],
    ["Multivan", ["multivan"]],
    ["California", ["california"]],
    ["Crafter", ["crafter"]],
    ["Amarok", ["amarok"]],
  ],
  Audi: [
    ["Q4 e-tron", ["q4 e-tron", "q4"]],
    ["Q6 e-tron", ["q6 e-tron", "q6"]],
    ["Q8 e-tron", ["q8 e-tron"]],
    ["A6 e-tron", ["a6 e-tron"]],
    ["e-tron GT", ["e-tron gt"]],
    ["A1", ["a1"]],
    ["A3", ["a3"]],
    ["A4", ["a4"]],
    ["A5", ["a5"]],
    ["A6", ["a6"]],
    ["A7", ["a7"]],
    ["A8", ["a8"]],
    ["Q2", ["q2"]],
    ["Q3", ["q3"]],
    ["Q5", ["q5"]],
    ["Q7", ["q7"]],
    ["Q8", ["q8"]],
    ["S3", ["s3"]],
    ["RS3", ["rs3", "rs 3"]],
    ["RS4", ["rs4", "rs 4"]],
    ["RS5", ["rs5", "rs 5"]],
    ["RS6", ["rs6", "rs 6"]],
    ["TT", ["tt"]],
  ],
  Škoda: [
    ["Fabia", ["fabia"]],
    ["Scala", ["scala"]],
    ["Kamiq", ["kamiq"]],
    ["Karoq", ["karoq"]],
    ["Kodiaq", ["kodiaq"]],
    ["Octavia", ["octavia"]],
    ["Superb", ["superb"]],
    ["Enyaq", ["enyaq"]],
    ["Elroq", ["elroq"]],
    ["Epiq", ["epiq"]],
  ],
  CUPRA: [
    ["Born", ["born"]],
    ["Formentor", ["formentor"]],
    ["Leon", ["leon"]],
    ["Ateca", ["ateca"]],
    ["Tavascan", ["tavascan"]],
    ["Terramar", ["terramar"]],
    ["Raval", ["raval"]],
  ],
  SEAT: [
    ["Ibiza", ["ibiza"]],
    ["Arona", ["arona"]],
    ["Leon", ["leon"]],
    ["Ateca", ["ateca"]],
    ["Tarraco", ["tarraco"]],
    ["Mii", ["mii"]],
  ],
};

/** Brand spellings → canonical name. Other brands are recognised but have no model catalogue. */
const BRANDS: Record<string, string> = {
  volkswagen: "Volkswagen",
  vw: "Volkswagen",
  "vw transportbilar": "Volkswagen",
  "vw-transportbilar": "Volkswagen",
  audi: "Audi",
  skoda: "Škoda",
  škoda: "Škoda",
  cupra: "CUPRA",
  seat: "SEAT",
  volvo: "Volvo",
  toyota: "Toyota",
  lexus: "Lexus",
  nissan: "Nissan",
  hyundai: "Hyundai",
  kia: "Kia",
  mini: "MINI",
  bmw: "BMW",
  "mercedes-benz": "Mercedes-Benz",
  mercedes: "Mercedes-Benz",
  porsche: "Porsche",
  tesla: "Tesla",
  ford: "Ford",
  peugeot: "Peugeot",
  renault: "Renault",
  opel: "Opel",
  mazda: "Mazda",
  honda: "Honda",
  citroën: "Citroën",
  citroen: "Citroën",
  dacia: "Dacia",
  fiat: "Fiat",
  jeep: "Jeep",
  mg: "MG",
  polestar: "Polestar",
  subaru: "Subaru",
  suzuki: "Suzuki",
  mitsubishi: "Mitsubishi",
  byd: "BYD",
  smart: "smart",
};

export interface Vehicle {
  brand: string | null;
  model: string | null;
  source: "subject" | "fields" | "page" | null;
}

const NONE: Vehicle = { brand: null, model: null, source: null };

function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function canonicalBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return BRANDS[norm(raw)] ?? null;
}

/** The catalogue model at the start of `text` (after the brand), longest alias first. */
export function catalogueModel(brand: string, text: string): string | null {
  const models = CATALOGUE[brand];
  if (!models) return null;
  const t = ` ${norm(text).replace(/[,*()]/g, " ")} `;
  const candidates = models.flatMap(([name, aliases]) => aliases.map((a) => [name, a] as const)).sort((a, b) => b[1].length - a[1].length);
  for (const [name, alias] of candidates) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\!]/g, "\\$&");
    // Only at the beginning of the model part: "Golf Alltrack" → Golf, but not a word deep in a sentence.
    if (new RegExp(`^ ${escaped}(?=[\\s\\-./]|$)`).test(t)) return name;
  }
  return null;
}

/** From "Volkswagen Tiguan Allspace", "Škoda Kodiaq", "Lexus NX350H" … */
function fromTitle(title: string): { brand: string; model: string | null } | null {
  const words = title.trim().split(/\s+/);
  for (const take of [2, 1]) {
    const brand = canonicalBrand(words.slice(0, take).join(" "));
    if (!brand) continue;
    const rest = words.slice(take).join(" ");
    if (CATALOGUE[brand]) return { brand, model: catalogueModel(brand, rest) };
    // Other brands: the listing title's first word after the brand is its model name.
    const first = rest.split(/\s+/)[0]?.replace(/[^\p{L}\d.!-]/gu, "");
    return { brand, model: first && first.length <= 30 ? first : null };
  }
  return null;
}

function fromPage(url: string | null): Vehicle {
  if (!url) return NONE;
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return NONE;
  }
  const campaign = /^\/kampanjer\/([a-z-]+)\/([a-z0-9-]+)/.exec(path);
  const brandPage = /^\/varumarken\/([a-z-]+)\/?$/.exec(path);
  const brand = canonicalBrand((campaign?.[1] ?? brandPage?.[1] ?? "").replace(/-/g, " "));
  if (!brand) return NONE;
  if (!campaign) return { brand, model: null, source: "page" };
  // "skoda-elroq", "volkswagen-id-7", "id-3", "audi-a3-sportback", "nya-cupra-raval"
  const slug = campaign[2].replace(/^nya-/, "").replace(new RegExp(`^${campaign[1]}-`), "").replace(/^(skoda|volkswagen|audi|cupra|seat)-/, "");
  const spaced = slug.replace(/^id-(\d)/, "id.$1").replace(/-/g, " ");
  return { brand, model: catalogueModel(brand, spaced), source: "page" };
}

export function identifyVehicle(parsed: ParsedLead | null): Vehicle {
  if (!parsed) return NONE;
  // 1. Structured fields.
  const fieldBrand = canonicalBrand(parsed.brand);
  if (fieldBrand) {
    // "Märke: SEAT, Modell: Cupra Tavascan": the model field names a more specific brand of ours.
    const named = (parsed.model ? fromTitle(parsed.model) : null) ?? (parsed.vehicle ? fromTitle(parsed.vehicle) : null);
    if (named && named.brand !== fieldBrand && CATALOGUE[named.brand] && named.model) return { brand: named.brand, model: named.model, source: "fields" };
    const fromSubject = parsed.vehicle ? fromTitle(parsed.vehicle) : null;
    // The model field sometimes repeats the brand ("Cupra Tavascan").
    const fieldModel = parsed.model ? (fromTitle(parsed.model)?.brand === fieldBrand ? parsed.model.trim().split(/\s+/).slice(1).join(" ") : parsed.model) : null;
    const model =
      (fieldModel && (CATALOGUE[fieldBrand] ? catalogueModel(fieldBrand, fieldModel) : fieldModel.trim().slice(0, 30))) ||
      (fromSubject?.brand === fieldBrand ? fromSubject.model : null);
    return { brand: fieldBrand, model, source: "fields" };
  }
  // 2. The listing title in the subject.
  if (parsed.vehicle) {
    const t = fromTitle(parsed.vehicle);
    if (t) return { brand: t.brand, model: t.model, source: "subject" };
  }
  // 3. A campaign or brand page.
  return fromPage(parsed.page);
}
