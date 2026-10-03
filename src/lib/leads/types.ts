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

export interface DialogueClassification {
  threadId: string;
  sellerId: string | null;
  intent: Intent;
  purchaseIntent: PurchaseIntent;
  carStatus: CarStatus;
  alternativeOffered: AlternativeOffered;
  behaviours: Record<Behaviour, BehaviourJudgement>;
  observations: string[];
  evidence: "sufficient" | "limited";
}

export interface AISummary {
  strengths: string[];
  improvements: string[];
  soldCars: string;
  sellerPatterns: { sellerId: string; name: string; dialogues: number; observations: string[] }[];
  caveats: string[];
}

export type NotAnalysedReason = "no_registered_reply" | "redaction_check" | "failed" | "limit" | "time_limit";

export interface LeadAIResult {
  analysisVersion: string;
  model: string;
  /** AI-analysed dialogues in the period: the population of every AI count below. */
  dialoguesAnalysed: number;
  notAnalysed: { reason: NotAnalysedReason; count: number }[];
  /** Analysed in this run vs reused from an earlier run (same version, model and source). */
  analysedNew: number;
  reused: number;
  costUsd: number;
  counts: {
    intent: Distribution[];
    purchaseIntent: Distribution[];
    behaviours: Record<Behaviour, Record<BehaviourStatus, number>>;
    /** Dialogues where the car was sold or reserved, and how many of them got an alternative. */
    carSold: number;
    soldWithAlternative: number;
    soldWithoutAlternative: number;
  };
  summary: AISummary | null;
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
