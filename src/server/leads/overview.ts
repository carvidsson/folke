import "server-only";

import { addDays, daysBetween, previousPeriod } from "@/lib/leads/periods";
import type {
  AICounts,
  BrandRow,
  EvidenceFilter,
  EvidenceRow,
  Insight,
  LeadInboxConfig,
  LeadMetrics,
  LeadOverview,
  LeadRegion,
  LeadRow,
  LoadPattern,
  OverviewRow,
  Period,
  Scope,
  OpportunityType,
  ResponseDistribution,
  StrengthType,
  TrendMonth,
  VehicleQuality,
  VehicleRow,
  VirtualStats,
  VolumeRow,
} from "@/lib/leads/types";
import { OPPORTUNITY_TYPES } from "@/lib/leads/types";
import { defaultChatModel } from "@/server/ai/models";
import { getThreadUrlTemplate, leadStore, listLeadInboxes, listLeadRegions, listLeadRows, listSyncs, sellerNames, type StoredAnalysis } from "@/server/data/leads";

import { ANALYSIS_VERSION } from "./analysis";
import { businessMinutesBetween, startOfStockholmDate, stockholmTime } from "./business-hours";
import { coverage, type SyncRecord } from "./coverage";
import { median } from "./stats";

/**
 * The lead overview (ADR-048) – computed from data stored in Folke only.
 * HubSpot is read when the user asks to update (sync.ts); this module never
 * calls HubSpot or OpenAI. Every figure is deterministic; AI classifications
 * are counted, never reinterpreted here.
 */

/** "Utan region" groups configured inboxes that have no region yet. */
export const NO_REGION = "none";
/** The customer wrote last more than this many business minutes ago (two working days). */
const STALE_BUSINESS_MINUTES = 2 * 9 * 60;
const TREND_MONTHS = 6;

export function leadMetrics(rows: LeadRow[]): LeadMetrics {
  const replied = rows.filter((r) => r.status === "registered_reply" && r.businessMinutes !== null && r.calendarMinutes !== null);
  return {
    leads: rows.length,
    registeredReply: rows.filter((r) => r.status === "registered_reply").length,
    noRegisteredReply: rows.filter((r) => r.status === "no_registered_reply").length,
    uncertain: rows.filter((r) => r.status === "uncertain").length,
    medianBusinessMinutes: median(replied.map((r) => r.businessMinutes!)),
    medianCalendarMinutes: median(replied.map((r) => r.calendarMinutes!)),
    withinOneBusinessHour: replied.filter((r) => r.businessMinutes! <= 60).length,
    customerWroteLast: rows.filter((r) => r.customerWroteLast).length,
    outsideBusinessHours: rows.filter((r) => r.arrivalWindow !== "business_hours").length,
  };
}

