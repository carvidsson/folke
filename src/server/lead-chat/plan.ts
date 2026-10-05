import "server-only";

import type { LeadChatState, LeadGoal, LeadIntent, LeadTopic } from "@/lib/leads/chat";
import { addDays, daysBetween, resolvePeriod } from "@/lib/leads/periods";
import type { PeriodPreset } from "@/lib/leads/types";

import type { ExampleRequest } from "./intent";
import type { Plan } from "./planner";
import type { Pseudonyms } from "./pseudonyms";
import { label, matchInboxes, matchRegions, matchSellers, regionOf, tokens, type LeadEntities, type TurnResolution } from "./scope";

/**
 * The server's side of the planner (2026-10-06): a plan is only a proposal. Every seller, region and
 * inbox it names is resolved here against the entities the user may see (RLS) – a name that does not
 * resolve is "not found", never widened; periods become real dates within the product's limits; the
 * topics become the brief modules they may load; a request never starts anything. Pure.
 */

/** Longest period the chat shows (the Leadanalys page's limit); a fetch is limited separately (92 days). */
export const MAX_VIEW_DAYS = 366;

export const NOT_FOUND = "Jag hittar ingen säljare, inkorg eller region med det namnet bland de leads du har tillgång till. Ange gärna namnet som det står i Leadanalys.";

/** What each planner topic may load (the brief modules behind the intents). */
const TOPIC_INTENTS: Record<LeadTopic, LeadIntent[]> = {
  seller_work: ["patterns", "examples"],
  strengths_improvements: ["patterns", "examples"],
  follow_up_next_steps: ["patterns", "examples"],
  coaching: ["meeting"],
  customer_needs: ["needs"],
  unavailable_car: ["needs"],
  response_times: ["response_time"],
  sources: ["source"],
  virtual: ["virtual"],
  overview: ["overview"],
  examples: ["examples"],
  explain: ["explain"],
};

export function topicsToIntents(topics: readonly LeadTopic[]): LeadIntent[] {
  return [...new Set(topics.flatMap((t) => TOPIC_INTENTS[t]))];
}

/**
 * GOAL: a question with a subject of its own sets a new goal; a follow-up that only changes the
 * selection, confirms or asks for a step keeps it; "examples" or "why" narrow it for this turn only.
 */
export function nextGoal(
  base: LeadChatState | null,
  explicit: LeadIntent[],
  needsFocus: string[],
  question: string,
  now: Date,
): { goal: LeadGoal | null; intents: LeadIntent[]; needsFocus: string[] } {
  const narrowing = explicit.length > 0 && explicit.every((i) => i === "examples" || i === "explain");
  const previous = base?.goal ?? null;
  if (explicit.length && !(narrowing && previous)) {
    return { goal: { intents: explicit, ...(needsFocus.length ? { needsFocus } : {}), question: question.slice(0, 500), askedAt: now.toISOString() }, intents: explicit, needsFocus };
  }
  if (previous) {
    const intents = narrowing ? [...new Set([...previous.intents, ...explicit])] : previous.intents;
    return { goal: previous, intents, needsFocus: needsFocus.length ? needsFocus : (previous.needsFocus ?? []) };
  }
  return { goal: null, intents: base?.intents.length ? base.intents : ["overview"], needsFocus: needsFocus.length ? needsFocus : (base?.needsFocus ?? []) };
}

// --- Periods ---------------------------------------------------------------------

