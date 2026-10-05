import "server-only";

import type { LeadIntent } from "@/lib/leads/chat";
import type { CoverageInfo, LeadRow, Period } from "@/lib/leads/types";
import type { StoredAnalysis, StoredNeeds } from "@/server/data/leads";
import { situationFromRow } from "@/server/leads/analysis";

/**
 * One definition of what is fetched and analysed for a selection in the Leadanalys chat (2026-10-06).
 * The seller intro, the missing-material steps, the brief and the fixed answers all read it, so the chat
 * can never say "1 av 1 analyserade" in one turn and "AI-analys saknas" in the next for the same selection.
 *
 * Current = the same rule as the inbox analysis job and the Leadanalys page: a stored lead-ai
 * classification counts while the thread's latest message and its follow-up step are unchanged; a stored
 * lead-needs result while the latest message is unchanged. Older ones are re-analysed by the job.
 */

/** A stored classification that still describes the dialogue as it is now. */
export function isCurrentAnalysis(row: LeadRow, stored: StoredAnalysis | undefined, now: Date): boolean {
  return !!stored && stored.sourceLatestMessageAt === row.latestMessageAt && stored.situationState === situationFromRow(row, now);
}

/** A stored needs result that still describes the lead as it is now. */
export function isCurrentNeeds(row: LeadRow, stored: StoredNeeds | undefined): boolean {
  return !!stored && stored.sourceLatestMessageAt === row.latestMessageAt;
}

/** Dialogues that can be classified: a registered seller reply and a seller message – the seller's own when one is chosen (first reply). */
export function classificationRows(rows: LeadRow[], sellerId: string | null): LeadRow[] {
  return rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0 && (!sellerId || r.responderId === sellerId));
}

/** Leads whose customer needs can be read: a customer message – the seller's leads (first reply or owner) when one is chosen. */
export function needsRows(rows: LeadRow[], sellerId: string | null): LeadRow[] {
  return rows.filter((r) => r.customerMessages > 0 && (!sellerId || r.responderId === sellerId || r.ownerId === sellerId));
}

/** What a question needs besides HubSpot facts. */
export function requirements(intents: LeadIntent[]) {
  // Examples of slow replies are HubSpot facts, not analysed dialogues.
  const factExamples = intents.includes("response_time") && intents.includes("examples") && !intents.some((i) => i === "patterns" || i === "meeting");
  const dialogues = !factExamples && intents.some((i) => i === "patterns" || i === "examples" || i === "meeting" || i === "explain" || i === "overview" || i === "needs");
  return { dialogues, needs: intents.includes("needs") };
}

export interface SelectionStatus {
  data: {
    /** Nothing fetched for the period at all. */
    notFetched: boolean;
    /** Inboxes missing more than today (a period ending today is incomplete until someone fetches today). */
    fetchInboxIds: string[];
    coveredDays: number;
    totalDays: number;
  };
  dialogues: { relevant: number; current: number; missing: number; missingInboxIds: string[] };
  needs: { relevant: number; current: number; missing: number; missingInboxIds: string[] };
  requires: { dialogues: boolean; needs: boolean };
  /** The period is fetched and what the question needs is analysed. */
  complete: boolean;
}

/**
 * The status of a selection. `analyses` and `needs` are the stored results the chat loaded – the chat
 * keeps only current ones (see load.ts), so presence here means current.
 */
export function selectionStatus(input: {
  rows: LeadRow[];
  analyses: Map<string, unknown> | null;
  needs: Map<string, unknown> | null;
  sellerId: string | null;
  coverage: CoverageInfo;
  period: Period;
  today: string;
  intents: LeadIntent[];
  inboxIds: string[];
}): SelectionStatus {
  const { rows, coverage, period } = input;
  const allowed = coverage.totalDays - (period.to === input.today ? 1 : 0);
  const fetchInboxIds = coverage.complete ? [] : coverage.missing.filter((m) => m.coveredDays < allowed).map((m) => m.inboxId).filter((id) => input.inboxIds.includes(id));
  const part = (list: LeadRow[], stored: Map<string, unknown> | null) => {
    const missing = list.filter((r) => !stored?.has(r.threadId));
    return { relevant: list.length, current: list.length - missing.length, missing: missing.length, missingInboxIds: [...new Set(missing.map((r) => r.inboxId))].sort() };
  };
  const dialogues = part(classificationRows(rows, input.sellerId), input.analyses);
  const needs = part(needsRows(rows, input.sellerId), input.needs);
  const requires = requirements(input.intents);
  return {
    data: { notFetched: coverage.coveredDays === 0 && rows.length === 0, fetchInboxIds, coveredDays: coverage.coveredDays, totalDays: coverage.totalDays },
    dialogues,
    needs,
    requires,
    complete: fetchInboxIds.length === 0 && !(requires.dialogues && dialogues.missing) && !(requires.needs && needs.missing),
  };
}
