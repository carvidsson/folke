/**
 * The lead analysis report as the admin page receives it (ADR-046, ADR-047).
 *
 * Contains no customer names, e-mail addresses, phone numbers or message
 * texts – only facts computed from HubSpot data, seller names (employees,
 * for system administrators) and AI classifications of redacted dialogues.
 * The three layers are kept apart: `facts`, `ai.dialogues`/`ai.counts`, `ai.summary`.
 *
 * Codes are stable English values (they are stored); the page translates them.
 */

export type ArrivalWindow = "business_hours" | "weekday_off_hours" | "weekend";

/**
 * What HubSpot shows – never more. registered_reply: a human seller reply is
 * registered in HubSpot. no_registered_reply: none is registered (the
 * customer may still have been contacted by phone). uncertain: an outgoing
 * message we cannot classify came first.
 */
export type ResponseStatus = "registered_reply" | "no_registered_reply" | "uncertain";

export type ExclusionReason = "spam" | "no_messages" | "starts_with_outgoing" | "fetch_failed";

export interface InboxOption {
  id: string;
  name: string;
}

export interface LeadRow {
  threadId: string;
  arrivedAt: string;
  arrivalWindow: ArrivalWindow;
  channel: "form" | "email" | "other";
  source: string | null;
  formName: string | null;
  vehicle: string | null;
  status: ResponseStatus;
  firstResponseAt: string | null;
  calendarMinutes: number | null;
  businessMinutes: number | null;
  ownerId: string | null;
  responderId: string | null;
  assignmentEvents: number;
  movedIntoInbox: boolean;
  threadOpen: boolean;
  customerMessages: number;
  sellerMessages: number;
  internalComments: number;
  /**
   * The lead has a registered reply, but the customer wrote last and no
   * later seller message is registered (it may have been answered elsewhere).
   */
  customerWroteLast: boolean;
  inboxId: string;
  /** HubSpot's latest-message time for the thread: detects changes without reading the messages. */
  latestMessageAt: string | null;
  lastCustomerMessageAt: string | null;
  /** First seller message after the customer's last one, and whether the seller wrote again a day later. */
  firstSellerAfterCustomerAt: string | null;
  followedUp: boolean;
  /** Only when identified from the lead itself – never guessed. */
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleSource: "subject" | "fields" | "page" | null;
  /** The registration number field: plate, "Virtuell" (a listing signal, not a vehicle status), other, or absent. */
  regnrKind: "plate" | "virtual" | "other" | null;
}

export interface Distribution {
  label: string;
  count: number;
}

/** Response times. The population is always the leads WITH a registered seller reply (`n`). */
export interface ResponseStats {
  n: number;
  medianCalendarMinutes: number | null;
  medianBusinessMinutes: number | null;
  /** Of the n leads with a registered reply: first reply within 1 / 4 business hours. */
  withinOneBusinessHour: number;
  withinFourBusinessHours: number;
}

export interface SellerFacts {
  id: string;
  name: string;
  ownedLeads: number;
  firstResponses: number;
  response: ResponseStats;
  /** Fewer than SMALL_SAMPLE_SELLER first responses: show, but do not draw conclusions. */
  smallSample: boolean;
}

export interface LeadFacts {
  leads: number;
  bySource: Distribution[];
  byChannel: Distribution[];
  byArrivalWindow: Record<ArrivalWindow, number>;
  /** Index 0 = 00–01 Stockholm time. */
  byHour: number[];
  /** Index 0 = Monday. */
  byWeekday: number[];
  status: Record<ResponseStatus, number>;
  /** Leads without a registered reply whose thread is open / closed in HubSpot. */
  noReplyOpen: number;
  noReplyClosed: number;
  response: ResponseStats;
  responseByArrivalWindow: Record<ArrivalWindow, ResponseStats>;
  /** Among leads with a registered reply: the customer wrote last (thread open / closed). */
  customerWroteLast: { total: number; open: number; closed: number };
  /** Among leads with a registered reply. */
  owner: { same: number; different: number; noOwner: number };
  movedIntoInbox: number;
  smallSample: boolean;
}

