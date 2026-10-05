/**
 * lead-needs-1 (ADR-052): what the customer asks for, as structured labels per dialogue.
 *
 * - Only what the customer expresses (in a message or a form field) – never what the seller brings up,
 *   which is kept apart as seller topics.
 * - Several labels per dialogue. A missing label means "not mentioned", never "no".
 * - No scores. Every count is computed on the server from the stored labels.
 *
 * Shared by the server (classification, counts, chat) and the pages (labels).
 */

/** Customer needs: what matters to the customer about the purchase. */
export const NEEDS = [
  "private_leasing",
  "business",
  "leasing_unspecified",
  "financing",
  "monthly_cost",
  "trade_in",
  "availability",
  "fast_delivery",
  "delivery_time",
  "home_delivery",
  "price_negotiation",
  "product_facts",
  "factory_order",
] as const;
export type Need = (typeof NEEDS)[number];

/** Concrete, observable purchase signals – no score. */
export const SIGNALS = ["wants_to_buy", "wants_to_reserve", "makes_offer", "asks_how_to_proceed", "gives_offer_data", "compares_competitor"] as const;
export type PurchaseSignal = (typeof SIGNALS)[number];

/** What the customer asks the dealer to do. */
export const REQUESTS = ["send_offer", "call_me", "book_visit", "send_info", "value_trade_in", "find_alternative"] as const;
export type CustomerRequest = (typeof REQUESTS)[number];

/**
 * "soon": the customer says they want to buy or need the car within about a month. Validation of
 * lead-needs-1 showed that a later time could not be told reliably from visit plans, so there is no "later".
 */