const iso = (d: Date) => d.toISOString().slice(0, 10);
const date = (s: string) => new Date(`${s}T00:00:00Z`);
const validDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && iso(date(s)) === s;
function addMonths(day: string, n: number) {
  const d = date(day);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return iso(target);
}
const monthStart = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`;
const monthEnd = (year: number, month: number) => iso(new Date(Date.UTC(year, month, 0)));

/** A month the user names without a year: this year, or last year when it is still to come. */
function yearOf(month: number, year: number | null, today: string) {
  if (year && year >= 2000 && year <= Number(today.slice(0, 4))) return year;
  const y = Number(today.slice(0, 4));
  return month > Number(today.slice(5, 7)) ? y - 1 : y;
}

export type PeriodResult = { ok: true; preset: PeriodPreset; from: string; to: string } | { ok: false; reason: string } | null;

/**
 * A period expression → real dates, checked against today and the longest period shown. Null: keep the
 * current period. The presets are only used when the dates are exactly theirs – no new presets.
 */
export function normalizePeriod(p: Plan["period"], current: { from: string; to: string }, today: string): PeriodResult {
  let from: string | null = null;
  let to: string = today;
  switch (p.op) {
    case "keep":
      return null;
    case "last_n": {
      const n = p.amount ?? 0;
      // A large number is judged by the length check below ("högst ett år"), not refused as unreadable.
      if (n < 1 || n > 5000) return { ok: false, reason: "amount" };
      from = p.unit === "months" ? addDays(addMonths(today, -n), 1) : addDays(today, -(n * (p.unit === "weeks" ? 7 : 1)) + 1);
      break;
    }
    case "calendar_month": {
      if (!p.month || p.month < 1 || p.month > 12) return { ok: false, reason: "month" };
      const y = yearOf(p.month, p.year, today);
      from = monthStart(y, p.month);
      to = monthEnd(y, p.month);
      break;
    }
    case "since": {
      if (validDate(p.from)) from = p.from;
      else if (p.month && p.month >= 1 && p.month <= 12) from = monthStart(yearOf(p.month, p.year, today), p.month);
      else return { ok: false, reason: "since" };
      break;
    }
    case "range": {
      if (!validDate(p.from) || !validDate(p.to)) return { ok: false, reason: "range" };
      from = p.from;
      to = p.to;
      break;
    }
    case "previous": {
      // A calendar month goes to the month before; any other period to the same length just before it.
      const isMonth = current.from.endsWith("-01") && (current.to === monthEnd(Number(current.from.slice(0, 4)), Number(current.from.slice(5, 7))) || current.to === today);
      if (isMonth) {
        from = addMonths(current.from, -1);
        to = addDays(current.from, -1);
      } else {
        const len = daysBetween(current.from, current.to);
        to = addDays(current.from, -1);
        from = addDays(to, -len + 1);
      }
      break;
    }
    case "extend": {
      // "Lite längre tillbaka": twice as far back, the same end.
      const len = daysBetween(current.from, current.to);
      from = addDays(current.from, -len);
      to = current.to;
      break;
    }
  }
  if (to > today) to = today;
  if (!from || from > to) return { ok: false, reason: "order" };
  if (daysBetween(from, to) > MAX_VIEW_DAYS) return { ok: false, reason: "too_long" };
  const preset: PeriodPreset =
    to === today && from === addDays(today, -6) ? "7d" : to === today && from === addDays(today, -29) ? "30d" : "custom";
  const resolved = resolvePeriod(preset, today, from, to);
  return { ok: true, preset: resolved.preset, from: resolved.from, to: resolved.to };
}

// --- The plan → a validated turn ------------------------------------------------------

/** A seller named alone: keep the selection if the seller has leads in it, else the seller's own inbox or region. */
export function placeSeller(seller: LeadEntities["sellers"][number], regionId: string | null, inboxId: string | null, entities: LeadEntities) {
  const own = seller.inboxIds;
  const inScope = own.some((id) => (inboxId ? id === inboxId : regionId ? regionOf(entities, id) === regionId : false));
  if (inScope || (!regionId && !inboxId)) return { regionId, inboxId };
  const ownRegions = [...new Set(own.map((id) => regionOf(entities, id)))];
  return { inboxId: own.length === 1 ? own[0] : null, regionId: own.length === 1 ? regionOf(entities, own[0]) : ownRegions.length === 1 ? ownRegions[0] : null };
}

export interface AppliedPlan {
  turn: TurnResolution;
  /** Validation problems (codes only, for the log). */
  problems: string[];
}

export function applyPlan(input: {
  plan: Plan;
  /** The user's text as typed (only for deterministic name matching; never logged). */
  text: string;
  entities: LeadEntities;
  base: LeadChatState | null;
  today: string;
  pseudonyms: Pseudonyms;
  now: Date;
}): AppliedPlan {
  const { plan, entities, base, today, pseudonyms } = input;
  const problems: string[] = [];
  const fallbackState = base ?? null;

  if (plan.kind === "out_of_scope" && plan.out_of_scope_topic) return { turn: { kind: "out_of_scope", topic: plan.out_of_scope_topic, state: fallbackState }, problems };
  if (plan.kind === "clarify") {
    const text = pseudonyms.reveal((plan.clarify_text ?? "").replace(/https?:\/\/\S+/g, "")).trim().slice(0, 300);
    return { turn: { kind: "clarify", text: text || "Kan du säga lite mer om vad du vill veta?", state: fallbackState }, problems };
  }
  if (plan.compare === "other_seller") {
    return { turn: { kind: "clarify", text: "Jag kan titta på en säljare åt gången. Vilken vill du börja med?", state: fallbackState }, problems: ["other_seller"] };
  }

  let regionId = base?.regionId ?? null;
  let inboxId = base?.inboxId ?? null;
  let sellerId = base?.sellerId ?? null;
  let changedScope = false;
  let widened = false;
  const before = { regionId, inboxId, sellerId };

  // Region or inbox: resolved by name against what the user may see.
  if (plan.scope.op === "set") {
    const inboxText = plan.scope.inbox_text?.trim();
    const regionText = plan.scope.region_text?.trim();
    if (inboxText) {
      // Every word the user named must be in the inbox's name: "Alingsås Volkswagen" is never a visible
      // Volkswagen inbox elsewhere – an inbox the user may not see stays not found.
      const named = tokens(inboxText);
      const found = matchInboxes(new Set(named), entities, null).found.filter((i) => {
        const own = new Set([...tokens(i.name), ...tokens(i.facility ?? "")]);
        return named.every((t) => own.has(t) || own.has(t.replace(/s$/, "")));
      });
      const inRegion = found.length > 1 && regionId ? found.filter((i) => i.regionId === regionId) : found;
      if (inRegion.length !== 1) {
        problems.push(inRegion.length ? "inbox_ambiguous" : "inbox_not_found");
        return inRegion.length
          ? { turn: { kind: "clarify", state: fallbackState, text: `Vilken inkorg menar du: ${label(inRegion.map((i) => i.name))}?` }, problems }
          : { turn: { kind: "not_found", state: fallbackState, text: NOT_FOUND }, problems };
      }
      inboxId = inRegion[0].id;
      regionId = inRegion[0].regionId;
    } else if (regionText) {
      const found = matchRegions(new Set(tokens(regionText)), entities).found;
      if (found.length !== 1) {
        problems.push("region_not_found");
        return { turn: { kind: "not_found", state: fallbackState, text: NOT_FOUND }, problems };
      }
      regionId = found[0].id;
      inboxId = null;
    }
    changedScope = true;
  } else if (plan.scope.op === "all") {
    widened = !!(regionId || inboxId || sellerId);
    regionId = inboxId = sellerId = null;
    changedScope = true;
  } else if (plan.scope.op === "widen") {
    if (sellerId) sellerId = null;
    else if (inboxId) {
      regionId = regionOf(entities, inboxId);
      inboxId = null;
    } else if (regionId) regionId = null;
    changedScope = true;
    widened = true;
  }

  // Seller: an alias of a seller the user may see, or a name matched deterministically.
  if (plan.seller.op === "clear") {
    sellerId = null;
    changedScope = true;
  } else if (plan.seller.op === "set") {
    const byAlias = plan.seller.alias ? [...pseudonyms.aliasOf].find(([, alias]) => alias === plan.seller.alias)?.[0] : undefined;
    let seller = byAlias ? entities.sellers.find((s) => s.id === byAlias) : undefined;
    if (!seller) {
      // The name as the planner read it, then as the user typed it (aliases cannot leak real names here).
      const typed = plan.seller.name_text && !/\[namn\]/i.test(plan.seller.name_text) ? plan.seller.name_text : input.text;
      const found = matchSellers(new Set(tokens(typed)), entities, typed);
      if (found.length > 1) {
        problems.push("seller_ambiguous");
        return { turn: { kind: "clarify", state: fallbackState, text: `Jag hittar flera säljare som passar: ${label(found.map((s) => s.name))}. Vilken menar du?` }, problems };
      }
      if (found.length === 0) {
        problems.push(plan.seller.alias ? "alias_unknown" : "seller_not_found");
        return { turn: { kind: "not_found", state: fallbackState, text: NOT_FOUND }, problems };
      }
      seller = found[0];
    }
    sellerId = seller.id;
    changedScope = true;
    if (plan.scope.op === "keep") ({ regionId, inboxId } = placeSeller(seller, regionId, inboxId, entities));
  }

  // Period: real dates within the limits; the previous one is kept when the plan keeps it.
  const current = { from: base?.from ?? addDays(today, -6), to: base?.to ?? today };
  const normalized = normalizePeriod(plan.period, current, today);
  if (normalized && !normalized.ok) {
    problems.push(`period_${normalized.reason}`);
    return {
      turn: { kind: "clarify", state: fallbackState, text: normalized.reason === "too_long" ? "Jag kan visa högst ett år åt gången. Vilken period vill du titta på?" : "Vilken period menar du? Ange gärna datum eller till exempel \"senaste 60 dagarna\"." },
      problems,
    };
  }
  const period = normalized ?? resolvePeriod(base?.preset, today, base?.from, base?.to);

  const comparison = plan.compare === "previous_period" ? true : plan.compare === "none" ? false : (base?.comparison ?? false);
  const explicit = topicsToIntents(plan.topics);
  // "Jämfört med resten": the seller's figures with the whole selection's as reference.
  if (plan.compare === "rest_of_scope" && !explicit.includes("overview")) explicit.push("overview");
  const needsFocus = plan.needs_focus.filter((f) => /^[a-z_]{2,24}(:[a-z_]{2,24})?$/.test(f));
  if (plan.topics.includes("unavailable_car") && !needsFocus.includes("unavailable")) needsFocus.push("unavailable");
  const goal = nextGoal(base, explicit, needsFocus, input.text, input.now);
  let intents = [...goal.intents];
  const wantsExamples = plan.examples.count !== null || plan.examples.polarity !== null;
  if (wantsExamples && !intents.includes("examples")) intents.push("examples");
  if (comparison && !intents.includes("comparison")) intents.push("comparison");
  if (!comparison) intents = intents.filter((i) => i !== "comparison");
  const examples: ExampleRequest | null = intents.includes("examples")
    ? { polarity: plan.examples.polarity ?? "both", count: Math.min(10, Math.max(1, plan.examples.count ?? 3)) }
    : null;

  const selectionChanged = regionId !== base?.regionId || inboxId !== base?.inboxId || sellerId !== base?.sellerId || period.from !== base?.from || period.to !== base?.to;
  const request = plan.request === "decline" ? "decline" : plan.request === "none" ? null : "action";

  return {
    turn: {
      kind: "answer",
      changedScope: changedScope || selectionChanged,
      widenedFrom: widened && base ? { ...base, ...before } : null,
      intents,
      examples,
      request,
      state: {
        regionId,
        inboxId,
        sellerId,
        preset: period.preset,
        from: period.from,
        to: period.to,
        intents,
        comparison,
        focus: base?.focus ?? [],
        needsFocus: goal.needsFocus,
        goal: goal.goal,
        // A step offered for another selection no longer applies.
        pending: selectionChanged ? null : (base?.pending ?? null),
      },
    },
    problems,
  };
}