function stockholmDate(instant: string) {
  const t = stockholmTime(new Date(instant));
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function within(rows: LeadRow[], from: string, to: string) {
  return rows.filter((r) => {
    const d = stockholmDate(r.arrivedAt);
    return d >= from && d <= to;
  });
}

export function isStale(row: LeadRow, now: Date) {
  return row.customerWroteLast && !!row.lastCustomerMessageAt && businessMinutesBetween(new Date(row.lastCustomerMessageAt), now) > STALE_BUSINESS_MINUTES;
}

const BANDS = [
  ["00–06", 0, 6],
  ["06–09", 6, 9],
  ["09–12", 9, 12],
  ["12–15", 12, 15],
  ["15–18", 15, 18],
  ["18–21", 18, 21],
  ["21–24", 21, 24],
] as const;

export function loadPattern(rows: LeadRow[], groupOf: (r: LeadRow) => string | null): LoadPattern {
  const grid = Array.from({ length: 7 }, () => BANDS.map(() => 0));
  const groups = new Map<string, LoadPattern["byGroup"][number]>();
  for (const r of rows) {
    const t = stockholmTime(new Date(r.arrivedAt));
    const band = BANDS.findIndex(([, a, b]) => t.hour >= a && t.hour < b);
    grid[t.weekday - 1][band]++;
    const name = groupOf(r);
    if (!name) continue;
    const g = groups.get(name) ?? { name, leads: 0, businessHours: 0, weekdayOffHours: 0, weekend: 0 };
    g.leads++;
    if (r.arrivalWindow === "business_hours") g.businessHours++;
    else if (r.arrivalWindow === "weekday_off_hours") g.weekdayOffHours++;
    else g.weekend++;
    groups.set(name, g);
  }
  return { grid, bands: BANDS.map(([l]) => l), byGroup: [...groups.values()] };
}

function vehicleRow(name: string, rows: LeadRow[]): VehicleRow {
  const m = leadMetrics(rows);
  return { name, leads: m.leads, registeredReply: m.registeredReply, medianBusinessMinutes: m.medianBusinessMinutes };
}

export function brandRows(rows: LeadRow[]): { brands: BrandRow[]; quality: VehicleQuality } {
  const byBrand = new Map<string, LeadRow[]>();
  for (const r of rows) {
    const key = r.vehicleBrand ?? "";
    byBrand.set(key, [...(byBrand.get(key) ?? []), r]);
  }
  const brands = [...byBrand]
    .map(([brand, list]) => {
      const byModel = new Map<string, LeadRow[]>();
      for (const r of list) byModel.set(r.vehicleModel ?? "", [...(byModel.get(r.vehicleModel ?? "") ?? []), r]);
      const models = [...byModel]
        .map(([model, l]) => vehicleRow(model || "Ej identifierad modell", l))
        .sort((a, b) => (a.name === "Ej identifierad modell" ? 1 : b.name === "Ej identifierad modell" ? -1 : b.leads - a.leads || a.name.localeCompare(b.name, "sv")));
      return { ...vehicleRow(brand || "Ej identifierat märke", list), models: brand ? models : [] };
    })
    .sort((a, b) => (a.name === "Ej identifierat märke" ? 1 : b.name === "Ej identifierat märke" ? -1 : b.leads - a.leads || a.name.localeCompare(b.name, "sv")));
  const sources = new Map<"subject" | "fields" | "page", number>();
  for (const r of rows) if (r.vehicleSource) sources.set(r.vehicleSource, (sources.get(r.vehicleSource) ?? 0) + 1);
  return {
    brands,
    quality: {
      leads: rows.length,
      brandIdentified: rows.filter((r) => r.vehicleBrand).length,
      modelIdentified: rows.filter((r) => r.vehicleModel).length,
      bySource: [...sources].map(([source, count]) => ({ source, count })),
    },
  };
}

function monthsBack(today: string, n: number) {
  const months: { month: string; from: string; to: string }[] = [];
  let [y, m] = today.split("-").map(Number);
  for (let i = 0; i < n; i++) {
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const to = [addDays(next, -1), today].sort()[0];
    months.unshift({ month: from.slice(0, 7), from, to });
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  return months;
}

export function trendMonths(rows: LeadRow[], inboxes: { id: string; name: string }[], syncs: SyncRecord[], today: string, n = TREND_MONTHS): TrendMonth[] {
  return monthsBack(today, n).map(({ month, from, to }) => {
    const c = coverage(inboxes, syncs, from, to);
    const list = within(rows, from, to);
    return { month, metrics: leadMetrics(list), virtual: list.filter((r) => r.regnrKind === "virtual").length, coveredDays: c.coveredDays, totalDays: daysBetween(from, to) };
  });
}

// ---------------------------------------------------------------------------
// Distributions (HubSpot facts): sources, response times, "Virtuell"
// ---------------------------------------------------------------------------

export const UNKNOWN_SOURCE = "Okänd källa";

/** Leads per source as stored (no hard-coded list). Sums to rows.length. */
export function sourceRows(rows: LeadRow[]): { name: string; leads: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.source ?? UNKNOWN_SOURCE, (counts.get(r.source ?? UNKNOWN_SOURCE) ?? 0) + 1);
  return [...counts]
    .map(([name, leads]) => ({ name, leads }))
    .sort((a, b) => (a.name === UNKNOWN_SOURCE ? 1 : b.name === UNKNOWN_SOURCE ? -1 : b.leads - a.leads || a.name.localeCompare(b.name, "sv")));
}

/**
 * Buckets for the first registered seller reply, in business minutes (ADR-048). "before_open": the lead
 * came outside business hours and was answered before they began – 0 business minutes, which is
 * correct but would otherwise look like an instant reply. Every replied lead lands in exactly one bucket.
 */
export const RESPONSE_BUCKETS = [
  { id: "before_open", label: "Besvarat före kontorstid" },
  { id: "0_15", label: "0–15 min" },
  { id: "16_30", label: "16–30 min" },
  { id: "31_60", label: "31–60 min" },
  { id: "1_2h", label: "1–2 h" },
  { id: "2_4h", label: "2–4 h" },
  { id: "4h_1d", label: "4 h – 1 arbetsdag" },
  { id: "over_1d", label: "Mer än 1 arbetsdag" },
] as const;

/** Leads with a registered reply and a computed time – the population of the response distribution. */
function replied(rows: LeadRow[]) {
  return rows.filter((r) => r.status === "registered_reply" && r.businessMinutes !== null);
}

export function responseBucket(r: Pick<LeadRow, "businessMinutes" | "arrivalWindow">): (typeof RESPONSE_BUCKETS)[number]["id"] {
  const m = r.businessMinutes ?? 0;
  if (m === 0 && r.arrivalWindow !== "business_hours") return "before_open";
  if (m <= 15) return "0_15";
  if (m <= 30) return "16_30";
  if (m <= 60) return "31_60";
  if (m <= 120) return "1_2h";
  if (m <= 240) return "2_4h";
  if (m <= 540) return "4h_1d";
  return "over_1d";
}

function bucketCounts(rows: LeadRow[]) {
  const list = replied(rows);
  return { replied: list.length, buckets: RESPONSE_BUCKETS.map((b) => ({ id: b.id, label: b.label, count: list.filter((r) => responseBucket(r) === b.id).length })) };
}

export function responseDistribution(rows: LeadRow[], previous: LeadRow[] | null): ResponseDistribution {
  const now = bucketCounts(rows);
  const prev = previous ? bucketCounts(previous) : null;
  return { ...now, previous: prev ? { replied: prev.replied, buckets: prev.buckets.map(({ id, count }) => ({ id, count })) } : null };
}

/** "Virtuell" in the registration number field – counted, never interpreted (ADR-048). */
export function virtualStats(rows: LeadRow[], regionOf: ((r: LeadRow) => string | null) | null, inboxes: { id: string; name: string }[] | null): VirtualStats {
  const count = (list: LeadRow[]) => list.filter((r) => r.regnrKind === "virtual").length;
  const group = <K>(keyOf: (r: LeadRow) => K) => {
    const m = new Map<K, LeadRow[]>();
    for (const r of rows) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
    return m;
  };
  const byBrand = [...group((r) => r.vehicleBrand ?? "Ej identifierat märke")]
    .map(([name, list]) => {
      const models = [...new Set(list.filter((r) => r.regnrKind === "virtual").map((r) => r.vehicleModel ?? "Ej identifierad modell"))]
        .map((model) => ({ name: model, virtual: list.filter((r) => r.regnrKind === "virtual" && (r.vehicleModel ?? "Ej identifierad modell") === model).length }))
        .sort((a, b) => b.virtual - a.virtual || a.name.localeCompare(b.name, "sv"));
      return { name, leads: list.length, virtual: count(list), models };
    })
    .filter((b) => b.virtual > 0)
    .sort((a, b) => (a.name === "Ej identifierat märke" ? 1 : b.name === "Ej identifierat märke" ? -1 : b.virtual - a.virtual || a.name.localeCompare(b.name, "sv")));
  return {
    leads: rows.length,
    virtual: count(rows),
    plate: rows.filter((r) => r.regnrKind === "plate").length,
    other: rows.filter((r) => r.regnrKind === "other").length,
    missing: rows.filter((r) => !r.regnrKind).length,
    byRegion: regionOf
      ? [...group((r) => regionOf(r) ?? "Utan region")].map(([name, list]) => ({ name, leads: list.length, virtual: count(list) })).sort((a, b) => b.leads - a.leads)
      : null,
    byInbox: inboxes
      ? inboxes.map((i) => {
          const list = rows.filter((r) => r.inboxId === i.id);
          return { id: i.id, name: i.name, leads: list.length, virtual: count(list) };
        })
      : null,
    byBrand,
    compare: { virtual: vehicleRow("Virtuell", rows.filter((r) => r.regnrKind === "virtual")), plate: vehicleRow("Registreringsnummer", rows.filter((r) => r.regnrKind === "plate")) },
  };
}

export function volumeRow(id: string, name: string, rows: LeadRow[]): VolumeRow {
  const m = leadMetrics(rows);
  return { id, name, leads: m.leads, registeredReply: m.registeredReply, medianBusinessMinutes: m.medianBusinessMinutes };
}

// ---------------------------------------------------------------------------
// Observations (replace the fixed checks): only what passes a threshold
// ---------------------------------------------------------------------------

/** Below this many AI-analysed dialogues no classification-based observation is made. */
const MIN_ANALYSED = 10;

const OPPORTUNITY_TEXT: Record<OpportunityType, { title: string; body: (n: number, total: number) => string; min: number }> = {
  competitor_offer: {
    title: "Konkurrerande erbjudanden får inte alltid ett synligt svar",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger jämförde kunden med ett annat erbjudande utan att ett motförslag eller nästa steg syns i dialogen.`,
    min: 3,
  },
  visit_interest: {
    title: "Besöksintresse plockas inte alltid upp",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger ville kunden komma, titta eller provköra utan att säljarens svar tog upp det.`,
    min: 3,
  },
  unanswered_questions: {
    title: "Konkreta frågor lämnas ibland obesvarade",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger skrev säljaren efter kundens konkreta frågor utan att alla besvarades i texten.`,
    min: 3,
  },
  sold_without_alternative: {
    title: "Såld bil utan erbjudet alternativ",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger var bilen såld eller reserverad utan att ett alternativ erbjöds i dialogen.`,
    min: 2,
  },
  purchase_signal: {
    title: "Tydliga köpsignaler tas inte alltid vara på",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger visade kunden en tydlig köpsignal som inte syns tas vara på i säljarens svar.`,
    min: 3,
  },
};

const STRENGTH_TEXT: Partial<Record<StrengthType, { title: string; body: (n: number, total: number) => string }>> = {
  interest_to_next_step: {
    title: "Tydligt intresse omsätts ofta i ett konkret nästa steg",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger ledde kundens intresse till ett konkret nästa steg i HubSpot – en tid, en offert, en provkörning eller ett samtal.`,
  },
  visit_booked: {
    title: "Besöksintresse leder till bokad tid",
    body: (n, total) => `I ${n} av ${total} AI-analyserade dialoger bokades eller bekräftades ett besök eller en provkörning.`,
  },
};

/**
 * 0–5 observations for the scope and period: strengths, visible opportunities and neutral observations.
 * Each must pass a threshold and has the leads behind it; nothing is shown just to fill the list.
 */
export function buildInsights(rows: LeadRow[], analyses: Map<string, StoredAnalysis>, now: Date): Insight[] {
  const analysed = rows.filter((r) => analyses.has(r.threadId)).map((r) => ({ row: r, c: analyses.get(r.threadId)!.classification }));
  const total = analysed.length;
  const candidates: (Insight & { score: number })[] = [];
  const share = (n: number) => `${n} av ${total} AI-analyserade dialoger`;

  if (total >= MIN_ANALYSED) {
    for (const [type, t] of Object.entries(STRENGTH_TEXT) as [StrengthType, NonNullable<(typeof STRENGTH_TEXT)[StrengthType]>][]) {
      const n = analysed.filter((a) => a.c.assessment?.strengths?.includes(type)).length;
      if (n >= 3) candidates.push({ id: `strength:${type}`, kind: "classification", tone: "strength", title: t.title, body: t.body(n, total), basis: share(n), filter: `strength:${type}`, score: n / total });
    }
    for (const type of OPPORTUNITY_TYPES) {
      const t = OPPORTUNITY_TEXT[type];
      const n = analysed.filter((a) => a.c.assessment?.opportunities?.includes(type)).length;
      if (n >= t.min) candidates.push({ id: `opportunity:${type}`, kind: "classification", tone: "opportunity", title: t.title, body: t.body(n, total), basis: share(n), filter: `opportunity:${type}`, score: n / total });
    }
    const undetermined = analysed.filter((a) => a.c.assessment?.continuation === "not_determinable").length;
    if (undetermined >= 3) {
      candidates.push({
        id: "undetermined",
        kind: "classification",
        tone: "observation",
        title: "Fortsättningen går ofta inte att avgöra från HubSpot",
        body: `I ${undetermined} av ${total} AI-analyserade dialoger slutar det synliga förloppet där en fortsättning väntades – till exempel efter att kunden lämnat offertunderlag – utan att mer syns. Offerten kan ha skickats från säljsystemet, kontakten kan ha skett per telefon eller processen kan ha stannat. Folke kan inte avgöra vilket.`,
        basis: share(undetermined),
        filter: "undetermined",
        score: undetermined / total,
      });
    }
  }
  // Customers who may be waiting: the customer wrote last over two working days ago with a question or a
  // clear purchase intent, and nothing says the next step was agreed or moved to the phone.
  const waiting = analysed.filter((a) => isWaiting(a.row, a.c, now)).length;
  if (waiting >= 2) {
    candidates.push({
      id: "waiting_customer",
      kind: "classification",
      tone: "observation",
      title: "Kunder som kan vänta på svar",
      body: `I ${waiting} leads skrev kunden sist för mer än två arbetsdagar sedan med en fråga eller tydlig köpintention, utan något överenskommet nästa steg och utan senare registrerat säljsvar. Svaret kan ha gått per telefon.`,
      basis: `${waiting} av ${total} AI-analyserade dialoger`,
      filter: "waiting_customer",
      score: total ? waiting / total : 0,
    });
  }
  const noReplyOpen = rows.filter((r) => r.status === "no_registered_reply" && r.threadOpen).length;
  if (noReplyOpen >= 3) {
    candidates.push({
      id: "no_reply_open",
      kind: "fact",
      tone: "observation",
      title: "Öppna leads utan registrerat säljsvar",
      body: `${noReplyOpen} av ${rows.length} leads har inget registrerat säljsvar i HubSpot och tråden är fortfarande öppen.`,
      basis: `${noReplyOpen} av ${rows.length} leads`,
      filter: "no_reply_open",
      score: noReplyOpen / Math.max(1, rows.length),
    });
  }
  // At most two of each kind, five in all, in a fixed order: what works, opportunities, observations.
  const order = { strength: 0, opportunity: 1, observation: 2 } as const;
  const picked: (Insight & { score: number })[] = [];
  for (const tone of ["strength", "opportunity", "observation"] as const) {
    picked.push(...candidates.filter((c) => c.tone === tone).sort((a, b) => b.score - a.score).slice(0, 2));
  }
  return picked
    .sort((a, b) => order[a.tone] - order[b.tone])
    .slice(0, 5)
    .map(({ score, ...i }) => (void score, i));
}

export function isWaiting(row: LeadRow, c: StoredAnalysis["classification"] | undefined, now: Date) {
  if (!c?.assessment || !isStale(row, now)) return false;
  const a = c.assessment;
  if (a.agreedNextStep || a.continuation === "stated_other_channel") return false;
  return c.purchaseIntent === "clear" || a.questions.some((q) => q.answered === "not_due");
}

/** Whether a lead belongs to an evidence filter (also used by the lead chat for its "Visa alla" sets). */
export function matches(filter: EvidenceFilter, row: LeadRow, a: StoredAnalysis | undefined, now: Date): boolean {
  const c = a?.classification;
  if (filter.startsWith("opportunity:")) return Boolean(c?.assessment?.opportunities?.includes(filter.slice(12) as OpportunityType));
  if (filter.startsWith("strength:")) return Boolean(c?.assessment?.strengths?.includes(filter.slice(9) as StrengthType));
  if (filter.startsWith("source:")) return (row.source ?? UNKNOWN_SOURCE) === filter.slice(7);
  if (filter.startsWith("bucket:")) return row.status === "registered_reply" && row.businessMinutes !== null && responseBucket(row) === filter.slice(7);
  switch (filter) {
    case "no_reply_open":
      return row.status === "no_registered_reply" && row.threadOpen;
    case "customer_last_stale":
      return isStale(row, now);
    case "clear_intent_customer_last":
      return !!c && c.purchaseIntent === "clear" && row.customerWroteLast;
    case "waiting_customer":
      return isWaiting(row, c, now);
    case "follow_up_missing":
      return c?.behaviours.follow_up.status === "missing";
    case "unanswered_questions":
      return c?.behaviours.answered_questions.status === "missing";
    case "missed_opportunity":
      return c?.assessment?.missedOpportunity === "yes";
    case "next_step_missing":
      return c?.behaviours.next_step.status === "missing";
    case "undetermined":
      return c?.assessment?.continuation === "not_determinable";
    case "stated_other_channel":
      return c?.assessment?.continuation === "stated_other_channel";
    case "virtual":
      return row.regnrKind === "virtual";
    default:
      return false;
  }
}

function reasonFor(filter: EvidenceFilter | null, row: LeadRow, a: StoredAnalysis | undefined, now: Date): string | null {
  const c = a?.classification;
  const days = row.lastCustomerMessageAt ? Math.floor(businessMinutesBetween(new Date(row.lastCustomerMessageAt), now) / (9 * 60)) : null;
  const situation = c?.assessment ? [c.assessment.goal, c.assessment.progressReason].filter(Boolean).join(" – ") : null;
  if (filter?.startsWith("opportunity:")) return c?.assessment?.missedReason || situation;
  if (filter?.startsWith("strength:") || filter?.startsWith("source:") || filter?.startsWith("bucket:")) return situation;
  switch (filter) {
    case "no_reply_open":
      return "Inget registrerat säljsvar i HubSpot. Tråden är öppen.";
    case "customer_last_stale":
      return `Kunden skrev senast för ${days} arbetsdagar sedan; inget senare registrerat säljsvar.`;
    case "clear_intent_customer_last":
    case "waiting_customer": {
      const open = c?.assessment?.questions.filter((q) => q.answered === "not_due").map((q) => q.text) ?? [];
      return (
        [
          open.length ? `Fråga utan senare säljarmeddelande: ${open.join("; ")}.` : null,
          c?.assessment?.signals.length ? `Köpsignaler: ${c.assessment.signals.join("; ")}.` : null,
          days !== null ? `Kunden skrev senast för ${days} arbetsdagar sedan.` : null,
        ]
          .filter(Boolean)
          .join(" ") || null
      );
    }
    case "follow_up_missing":
      return c?.behaviours.follow_up.reason || null;
    case "unanswered_questions": {
      const open = c?.assessment?.questions.filter((q) => q.answered === "no" || q.answered === "partly").map((q) => q.text) ?? [];
      return open.length ? `Utan synligt svar: ${open.join("; ")}.` : c?.behaviours.answered_questions.reason || null;
    }
    case "missed_opportunity":
      return c?.assessment?.missedReason || null;
    case "next_step_missing":
      return c?.behaviours.next_step.reason || null;
    case "virtual":
      return situation ?? "Registreringsnummer i formuläret: Virtuell.";
    default:
      return situation;
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface ScopeData {
  regions: LeadRegion[];
  inboxes: LeadInboxConfig[];
  scope: Scope;
  scopeInboxes: LeadInboxConfig[];
}

/** The inboxes in a scope the user may see (RLS has already filtered the lists). Null when not visible. */
export async function resolveScope(selection: { regionId?: string | null; inboxId?: string | null }): Promise<ScopeData | null> {
  const [regions, all] = await Promise.all([listLeadRegions(), listLeadInboxes()]);
  const inboxes = all.filter((i) => i.active);
  const regionName = (id: string | null) => (id ? (regions.find((r) => r.id === id)?.name ?? null) : "Utan region");
  const top = { label: "Alla leads", regionId: null, inboxId: null };
  if (selection.inboxId) {
    const inbox = inboxes.find((i) => i.id === selection.inboxId);
    if (!inbox) return null;
    const rid = inbox.regionId ?? NO_REGION;
    return {
      regions,
      inboxes,
      scopeInboxes: [inbox],
      scope: {
        type: "inbox",
        regionId: inbox.regionId,
        inboxId: inbox.id,
        name: inbox.name,
        trail: [top, { label: regionName(inbox.regionId) ?? "Region", regionId: rid, inboxId: null }, { label: inbox.name, regionId: rid, inboxId: inbox.id }],
      },
    };
  }
  if (selection.regionId) {
    const scoped = inboxes.filter((i) => (selection.regionId === NO_REGION ? !i.regionId : i.regionId === selection.regionId));
    const name = regionName(selection.regionId === NO_REGION ? null : selection.regionId);
    if (!scoped.length || !name) return null;
    return {
      regions,
      inboxes,
      scopeInboxes: scoped,
      scope: { type: "region", regionId: selection.regionId, inboxId: null, name, trail: [top, { label: name, regionId: selection.regionId, inboxId: null }] },
    };
  }
  return { regions, inboxes, scopeInboxes: inboxes, scope: { type: "all", regionId: null, inboxId: null, name: "Alla leads", trail: [top] } };
}

export async function buildOverview(data: ScopeData, period: Period, today: string, now = new Date()): Promise<LeadOverview> {
  const ids = data.scopeInboxes.map((i) => i.id);
  const previous = previousPeriod(period);
  const trendFrom = monthsBack(today, TREND_MONTHS)[0].from;
  const queryFrom = [previous.from, trendFrom, period.from].sort()[0];
  const [allRows, syncs] = await Promise.all([
    listLeadRows(ids, startOfStockholmDate(queryFrom), startOfStockholmDate(addDays([period.to, today].sort()[1], 1))),
    listSyncs(ids),
  ]);
  const rows = within(allRows, period.from, period.to);
  const prevRows = within(allRows, previous.from, previous.to);
  const cov = coverage(data.scopeInboxes, syncs, period.from, period.to);
  const prevCov = coverage(data.scopeInboxes, syncs, previous.from, previous.to);

  // Rows per region (scope all) or per inbox (scope region).
  let rowKind: LeadOverview["rowKind"] = null;
  let groups: OverviewRow[] = [];
  if (data.scope.type === "all") {
    rowKind = "region";
    const keys = [...data.regions.map((r) => r.id), NO_REGION];
    groups = keys
      .map((key): OverviewRow | null => {
        const members = data.scopeInboxes.filter((i) => (key === NO_REGION ? !i.regionId : i.regionId === key));
        if (!members.length) return null;
        const memberIds = new Set(members.map((i) => i.id));
        return {
          id: key,
          name: key === NO_REGION ? "Utan region" : data.regions.find((r) => r.id === key)!.name,
          detail: `${members.length} ${members.length === 1 ? "inkorg" : "inkorgar"}`,
          metrics: leadMetrics(rows.filter((r) => memberIds.has(r.inboxId))),
          coverage: coverage(members, syncs, period.from, period.to),
        };
      })
      .filter((g): g is OverviewRow => g !== null);
  } else if (data.scope.type === "region") {
    rowKind = "inbox";
    groups = data.scopeInboxes.map((i) => ({
      id: i.id,
      name: i.name,
      detail: [i.facility, i.brand].filter(Boolean).join(" · ") || null,
      metrics: leadMetrics(rows.filter((r) => r.inboxId === i.id)),
      coverage: coverage([i], syncs, period.from, period.to),
    }));
  }

  const regionOf = new Map(data.scopeInboxes.map((i) => [i.id, i.regionId ? (data.regions.find((r) => r.id === i.regionId)?.name ?? null) : "Utan region"]));
  const inboxName = new Map(data.scopeInboxes.map((i) => [i.id, i.name]));
  const load = loadPattern(rows, (r) => (data.scope.type === "all" ? (regionOf.get(r.inboxId) ?? null) : data.scope.type === "region" ? (inboxName.get(r.inboxId) ?? null) : null));
  const { brands, quality } = brandRows(rows);
  const regionName = (r: LeadRow) => regionOf.get(r.inboxId) ?? null;
  const volumes = {
    regions: data.scope.type === "all" ? groups.map((g) => volumeRow(g.id, g.name, rows.filter((r) => data.scopeInboxes.some((i) => i.id === r.inboxId && (g.id === NO_REGION ? !i.regionId : i.regionId === g.id))))) : null,
    inboxes: data.scope.type === "inbox" ? null : data.scopeInboxes.map((i) => volumeRow(i.id, i.name, rows.filter((r) => r.inboxId === i.id))),
  };

  const model = defaultChatModel();
  const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
  const analyses = await leadStore().loadAnalyses(eligible.map((r) => r.threadId), ANALYSIS_VERSION, model.id);

  return {
    scope: data.scope,
    period,
    metrics: leadMetrics(rows),
    coverage: cov,
    comparison: { previous, coverage: prevCov, metrics: prevCov.complete ? leadMetrics(prevRows) : null },
    rows: groups,
    rowKind,
    brands,
    vehicleQuality: quality,
    load,
    trend: trendMonths(allRows, data.scopeInboxes, syncs, today),
    insights: buildInsights(rows, analyses, now),
    sources: sourceRows(rows),
    volumes,
    response: responseDistribution(rows, prevCov.complete ? prevRows : null),
    virtual: virtualStats(rows, data.scope.type === "all" ? regionName : null, data.scope.type === "inbox" ? null : data.scopeInboxes),
    ai: { analysed: eligible.filter((r) => analyses.has(r.threadId)).length, eligible: eligible.length, analysisVersion: ANALYSIS_VERSION },
  };
}

/** The leads behind an insight or an AI finding – structured, avidentified reasons and HubSpot links. */
export async function evidence(
  data: ScopeData,
  period: Period,
  selection: { filter?: EvidenceFilter; threadIds?: string[] },
  now = new Date(),
): Promise<EvidenceRow[]> {
  const ids = data.scopeInboxes.map((i) => i.id);
  const rows = within(await listLeadRows(ids, startOfStockholmDate(period.from), startOfStockholmDate(addDays(period.to, 1))), period.from, period.to);
  const model = defaultChatModel();
  const analyses = await leadStore().loadAnalyses(rows.map((r) => r.threadId), ANALYSIS_VERSION, model.id);
  const wanted = selection.threadIds ? new Set(selection.threadIds) : null;
  const picked = rows.filter((r) => (wanted ? wanted.has(r.threadId) : selection.filter ? matches(selection.filter, r, analyses.get(r.threadId), now) : false));
  const [names, template] = await Promise.all([sellerNames([...new Set(picked.flatMap((r) => (r.responderId ? [r.responderId] : r.ownerId ? [r.ownerId] : [])))]), getThreadUrlTemplate()]);
  const inboxName = new Map(data.scopeInboxes.map((i) => [i.id, i.name]));
  return picked
    .map((r) => ({
      threadId: r.threadId,
      inbox: inboxName.get(r.inboxId) ?? "",
      arrivedAt: r.arrivedAt,
      source: r.source,
      vehicle: [r.vehicleBrand, r.vehicleModel].filter(Boolean).join(" ") || r.vehicle,
      status: r.status,
      seller: (r.responderId ?? r.ownerId) ? (names.get((r.responderId ?? r.ownerId)!) ?? "Okänd användare") : null,
      reason: reasonFor(selection.filter ?? null, r, analyses.get(r.threadId), now),
      hubspotUrl: threadUrl(template, r.threadId),
    }))
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));
}

export function threadUrl(template: string | null, threadId: string): string | null {
  return template && /^\d+$/.test(threadId) ? template.replace("{threadId}", threadId) : null;
}

export type { AICounts };
