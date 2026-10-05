import "server-only";

import { addDays, daysBetween } from "@/lib/leads/periods";
import type { LeadAIResult, LeadRow, Period, RunSummaryInfo, SellerFacts } from "@/lib/leads/types";
import { defaultChatModel } from "@/server/ai/models";
import { getThreadUrlTemplate, leadStore, listLeadRows, listRuns, listSyncs, sellerNames } from "@/server/data/leads";

import { ANALYSIS_VERSION, situationFromRow } from "./analysis";
import { startOfStockholmDate } from "./business-hours";
import { coverage } from "./coverage";
import { loadNeedsOrNull, isWaiting, threadUrl, type ScopeData } from "./overview";
import { renderStoredRun } from "./runs";
import { aiCounts } from "./service";
import { sellerFacts } from "./stats";

/**
 * What the page shows beyond the overview (ADR-048): for an inbox the
 * sellers and all leads; for every scope the stored AI analysis for the
 * period – opened directly from Folke, without HubSpot or OpenAI – and how
 * much of it is out of date.
 */

export type LeadContext = "agreed" | "stated_other_channel" | "undetermined" | "waiting" | "customer_last";

export interface LeadListRow extends LeadRow {
  sellerName: string | null;
  hubspotUrl: string | null;
  /**
   * What can be said about the end of the dialogue: from the stored AI classification where there is one,
   * otherwise only the HubSpot fact that the customer wrote last. Never "lost" or "not followed up".
   */
  context: LeadContext | null;
}

export interface AIState {
  /** The latest stored analysis for this scope, period, analysis version and model. */
  current: LeadAIResult | null;
  /** Earlier analyses of the scope (all versions; never compared across versions). */
  runs: (RunSummaryInfo & { current: boolean })[];
  /** Dialogues with a registered seller reply in the period, and how many have a valid stored classification now. */
  eligible: number;
  upToDate: number;
  /** Counts over the stored classifications in the period (live, deterministic). */
  counts: LeadAIResult["counts"];
  /** lead-needs-1 (ADR-052): leads with a customer message, and how many have a current needs analysis. */
  needs: { candidates: number; current: number };
}

export interface InboxDetail {
  sellers: SellerFacts[];
  leads: LeadListRow[];
  linkConfigured: boolean;
}

function rowsFor(data: ScopeData, period: Period) {
  return listLeadRows(
    data.scopeInboxes.map((i) => i.id),
    startOfStockholmDate(period.from),
    startOfStockholmDate(addDays(period.to, 1)),
  );
}

export async function inboxDetail(data: ScopeData, period: Period, now = new Date()): Promise<InboxDetail> {
  const rows = await rowsFor(data, period);
  const ids = [...new Set(rows.flatMap((r) => [r.ownerId, r.responderId].filter((x): x is string => Boolean(x))))];
  const [names, template, analyses] = await Promise.all([
    sellerNames(ids),
    getThreadUrlTemplate(),
    leadStore().loadAnalyses(rows.filter((r) => r.status === "registered_reply").map((r) => r.threadId), ANALYSIS_VERSION, defaultChatModel().id),
  ]);
  const contextOf = (r: LeadRow): LeadContext | null => {
    const c = analyses.get(r.threadId)?.classification;
    const a = c?.assessment;
    if (a?.agreedNextStep) return "agreed";
    if (a?.continuation === "stated_other_channel") return "stated_other_channel";
    if (isWaiting(r, c, now)) return "waiting";
    if (a?.continuation === "not_determinable") return "undetermined";
    return r.customerWroteLast ? "customer_last" : null;
  };
  return {
    sellers: sellerFacts(rows, names),
    leads: rows
      .map((r) => ({ ...r, sellerName: r.responderId ? (names.get(r.responderId) ?? "Okänd användare") : null, hubspotUrl: threadUrl(template, r.threadId), context: contextOf(r) }))
      .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt)),
    linkConfigured: !!template,
  };
}

