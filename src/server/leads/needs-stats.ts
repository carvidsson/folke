import "server-only";

import {
  carriedGroup,
  NEEDS,
  REQUESTS,
  SIGNALS,
  STRONG_SIGNALS,
  UNAVAILABLE,
  type CarriedGroup,
  type CustomerRequest,
  type DialogueNeeds,
  type Need,
  type NeedsOverview,
  type PurchaseSignal,
  type Unavailable,
} from "@/lib/leads/needs";
import type { LeadRow } from "@/lib/leads/types";
import type { StoredAnalysis, StoredNeeds } from "@/server/data/leads";

import { NEEDS_VERSION } from "./needs";

/**
 * Counts over lead-needs-1 (ADR-052) – deterministic, on the server; the model never counts. Shared by
 * the Leadanalys page, the evidence sheet and the lead chat, so a figure means the same everywhere.
 *
 * Population: analysed purchase dialogues. A need that is not labelled is "not mentioned", never "no";
 * a declined need is not counted.
 */

/** A pair of needs is shown only with this much material (no combinatorial noise from tiny samples). */
export const COMBINATION_MIN = { population: 30, count: 8, share: 0.05 } as const;
/** A group in a crossing (a source, Virtuell …) is compared only with this many purchase dialogues. */
export const CROSSING_MIN_GROUP = 20;

export function expressedNeeds(n: DialogueNeeds): Need[] {
  return n.needs.filter((x) => x.stance === "expressed").map((x) => x.code);
}

export function hasStrongSignal(n: DialogueNeeds): boolean {
  return n.signals.some((s) => STRONG_SIGNALS.includes(s.code));
}

/** The analysed purchase dialogues among these rows, with their labels. */
export function purchaseDialogues(rows: LeadRow[], needs: Map<string, StoredNeeds>): { row: LeadRow; n: DialogueNeeds }[] {
  return rows.flatMap((row) => {
    const s = needs.get(row.threadId);
    return s && s.needs.purpose === "purchase" ? [{ row, n: s.needs }] : [];
  });
}

function tally<T extends string>(codes: readonly T[], lists: T[][]): { code: T; count: number }[] {
  return codes
    .map((code) => ({ code, count: lists.filter((l) => l.includes(code)).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || codes.indexOf(a.code) - codes.indexOf(b.code));
}

/** Pairs of needs in the same dialogue that pass COMBINATION_MIN, most common first. */
export function needCombinations(list: { n: DialogueNeeds }[], limit = 3): NeedsOverview["combinations"] {
  const total = list.length;
  if (total < COMBINATION_MIN.population) return [];
  const pairs = new Map<string, number>();
  for (const { n } of list) {
    const codes = [...new Set(expressedNeeds(n))].sort((a, b) => NEEDS.indexOf(a) - NEEDS.indexOf(b));
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) pairs.set(`${codes[i]}+${codes[j]}`, (pairs.get(`${codes[i]}+${codes[j]}`) ?? 0) + 1);
  }
  return [...pairs]
    .filter(([, count]) => count >= COMBINATION_MIN.count && count / total >= COMBINATION_MIN.share)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => {
      const [a, b] = key.split("+") as [Need, Need];
      return { a, b, count };
    });
}

/** What occurs together with one label (a need, request or signal), counted among the dialogues that have it. */
export function coOccurring(list: { n: DialogueNeeds }[], item: string): { item: string; count: number }[] {
  const having = list.filter(({ n }) => itemsOf(n).includes(item));
  const counts = new Map<string, number>();
  for (const { n } of having) for (const other of new Set(itemsOf(n))) if (other !== item) counts.set(other, (counts.get(other) ?? 0) + 1);
  return [...counts].map(([i, count]) => ({ item: i, count })).sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
}

/** Every label of a dialogue as "need:…", "request:…", "signal:…". */
export function itemsOf(n: DialogueNeeds): string[] {
  return [...expressedNeeds(n).map((c) => `need:${c}`), ...n.requests.map((r) => `request:${r.code}`), ...n.signals.map((s) => `signal:${s.code}`)];
}

export function unavailableSummary(list: { n: DialogueNeeds }[]): NeedsOverview["unavailable"] {
  const hit = list.filter(({ n }) => n.unavailable.situation !== "none");
  const situations = UNAVAILABLE.filter((u): u is Exclude<Unavailable, "none"> => u !== "none")
    .map((code) => ({ code, count: hit.filter(({ n }) => n.unavailable.situation === code).length }))
    .filter((x) => x.count > 0);
  const groups: CarriedGroup[] = ["forward", "not_visible", "not_determinable", "customer_ended"];
  const carried = groups.map((group) => ({ group, count: hit.filter(({ n }) => carriedGroup(n.unavailable.carried) === group).length })).filter((x) => x.count > 0);
  return { total: hit.length, situations, carried };
}