export interface DatasetInfo {
  threadsFetched: number;
  /** Threads with activity in the period but created before it. */
  outsidePeriod: number;
  leads: number;
  excluded: { reason: ExclusionReason; count: number }[];
  /** False when some threads could not be read: the figures are then partial. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// AI classification (relevance model, ADR-047)
// ---------------------------------------------------------------------------

export const INTENTS = [
  "price_or_offer",
  "financing_or_leasing",
  "trade_in",
  "availability",
  "test_drive_or_visit",
  "equipment_or_facts",
  "delivery",
  "other",
  "unclear",
] as const;
export type Intent = (typeof INTENTS)[number];

export const PURCHASE_INTENTS = ["clear", "interested", "information_only", "unclear"] as const;
export type PurchaseIntent = (typeof PURCHASE_INTENTS)[number];

export const CAR_STATUSES = ["available", "sold_or_reserved", "unknown"] as const;
export type CarStatus = (typeof CAR_STATUSES)[number];

export const ALTERNATIVES = ["yes", "no", "not_applicable", "unknown"] as const;
export type AlternativeOffered = (typeof ALTERNATIVES)[number];

/**
 * Seller behaviours, each judged in context: was it relevant in this
 * dialogue, and if so, was it done? A behaviour that was not relevant is
 * never counted as missing.
 */
export const BEHAVIOURS = [
  "answered_questions",
  "next_step",
  "needs_questions",
  "visit_or_test_drive",
  "follow_up",
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** done / missing: relevant and done / not done. not_relevant. unclear: cannot be judged from the text. */
export const BEHAVIOUR_STATUSES = ["done", "missing", "not_relevant", "unclear"] as const;
export type BehaviourStatus = (typeof BEHAVIOUR_STATUSES)[number];

export interface BehaviourJudgement {
  status: BehaviourStatus;
  /** One short sentence; empty when there is nothing to explain. */
  reason: string;
}

/**
 * lead-ai-3: the customer's situation first, then whether the seller moved it
 * forward. Short, avidentified text written by the model from redacted input
 * (checked for personal data before it is stored).
 */
export const PROGRESS = ["moved_forward", "partly", "stalled", "closed_by_customer", "unclear"] as const;
export type Progress = (typeof PROGRESS)[number];

/**
 * lead-ai-3.1: what HubSpot shows about how the dialogue continued (ADR-048). Offers are often sent or
 * attached in HubSpot, but may also come from the dealer system (DMS) or be handled by phone – so Folke
 * never assumes either.
 * - visible: the next step or the outcome is visible in HubSpot (an answer, an offer in the text or as
 *   an attachment, a booking, a decision).
 * - not_determinable: the dialogue ends where a continuation was expected (offer basis given, offer
 *   promised) and nothing more is visible: an offer from the DMS, a call – or a process that stopped.
 * - stated_other_channel: the dialogue itself says the next step happens by phone, at a meeting or in
 *   another system. What happened there is still not visible.
 */
export const CONTINUATIONS = ["visible", "not_determinable", "stated_other_channel"] as const;
export type Continuation = (typeof CONTINUATIONS)[number];

/** Opportunities that are visible in the dialogue itself (the seller wrote after the signal). */
export const OPPORTUNITY_TYPES = ["unanswered_questions", "competitor_offer", "visit_interest", "sold_without_alternative", "purchase_signal"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/** What worked, visibly in the dialogue. */
export const STRENGTH_TYPES = ["interest_to_next_step", "visit_booked", "questions_answered", "alternative_offered"] as const;
export type StrengthType = (typeof STRENGTH_TYPES)[number];

export interface SituationAssessment {
  /** What the customer is trying to achieve, in one sentence. */
  goal: string;
  /** The customer's concrete questions and whether the seller's text answered them (not_due: no later seller message). */
  questions: { text: string; answered: "yes" | "partly" | "no" | "not_due" }[];
  signals: string[];
  timeframe: string;
  /** Only when the customer states it. */
  budget: string;
  objections: string[];
  /** What the seller needed to know before a reasonable next step. */
  infoNeeded: string[];
  progress: Progress;
  progressReason: string;
  missedOpportunity: "yes" | "no" | "unclear";
  missedReason: string;
  /** lead-ai-3.1 (absent in lead-ai-3 rows). */
  continuation?: Continuation;
  /** The customer and the seller agreed on a next step (a time, a visit, a call). */
  agreedNextStep?: boolean;
  opportunities?: OpportunityType[];
  strengths?: StrengthType[];
}

export interface DialogueClassification {
  threadId: string;
  sellerId: string | null;
  assessment: SituationAssessment | null;
  intent: Intent;
  purchaseIntent: PurchaseIntent;
  carStatus: CarStatus;
  alternativeOffered: AlternativeOffered;
  behaviours: Record<Behaviour, BehaviourJudgement>;
  observations: string[];
  evidence: "sufficient" | "limited";
}

/** lead-ai-2 runs (stored in beta before ADR-048): shown as they were, never compared with lead-ai-3. */
export interface LegacyAISummary {
  strengths: string[];
  improvements: string[];
  soldCars: string;
  sellerPatterns: { sellerId: string; name: string; dialogues: number; observations: string[] }[];
  caveats: string[];
}

/** A pattern the model found, with the dialogues behind it (drill-down). */
export interface AIFinding {
  title: string;
  text: string;
  /** "stalling": lead-ai-3 only (replaced by "opportunity" and "undetermined" in lead-ai-3.1). */
  kind: "working" | "stalling" | "opportunity" | "undetermined" | "other";
  threadIds: string[];
}

export interface SellerPattern {
  sellerId: string;
  name: string;
  dialogues: number;
  /** What kind of leads the seller handled, from the classifications (deterministic). */
  handled: string;
  strengths: { text: string; threadIds: string[] }[];
  stalls: { text: string; threadIds: string[] }[];
  /** "För litet underlag" etc. */
  note: string;
}

/** lead-ai-3 combined analysis: few, evidenced patterns – not a retelling of the counts. */
export interface AISummary {
  findings: AIFinding[];
  sellerPatterns: SellerPattern[];
  /** What the material does not support concluding. */
  limits: string;
  caveats: string[];
}

export type NotAnalysedReason = "no_registered_reply" | "redaction_check" | "failed" | "limit" | "time_limit" | "no_stored_analysis";

/** Counts over the AI-analysed dialogues (their number is the population of every count). */
export interface AICounts {
  intent: Distribution[];
  purchaseIntent: Distribution[];
  behaviours: Record<Behaviour, Record<BehaviourStatus, number>>;
  /** Dialogues where the car was sold or reserved, and how many of them got an alternative. */
  carSold: number;
  soldWithAlternative: number;
  soldWithoutAlternative: number;
  /** lead-ai-3 only (absent in lead-ai-2 runs). */
  progress?: Distribution[];
  missedOpportunities?: number;
  questions?: { asked: number; answered: number; partly: number; unanswered: number; notDue: number };
  /** lead-ai-3.1. */
  continuation?: Partial<Record<Continuation, number>>;
  agreedNextStep?: number;
  opportunities?: Partial<Record<OpportunityType, number>>;
  strengths?: Partial<Record<StrengthType, number>>;
}

/** A stored AI analysis as the page shows it: a run (just made or reopened) and its result. */
export interface LeadAIResult {
  run: RunSummaryInfo;
  counts: AICounts | null;
  summary: AISummary | null;
  /** lead-ai-2 runs keep their original form. */
  legacySummary: LegacyAISummary | null;
  notAnalysed: { reason: NotAnalysedReason; count: number }[];
}

// ---------------------------------------------------------------------------
// History (persisted data)
// ---------------------------------------------------------------------------

export interface MonthHistory {
  /** "2026-09" */
  month: string;
  leads: number;
  registeredReply: number;
  medianBusinessMinutes: number | null;
  medianCalendarMinutes: number | null;
}

export interface RunHistory {
  finishedAt: string;
  from: string;
  to: string;
  dialoguesAnalysed: number;
  analysedNew: number;
  reused: number;
  analysisVersion: string;
  model: string;
  costUsd: number;
}

export interface LeadHistory {
  months: MonthHistory[];
  runs: RunHistory[];
}

export interface LeadReport {
  inbox: InboxOption;
  period: { from: string; to: string };
  generatedAt: string;
  dataset: DatasetInfo;
  facts: LeadFacts;
  sellers: SellerFacts[];
  leads: LeadRow[];
  limitations: string[];
  history: LeadHistory | null;
}

/** Below this many leads the page warns that the period is a small sample. */
export const SMALL_SAMPLE_LEADS = 20;
/** Below this many first responses a seller's figures are shown without conclusions. */
export const SMALL_SAMPLE_SELLER = 5;
/** Below this many relevant dialogues a behaviour's share is not shown as a percentage. */
export const SMALL_SAMPLE_RELEVANT = 5;

export type LeadActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Overview, configuration and access (ADR-048)
// ---------------------------------------------------------------------------

export interface LeadRegion {
  id: string;
  name: string;
  sortOrder: number;
}

/** A HubSpot inbox and its Folke configuration (configured = a row exists in Folke). */
export interface LeadInboxConfig {
  id: string;
  name: string;
  configured: boolean;
  active: boolean;
  regionId: string | null;
  facility: string | null;
  brand: string | null;
}

export type PeriodPreset = "7d" | "30d" | "this_month" | "last_month" | "custom";

export interface Period {
  preset: PeriodPreset;
  from: string;
  to: string;
  label: string;
}

/** The deterministic headline figures for a set of leads. */
export interface LeadMetrics {
  leads: number;
  registeredReply: number;
  noRegisteredReply: number;
  uncertain: number;
  /** Medians among leads with a registered reply. */
  medianBusinessMinutes: number | null;
  medianCalendarMinutes: number | null;
  withinOneBusinessHour: number;
  customerWroteLast: number;
  outsideBusinessHours: number;
}

/** How much of the period Folke has fetched from HubSpot, per inbox. */
export interface CoverageInfo {
  inboxes: number;
  /** Inboxes whose whole period has been fetched. */
  completeInboxes: number;
  coveredDays: number;
  totalDays: number;
  complete: boolean;
  /** Oldest and newest "last fetched" among the inboxes (null if never). */
  oldestSyncAt: string | null;
  newestSyncAt: string | null;
  missing: { inboxId: string; name: string; coveredDays: number }[];
}

export interface Comparison {
  previous: Period;
  coverage: CoverageInfo;
  /** Only when the previous period is completely covered. */
  metrics: LeadMetrics | null;
}

export interface OverviewRow {
  id: string;
  name: string;
  detail: string | null;
  metrics: LeadMetrics;
  coverage: CoverageInfo;
}

export interface VehicleRow {
  name: string;
  leads: number;
  registeredReply: number;
  medianBusinessMinutes: number | null;
}

export interface BrandRow extends VehicleRow {
  models: VehicleRow[];
}

export interface VehicleQuality {
  leads: number;
  brandIdentified: number;
  modelIdentified: number;
  bySource: { source: "subject" | "fields" | "page"; count: number }[];
}

export interface LoadPattern {
  /** [weekday 0 = Monday][band] lead counts. */
  grid: number[][];
  bands: string[];
  byGroup: { name: string; leads: number; businessHours: number; weekdayOffHours: number; weekend: number }[];
}

export interface TrendMonth {
  month: string;
  metrics: LeadMetrics;
  /** Leads with "Virtuell" as registration number. */
  virtual: number;
  coveredDays: number;
  totalDays: number;
}

export type EvidenceFilter =
  | "no_reply_open"
  | "customer_last_stale"
  | "clear_intent_customer_last"
  | "waiting_customer"
  | "follow_up_missing"
  | "unanswered_questions"
  | "missed_opportunity"
  | "next_step_missing"
  | "undetermined"
  | "stated_other_channel"
  | "virtual"
  | `opportunity:${OpportunityType}`
  | `strength:${StrengthType}`
  | `source:${string}`
  | `bucket:${string}`;

export interface Insight {
  id: string;
  /** fact: computed from HubSpot data; classification: counts of AI classifications; ai: AI's interpretation. */
  kind: "fact" | "classification" | "ai";
  /** Observation type (ADR-048): something that works, a visible opportunity, or a neutral observation. */
  tone: "strength" | "opportunity" | "observation";
  title: string;
  body: string;
  /** The size of the material, e.g. "12 av 81 AI-analyserade dialoger". */
  basis: string;
  filter?: EvidenceFilter;
  threadIds?: string[];
}

export interface EvidenceRow {
  threadId: string;
  inbox: string;
  arrivedAt: string;
  source: string | null;
  vehicle: string | null;
  status: ResponseStatus;
  seller: string | null;
  /** Avidentified AI reasoning for this lead, when there is one. */
  reason: string | null;
  hubspotUrl: string | null;
}

export interface Scope {
  type: "all" | "region" | "inbox";
  regionId: string | null;
  inboxId: string | null;
  name: string;
  /** From the top: All leads → region → inbox. */
  trail: { label: string; regionId: string | null; inboxId: string | null }[];
}

export interface LeadOverview {
  scope: Scope;
  period: Period;
  metrics: LeadMetrics;
  coverage: CoverageInfo;
  comparison: Comparison;
  /** Regions (scope all), inboxes (scope region), empty for an inbox. */
  rows: OverviewRow[];
  rowKind: "region" | "inbox" | null;
  brands: BrandRow[];
  vehicleQuality: VehicleQuality;
  load: LoadPattern;
  trend: TrendMonth[];
  /** 0–5 observations that pass their thresholds – none is shown just to fill the list. */
  insights: Insight[];
  /** Lead sources (HubSpot facts); sums to metrics.leads. */
  sources: { name: string; leads: number }[];
  /** Lead volume per region (scope all) and per inbox (scope all and region). */
  volumes: { regions: VolumeRow[] | null; inboxes: VolumeRow[] | null };
  response: ResponseDistribution;
  virtual: VirtualStats;
  ai: { analysed: number; eligible: number; analysisVersion: string };
}

export interface RunSummaryInfo {
  id: string;
  finishedAt: string;
  from: string;
  to: string;
  dialoguesAnalysed: number;
  analysedNew: number;
  reused: number;
  analysisVersion: string;
  model: string;
  costUsd: number;
}

export interface LeadAccessInfo {
  hasAccess: boolean;
  isAdmin: boolean;
  allRegions: boolean;
  regionIds: string[];
}

export interface VolumeRow {
  id: string;
  name: string;
  leads: number;
  registeredReply: number;
  medianBusinessMinutes: number | null;
}

/** First registered seller reply, in business time. Population: leads with a registered seller reply. */
export interface ResponseDistribution {
  buckets: { id: string; label: string; count: number }[];
  replied: number;
  /** Same buckets for the previous period, when it is completely fetched. */
  previous: { buckets: { id: string; count: number }[]; replied: number } | null;
}

/**
 * Leads whose registration number field says "Virtuell" (ADR-048): a signal that the listing has no
 * physical car (incoming, to order …), never a vehicle status. Population: all leads.
 */
export interface VirtualStats {
  leads: number;
  virtual: number;
  plate: number;
  other: number;
  missing: number;
  byRegion: { name: string; leads: number; virtual: number }[] | null;
  byInbox: { id: string; name: string; leads: number; virtual: number }[] | null;
  byBrand: { name: string; leads: number; virtual: number; models: { name: string; virtual: number }[] }[];
  compare: { virtual: VehicleRow; plate: VehicleRow };
}