export async function aiState(data: ScopeData, period: Period, now = new Date()): Promise<AIState> {
  const model = defaultChatModel();
  const rows = await rowsFor(data, period);
  const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
  const candidates = rows.filter((r) => r.customerMessages > 0);
  const [stored, storedNeeds] = await Promise.all([
    leadStore().loadAnalyses(eligible.map((r) => r.threadId), ANALYSIS_VERSION, model.id),
    loadNeedsOrNull(rows, model.id),
  ]);
  const valid = eligible.filter((r) => {
    const a = stored.get(r.threadId);
    return a && a.sourceLatestMessageAt === r.latestMessageAt && a.situationState === situationFromRow(r, now);
  });
  const scope = data.scope;
  const runs = await listRuns(
    scope.type === "inbox" ? { type: "inbox", inboxId: scope.inboxId } : scope.type === "region" ? { type: "region", regionId: scope.regionId } : { type: "all" },
  ).catch(() => []);
  const match = runs.find((r) => r.from === period.from && r.to === period.to && r.analysisVersion === ANALYSIS_VERSION && r.model === model.id);
  return {
    current: match ? await renderStoredRun(match) : null,
    runs: runs.map((r) => ({
      id: r.id,
      finishedAt: r.finishedAt,
      from: r.from,
      to: r.to,
      dialoguesAnalysed: r.dialoguesAnalysed,
      analysedNew: r.analysedNew,
      reused: r.reused,
      analysisVersion: r.analysisVersion,
      model: r.model,
      costUsd: r.costUsd,
      current: r.analysisVersion === ANALYSIS_VERSION,
    })),
    eligible: eligible.length,
    upToDate: valid.length,
    counts: stored.size ? aiCounts(eligible.filter((r) => stored.has(r.threadId)).map((r) => stored.get(r.threadId)!.classification)) : null,
    needs: { candidates: candidates.length, current: candidates.filter((r) => storedNeeds?.get(r.threadId)?.sourceLatestMessageAt === r.latestMessageAt).length },
  };
}

/** A period that includes today counts as current for this long after the latest fetch. */
const FRESH_MS = 60 * 60_000;

/** One inbox of a region for the region analysis: what it has, and whether its analysis is current. */
export interface InboxAnalysisCoverage {
  id: string;
  name: string;
  /** Dialogues with a seller reply, and how many have a current lead analysis. */
  eligible: number;
  analysed: number;
  /** Leads with a customer message, and how many have a current needs analysis. */
  candidates: number;
  needsCurrent: number;
  /** The period is fetched from HubSpot (today excepted while the period ends today). */
  fetched: boolean;
  /** Something to analyse, or the period still to fetch. */
  relevant: boolean;
  /** Fetched (within the hour when the period includes today), and every dialogue and lead has a current analysis. */
  current: boolean;
}

/**
 * Per inbox of a scope: whether its AI analysis (lead analysis and customer needs) is current for the
 * period – from stored data only (no HubSpot, no AI). Decides which inboxes a region analysis runs and
 * how far it has come; the same validity rules as the inbox analysis itself.
 */
export async function analysisCoverage(data: ScopeData, period: Period, today: string, now = new Date()): Promise<InboxAnalysisCoverage[]> {
  const model = defaultChatModel();
  const [rows, syncs] = await Promise.all([rowsFor(data, period), listSyncs(data.scopeInboxes.map((i) => i.id))]);
  const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
  const candidates = rows.filter((r) => r.customerMessages > 0);
  const [stored, storedNeeds] = await Promise.all([
    leadStore().loadAnalyses(eligible.map((r) => r.threadId), ANALYSIS_VERSION, model.id),
    loadNeedsOrNull(rows, model.id),
  ]);
  const valid = (r: LeadRow) => {
    const a = stored.get(r.threadId);
    return !!a && a.sourceLatestMessageAt === r.latestMessageAt && a.situationState === situationFromRow(r, now);
  };
  const needsValid = (r: LeadRow) => storedNeeds?.get(r.threadId)?.sourceLatestMessageAt === r.latestMessageAt;
  const allowedDays = daysBetween(period.from, period.to) - (period.to === today ? 1 : 0);
  return data.scopeInboxes.map((i) => {
    const e = eligible.filter((r) => r.inboxId === i.id);
    const c = candidates.filter((r) => r.inboxId === i.id);
    const cov = coverage([i], syncs, period.from, period.to);
    const fetched = cov.coveredDays >= allowedDays;
    // Today's leads keep coming: a period that includes today is current only with a recent fetch.
    const fresh = period.to !== today || (!!cov.newestSyncAt && now.getTime() - Date.parse(cov.newestSyncAt) < FRESH_MS);
    const analysed = e.filter(valid).length;
    const needsCurrent = c.filter(needsValid).length;
    return {
      id: i.id,
      name: i.name,
      eligible: e.length,
      analysed,
      candidates: c.length,
      needsCurrent,
      fetched,
      relevant: !fetched || c.length > 0,
      current: fetched && fresh && analysed === e.length && needsCurrent === c.length,
    };
  });
}