export function needsOverview(rows: LeadRow[], needs: Map<string, StoredNeeds>): NeedsOverview {
  const candidates = rows.filter((r) => r.customerMessages > 0);
  const list = purchaseDialogues(candidates, needs);
  return {
    version: NEEDS_VERSION,
    leads: rows.length,
    candidates: candidates.length,
    analysed: candidates.filter((r) => needs.has(r.threadId)).length,
    purchase: list.length,
    needs: tally<Need>(NEEDS, list.map(({ n }) => expressedNeeds(n))),
    requests: tally<CustomerRequest>(REQUESTS, list.map(({ n }) => n.requests.map((r) => r.code))),
    signals: tally<PurchaseSignal>(SIGNALS, list.map(({ n }) => n.signals.map((s) => s.code))),
    strong: list.filter(({ n }) => hasStrongSignal(n)).length,
    soon: list.filter(({ n }) => n.timeframe === "soon").length,
    combinations: needCombinations(list),
    unavailable: unavailableSummary(list),
  };
}

/**
 * A clear purchase signal (or wanting the car soon) without a visible next step: the lead analysis
 * (lead-ai-3.1) exists, no next step was agreed or given, and nothing says it moved to the phone. Leads
 * without a registered seller reply are counted apart – there is no seller message to judge.
 */
export function signalWithoutNextStep(n: DialogueNeeds, a: StoredAnalysis | undefined): boolean {
  if (n.purpose !== "purchase" || !(hasStrongSignal(n) || n.timeframe === "soon") || !a) return false;
  const s = a.classification.assessment;
  return !s?.agreedNextStep && s?.continuation !== "stated_other_channel" && a.classification.behaviours.next_step.status !== "done";
}

/** Filters for the evidence sheet and the chat's sets (validated in the actions). */
export const NEEDS_FILTER = new RegExp(
  `^(need:(${NEEDS.join("|")})|request:(${REQUESTS.join("|")})|signal:(${SIGNALS.join("|")})|combo:(${NEEDS.join("|")})\\+(${NEEDS.join("|")})|unavailable(:(${UNAVAILABLE.filter((u) => u !== "none").join("|")}))?|carried:(forward|not_visible|not_determinable|customer_ended)|strong_signal|soon|signal_no_next_step)$`,
);

export function isNeedsFilter(filter: string): boolean {
  return NEEDS_FILTER.test(filter);
}

export function matchesNeeds(filter: string, n: DialogueNeeds | undefined, a?: StoredAnalysis): boolean {
  if (!n || n.purpose !== "purchase") return false;
  const [kind, value] = filter.split(":") as [string, string | undefined];
  switch (kind) {
    case "need":
      return expressedNeeds(n).includes(value as Need);
    case "request":
      return n.requests.some((r) => r.code === value);
    case "signal":
      return n.signals.some((s) => s.code === value);
    case "combo": {
      const [x, y] = (value ?? "").split("+") as [Need, Need];
      const e = expressedNeeds(n);
      return e.includes(x) && e.includes(y);
    }
    case "unavailable":
      return value ? n.unavailable.situation === value : n.unavailable.situation !== "none";
    case "carried":
      return n.unavailable.situation !== "none" && carriedGroup(n.unavailable.carried) === value;
    case "strong_signal":
      return hasStrongSignal(n);
    case "soon":
      return n.timeframe === "soon";
    case "signal_no_next_step":
      return signalWithoutNextStep(n, a);
    default:
      return false;
  }
}

/** The avidentified notes behind a match (the evidence sheet's reason). */
export function needsReason(filter: string, n: DialogueNeeds | undefined): string | null {
  if (!n) return null;
  const [kind, value] = filter.split(":") as [string, string | undefined];
  const notes = (list: { code: string; note: string }[], codes: string[]) => list.filter((l) => codes.includes(l.code) && l.note).map((l) => l.note);
  let parts: string[] = [];
  if (kind === "need") parts = notes(n.needs, [value!]);
  else if (kind === "combo") parts = notes(n.needs, (value ?? "").split("+"));
  else if (kind === "request") parts = notes(n.requests, [value!]);
  else if (kind === "signal") parts = notes(n.signals, [value!]);
  else if (kind === "strong_signal" || kind === "signal_no_next_step" || kind === "soon") parts = notes(n.signals, [...STRONG_SIGNALS]);
  else if (kind === "unavailable" || kind === "carried") parts = n.unavailable.note ? [n.unavailable.note] : [];
  return parts.length ? parts.map((p) => p.replace(/[.\s]+$/, "")).join(" · ") : null;
}