export const TIMEFRAMES = ["soon", "none"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * What the dialogue is about. Needs are counted among purchase dialogues only: questions about a car the
 * customer has already bought, or e-mails that are not about buying, would otherwise look like needs.
 */
export const PURPOSES = ["purchase", "after_sales", "other"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Why the car the customer asked about could not be had, when the dialogue says so. */
export const UNAVAILABLE = ["none", "sold", "reserved", "not_in_stock", "price_mismatch", "delivery_mismatch"] as const;
export type Unavailable = (typeof UNAVAILABLE)[number];

/**
 * What the seller did with the customer's need when the car could not be had – visible in HubSpot or not.
 * Never a verdict: "not_visible" and "not_determinable" say what HubSpot shows, not that something failed.
 */
export const CARRIED = ["proposed_alternative", "other_solution", "next_step", "asked_further", "not_visible", "not_determinable", "customer_ended", "not_applicable"] as const;
export type Carried = (typeof CARRIED)[number];

/** Where a label comes from: the customer's own message, or a form field (deterministic). */
export type LabelSource = "customer_message" | "form";

export interface NeedLabel {
  code: Need;
  /** "declined": the customer explicitly says no ("inte leasing"). Not counted as a need. */
  stance: "expressed" | "declined";
  source: LabelSource;
  /** Message number in the dialogue (1-based) – a customer message; 0 for a form field. */
  message: number;
  /** Short avidentified paraphrase (checked for personal data before saving). */
  note: string;
}

export interface SignalLabel<T extends string> {
  code: T;
  source: LabelSource;
  message: number;
  note: string;
}

export interface DialogueNeeds {
  purpose: Purpose;
  needs: NeedLabel[];
  signals: SignalLabel<PurchaseSignal>[];
  requests: SignalLabel<CustomerRequest>[];
  timeframe: Timeframe;
  unavailable: { situation: Unavailable; carried: Carried; note: string };
  /** Need codes the seller raised that the customer had not expressed before (kept apart). */
  sellerTopics: Need[];
  evidence: "sufficient" | "limited";
  /** False when there was nothing to send (only form fields, no text): labels come from the form only. */
  ai: boolean;
}

/** Labels as the pages and the chat show them (Swedish, sentence case). */
export const NEED_LABELS: Record<Need, string> = {
  private_leasing: "Privatleasing",
  business: "Företag",
  leasing_unspecified: "Leasing, oklart vilken",
  financing: "Finansiering eller billån",
  monthly_cost: "Månadskostnad, oklart hur",
  trade_in: "Inbyte",
  availability: "Om bilen finns kvar",
  fast_delivery: "Snabb leverans",
  delivery_time: "Leveranstid",
  home_delivery: "Leverans hem eller transport",
  price_negotiation: "Rabatt eller prisförhandling",
  product_facts: "Utrustning, skick eller fakta",
  factory_order: "Beställa ny bil",
};

export const SIGNAL_LABELS: Record<PurchaseSignal, string> = {
  wants_to_buy: "Vill köpa",
  wants_to_reserve: "Vill reservera",
  makes_offer: "Lägger bud eller prisförslag",
  asks_how_to_proceed: "Frågar hur man går vidare",
  gives_offer_data: "Lämnar uppgifter för offert",
  compares_competitor: "Jämför med annat erbjudande",
};

export const REQUEST_LABELS: Record<CustomerRequest, string> = {
  send_offer: "Offert eller kalkyl",
  call_me: "Bli uppringd",
  book_visit: "Besök eller provkörning",
  send_info: "Mer information eller bilder",
  value_trade_in: "Värdering av inbytesbil",
  find_alternative: "Hitta en annan bil",
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  purchase: "Köp eller leasing av bil",
  after_sales: "Efter köpet",
  other: "Annat ärende",
};

export const UNAVAILABLE_LABELS: Record<Exclude<Unavailable, "none">, string> = {
  sold: "Såld",
  reserved: "Reserverad",
  not_in_stock: "Finns inte att få",
  price_mismatch: "Priset passade inte",
  delivery_mismatch: "Leveranstiden passade inte",
};

export const CARRIED_LABELS: Record<Exclude<Carried, "not_applicable">, string> = {
  proposed_alternative: "Alternativ föreslogs",
  other_solution: "Annan lösning föreslogs",
  next_step: "Nästa steg föreslogs",
  asked_further: "Säljaren frågade vidare om behovet",
  not_visible: "Inget sådant syns i HubSpot",
  not_determinable: "Går inte att avgöra från HubSpot",
  customer_ended: "Kunden avslutade",
};

/** Purchase signals that count as a clear signal (an explicit wish to buy, reserve, bid or proceed). */
export const STRONG_SIGNALS: readonly PurchaseSignal[] = ["wants_to_buy", "wants_to_reserve", "makes_offer", "asks_how_to_proceed"];

/**
 * The page's summary of lead-needs-1 for a selection and period – counts only, computed on the server.
 * Population of every share: `purchase` (analysed purchase dialogues).
 */
export interface NeedsOverview {
  version: string;
  /** Leads in the selection, leads with a customer message, of those with a stored needs analysis. */
  leads: number;
  candidates: number;
  analysed: number;
  /** Analysed dialogues about buying or leasing a car: the population. */
  purchase: number;
  needs: { code: Need; count: number }[];
  requests: { code: CustomerRequest; count: number }[];
  signals: { code: PurchaseSignal; count: number }[];
  /** Purchase dialogues with at least one clear purchase signal (STRONG_SIGNALS). */
  strong: number;
  /** Purchase dialogues where the customer wants to buy or needs the car within about a month. */
  soon: number;
  /** Pairs of needs that pass the thresholds (never shown for a small material). */
  combinations: { a: Need; b: Need; count: number }[];
  unavailable: { total: number; situations: { code: Exclude<Unavailable, "none">; count: number }[]; carried: { group: CarriedGroup; count: number }[] };
}

/** The behaviours in "carried" that show the seller taking the need further, visibly. */
export const CARRIED_FORWARD: readonly Carried[] = ["proposed_alternative", "other_solution", "next_step", "asked_further"];

/**
 * How "carried" is shown and counted. Validation of lead-needs-1 showed that the kind of step (an
 * alternative car or another solution) varies between runs, while whether the need was visibly carried
 * forward is stable – so the pages and the chat count the groups and show the kind only per dialogue.
 */
export type CarriedGroup = "forward" | "not_visible" | "not_determinable" | "customer_ended";
export function carriedGroup(c: Carried): CarriedGroup | null {
  if (CARRIED_FORWARD.includes(c)) return "forward";
  return c === "not_visible" || c === "not_determinable" || c === "customer_ended" ? c : null;
}
export const CARRIED_GROUP_LABELS: Record<CarriedGroup, string> = {
  forward: "Behovet fördes synligt vidare",
  not_visible: "Inget sådant syns i HubSpot",
  not_determinable: "Går inte att avgöra från HubSpot",
  customer_ended: "Kunden avslutade",
};
