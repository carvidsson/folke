import "server-only";

import { addDays } from "@/lib/leads/periods";
import {
  BEHAVIOURS,
  type AICounts,
  type AISummary,
  type Behaviour,
  type BehaviourStatus,
  type DialogueClassification,
  type InboxOption,
  type LeadAIResult,
  type LeadRow,
  type NotAnalysedReason,
} from "@/lib/leads/types";
import { AIProviderError } from "@/server/ai/errors";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { defaultChatModel } from "@/server/ai/models";
import { chatCostUsd } from "@/server/ai/pricing";
import type { UsageReport } from "@/server/ai/types";
import { recordChatUsage } from "@/server/ai/usage";
import { leadStore, type LeadStore, type NewAnalysis, type NewNeeds, type StoredAnalysis, type StoredNeeds } from "@/server/data/leads";

import {
  ANALYSIS_VERSION,
  applyRules,
  classifyBatch,
  customerIdentifiers,
  followUpSituation,
  prepareDialogue,
  renderSummary,
  situationFromRow,
  sourceFingerprint,
  summarise,
  toStoredSummary,
  type PreparedDialogue,
  type RawClassification,
  type SummaryDialogue,
} from "./analysis";
import { startOfStockholmDate } from "./business-hours";
import { TtlCache } from "./cache";
import { getAgentName, listChannelAccountNames, listInboxes, type HubSpotMessage } from "./hubspot";
import type { NormalizedLead } from "./normalize";
import { maskRareCapitalised, pseudonymise } from "./redact";
import { classifyNeedsBatch, emptyNeeds, NEEDS_BATCH_SIZE, NEEDS_VERSION, needsFingerprint, needsNoAI, withFormLabels } from "./needs";
import { readThread, threadFromRow } from "./sync";

/**
 * The lead analysis flow (ADR-046 → ADR-048):
 * HubSpot (read-only) → normalisation → deterministic facts (stored) →
 * redaction → structured AI classification (stored, versioned) →
 * combined analysis per inbox, region or all regions (stored as a run).
 *
 * Never stored: message texts or customer contact details. Raw histories
 * are only cached in memory (30 min).
 */

/** The rules that turn a HubSpot thread into facts (normalize.ts). Bump when they change. */
export const FACTS_VERSION = 3;

/** Longest period fetched from HubSpot in one go. The overview reads stored data for longer periods. */
export const MAX_SYNC_DAYS = 92;
const FETCH_CONCURRENCY = 4;
const BATCH_SIZE = 6;
const AI_CONCURRENCY = 5;
/** No new batch starts after this: the server action must finish within the platform limit (300 s). */
export const AI_TIME_BUDGET_MS = 200_000;
export const MAX_AI_DIALOGUES = 150;
/** New needs analyses (lead-needs-1) per run, newest first; the next run continues with the rest. */
export const MAX_NEEDS_DIALOGUES = 200;
/** The combined analysis of a region or all regions uses at most this many stored classifications. */
export const MAX_SUMMARY_DIALOGUES = 250;

export const histories = new TtlCache<HubSpotMessage[]>(30 * 60_000, 3000);
const agentNames = new TtlCache<string | null>(60 * 60_000, 500);
const formNamesCache = new TtlCache<Map<string, string>>(10 * 60_000, 1);
const inboxCache = new TtlCache<InboxOption[]>(10 * 60_000, 1);

export function clearLeadCachesForTests() {
  for (const c of [histories, agentNames, formNamesCache, inboxCache]) c.clear();
}

/** Runs tasks with a fixed number of workers; results keep their order. */
export async function pool<T, R>(items: T[], workers: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]);
      }
    }),
  );
  return results;
}

/** All inboxes in HubSpot (for configuration). */
export async function inboxOptions(): Promise<InboxOption[]> {
  const cached = inboxCache.get("all");
  if (cached) return cached;
  const inboxes = await listInboxes();
  inboxCache.set("all", inboxes);
  return inboxes;
}

export async function formNames(): Promise<Map<string, string>> {
  const cached = formNamesCache.get("all");
  if (cached) return cached;
  const names = await listChannelAccountNames();
  formNamesCache.set("all", names);
  return names;
}

export async function sellerNamesFromHubSpot(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await pool(ids, FETCH_CONCURRENCY, async (id) => {
    let name = agentNames.get(id);
    if (name === undefined) {
      name = await getAgentName(id).catch(() => null);
      agentNames.set(id, name);
    }
    if (name) names.set(id, name);
  });
  return names;
}

// ---------------------------------------------------------------------------
// Counts over classifications (deterministic)
// ---------------------------------------------------------------------------

function emptyBehaviourCounts(): Record<Behaviour, Record<BehaviourStatus, number>> {
  return Object.fromEntries(BEHAVIOURS.map((b) => [b, { done: 0, missing: 0, not_relevant: 0, unclear: 0 }])) as Record<
    Behaviour,
    Record<BehaviourStatus, number>
  >;
}

function distribution(values: string[]) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function tally<T extends string>(values: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function aiCounts(dialogues: Pick<DialogueClassification, "behaviours" | "carStatus" | "alternativeOffered" | "intent" | "purchaseIntent" | "assessment">[]): AICounts {
  const behaviours = emptyBehaviourCounts();
  for (const d of dialogues) for (const b of BEHAVIOURS) behaviours[b][d.behaviours[b].status]++;
  const sold = dialogues.filter((d) => d.carStatus === "sold_or_reserved");
  const assessed = dialogues.filter((d) => d.assessment);
  const questions = assessed.flatMap((d) => d.assessment!.questions);
  return {
    intent: distribution(dialogues.map((d) => d.intent)),
    purchaseIntent: distribution(dialogues.map((d) => d.purchaseIntent)),
    behaviours,
    carSold: sold.length,
    soldWithAlternative: sold.filter((d) => d.alternativeOffered === "yes").length,
    soldWithoutAlternative: sold.filter((d) => d.alternativeOffered === "no").length,
    progress: distribution(assessed.map((d) => d.assessment!.progress)),
    missedOpportunities: assessed.filter((d) => d.assessment!.missedOpportunity === "yes").length,
    continuation: tally(assessed.flatMap((d) => (d.assessment!.continuation ? [d.assessment!.continuation] : []))),
    agreedNextStep: assessed.filter((d) => d.assessment!.agreedNextStep).length,
    opportunities: tally(assessed.flatMap((d) => d.assessment!.opportunities ?? [])),
    strengths: tally(assessed.flatMap((d) => d.assessment!.strengths ?? [])),
    questions: {
      asked: questions.length,
      answered: questions.filter((q) => q.answered === "yes").length,
      partly: questions.filter((q) => q.answered === "partly").length,
      unanswered: questions.filter((q) => q.answered === "no").length,
      notDue: questions.filter((q) => q.answered === "not_due").length,
    },
  };
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------

export type AIRunResult = { ok: true; result: LeadAIResult } | { ok: false; error: string };

const INTENT_WORDS: Record<string, string> = {
  price_or_offer: "pris eller erbjudande",
  financing_or_leasing: "finansiering eller leasing",
  trade_in: "inbyte",
  availability: "om bilen finns kvar",
  test_drive_or_visit: "provkörning eller besök",
  equipment_or_facts: "utrustning eller fakta",
  delivery: "leverans",
  other: "annat",
  unclear: "oklart ärende",
};

/** "12 dialoger, mest finansiering eller leasing (5) och pris eller erbjudande (4)" – deterministic. */
function handledText(dialogues: { intent: string }[]): string {
  const top = distribution(dialogues.map((d) => d.intent)).slice(0, 2);
  const parts = top.map((t) => `${INTENT_WORDS[t.label] ?? t.label} (${t.count})`);
  return `${dialogues.length} dialoger${parts.length ? `, mest ${parts.join(" och ")}` : ""}`;
}

/** The combined analysis of classified dialogues (one call), stored with seller ids and thread ids. */
async function combinedSummary(dialogues: DialogueClassification[], onUsage: (u: UsageReport) => void): Promise<AISummary | null> {
  if (dialogues.length < 3) return null;
  const pseudonyms = pseudonymise(dialogues.flatMap((d) => (d.sellerId ? [d.sellerId] : [])));
  const keyToThread = new Map(dialogues.map((d, i) => [`D${i + 1}`, d.threadId]));
  const perActor = new Map<string, DialogueClassification[]>();
  for (const d of dialogues) if (d.sellerId) perActor.set(d.sellerId, [...(perActor.get(d.sellerId) ?? []), d]);
  const input: SummaryDialogue[] = dialogues.map((d, i) => ({ key: `D${i + 1}`, seller: d.sellerId ? (pseudonyms.get(d.sellerId) ?? null) : null, classification: d }));
  const raw = await summarise(input, onUsage);
  return toStoredSummary(
    raw,
    new Map([...pseudonyms].map(([actor, alias]) => [alias, actor])),
    keyToThread,
    new Map([...perActor].map(([id, list]) => [id, list.length])),
    new Map([...perActor].map(([id, list]) => [id, handledText(list)])),
  );
}

function usageRecorder(userId: string) {
  let costUsd = 0;
  return {
    get cost() {
      return Math.round(costUsd * 1_000_000) / 1_000_000;
    },
    onUsage(usage: UsageReport) {
      costUsd += chatCostUsd(usage.model, usage);
      void recordChatUsage({ userId, assistantId: null, conversationId: null, provider: "openai", dataClass: "internal", usage, purpose: "lead_analysis" });
    },
  };
}

function periodBounds(period: { from: string; to: string }) {
  return { start: startOfStockholmDate(period.from), end: startOfStockholmDate(addDays(period.to, 1)) };
}

/**
 * Analyses one inbox's dialogues with a registered seller reply in the
 * period. A stored classification is reused – without reading HubSpot –
 * when version and model match and neither the thread's latest message nor
 * its follow-up step has changed. Only changed or new dialogues are read
 * from HubSpot, redacted and sent to the model. The caller syncs first.
 */
export async function analyseInbox(
  input: { inbox: { id: string; name: string }; period: { from: string; to: string } },
  userId: string,
  { store = leadStore(), now = new Date() }: { store?: LeadStore; now?: Date } = {},
): Promise<AIRunResult> {
  const model = defaultChatModel();
  const startedAt = new Date().toISOString();
  const { start, end } = periodBounds(input.period);
  const begin = await beginAIRequest(userId, "chat");
  if (!begin.ok) return { ok: false, error: begin.message };
  let status: "completed" | "failed" = "failed";
  const usage = usageRecorder(userId);

  try {
    const notAnalysed = new Map<NotAnalysedReason, number>();
    const skip = (reason: NotAnalysedReason, n = 1) => {
      if (n > 0) notAnalysed.set(reason, (notAnalysed.get(reason) ?? 0) + n);
    };

    const rows = await store.leadRows([input.inbox.id], start, end);
    const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
    skip("no_registered_reply", rows.length - eligible.length);
    const selected = eligible.slice(-MAX_AI_DIALOGUES);
    skip("limit", eligible.length - selected.length);

    let stored: Map<string, StoredAnalysis>;
    try {
      stored = await store.loadAnalyses(selected.map((r) => r.threadId), ANALYSIS_VERSION, model.id);
    } catch {
      return { ok: false, error: "Tidigare analyser kunde inte läsas. Försök igen." };
    }

    const done = new Map<string, RawClassification>();
    let reused = 0;
    const toRead: LeadRow[] = [];
    for (const row of selected) {
      const previous = stored.get(row.threadId);
      if (previous && previous.sourceLatestMessageAt === row.latestMessageAt && previous.situationState === situationFromRow(row, now)) {
        done.set(row.threadId, previous.classification);
        reused++;
      } else toRead.push(row);
    }

    // lead-needs-1 (ADR-052): what the customer asks for, for every lead in the period (with or without a
    // seller reply). A stored result is reused while the thread's latest message is unchanged. Newest first,
    // at most MAX_NEEDS_DIALOGUES new ones per run; the next run continues with the rest.
    const needsCandidates = rows.filter((r) => r.customerMessages > 0);
    let storedNeeds: Map<string, StoredNeeds> | null;
    try {
      storedNeeds = await store.loadNeeds(needsCandidates.map((r) => r.threadId), NEEDS_VERSION, model.id);
    } catch {
      // Without knowing what is stored, analysing again could double the cost: skip the needs this time.
      console.error("[leads] stored needs could not be read");
      storedNeeds = null;
    }
    const needsCurrent = (r: LeadRow) => storedNeeds?.get(r.threadId)?.sourceLatestMessageAt === r.latestMessageAt;
    const needsTodo = storedNeeds ? needsCandidates.filter((r) => !needsCurrent(r)).reverse() : [];
    const needsSelected = needsTodo.slice(0, MAX_NEEDS_DIALOGUES);
    let needsPending = needsTodo.length - needsSelected.length + (storedNeeds ? 0 : needsCandidates.length);
    const wantClassify = new Set(toRead.map((r) => r.threadId));
    const wantNeeds = new Set(needsSelected.map((r) => r.threadId));

    // Read the changed dialogues from HubSpot once (cached for 30 minutes), for either analysis.
    const deadline = Date.now() + AI_TIME_BUDGET_MS;
    const toFetch = [...new Map([...toRead, ...needsSelected].map((r) => [r.threadId, r])).values()];
    const forms = toFetch.length ? await formNames() : new Map<string, string>();
    const leads = new Map<string, NormalizedLead>();
    const needsLeads = new Map<string, NormalizedLead>();
    const touched: NewAnalysis[] = [];
    const needsTouched: NewNeeds[] = [];
    await pool(toFetch, FETCH_CONCURRENCY, async (row) => {
      const lead = await readThread(threadFromRow(row), input.inbox.id, forms);
      if (!lead || lead === "failed") {
        if (wantClassify.has(row.threadId)) skip("failed");
        if (wantNeeds.has(row.threadId)) needsPending++;
        return;
      }
      if (wantNeeds.has(row.threadId)) {
        const previous = storedNeeds?.get(row.threadId);
        const fingerprint = needsFingerprint(lead);
        if (previous && previous.fingerprint === fingerprint) needsTouched.push({ threadId: row.threadId, fingerprint, sourceLatestMessageAt: row.latestMessageAt, needs: previous.needs });
        else needsLeads.set(row.threadId, lead);
      }
      if (!wantClassify.has(row.threadId)) return;
      const previous = stored.get(row.threadId);
      const fingerprint = sourceFingerprint(lead, now);
      // Same content and step after all (e.g. only an assignment changed): keep the result, refresh its basis.
      if (previous && previous.fingerprint === fingerprint) {
        done.set(row.threadId, previous.classification);
        reused++;
        touched.push({ threadId: row.threadId, fingerprint, sellerId: row.responderId, sourceLatestMessageAt: row.latestMessageAt, situationState: followUpSituation(lead, now).state, classification: previous.classification });
        return;
      }
      leads.set(row.threadId, lead);
    });

    const names = await store.sellerNames([...new Set(rows.flatMap((r) => [r.ownerId, r.responderId].filter((x): x is string => Boolean(x))))]);
    const pending = [...leads.values()];
    const pendingNeeds = [...needsLeads.values()];
    const everyone = [...pending, ...pendingNeeds];
    const pseudonyms = pseudonymise([...everyone.flatMap((l) => l.dialogue.flatMap((m) => (m.sellerId ? [m.sellerId] : []))), ...names.keys()]);
    const allCustomerNames = [...new Set(everyone.flatMap((l) => customerIdentifiers(l).filter((v) => !/[@\d]/.test(v))))];
    const prepared: { lead: NormalizedLead; prepared: PreparedDialogue }[] = [];
    for (const [i, lead] of pending.entries()) {
      const p = prepareDialogue(`D${i + 1}`, lead, pseudonyms, names, allCustomerNames, now);
      if ("blocked" in p) skip("redaction_check");
      else prepared.push({ lead, prepared: p });
    }
    // Safety net for names the form does not know (see maskRareCapitalised).
    const masked = maskRareCapitalised(prepared.map((p) => p.prepared.text));
    prepared.forEach((p, i) => (p.prepared.text = masked[i]));

    // The needs pass: the same redaction, with numbered messages. A form with fields only needs no AI.
    const freshNeeds: NewNeeds[] = [];
    const preparedNeeds: { lead: NormalizedLead; prepared: PreparedDialogue }[] = [];
    for (const [i, lead] of pendingNeeds.entries()) {
      const fingerprint = needsFingerprint(lead);
      if (needsNoAI(lead)) {
        freshNeeds.push({ threadId: lead.row.threadId, fingerprint, sourceLatestMessageAt: lead.row.latestMessageAt, needs: { ...withFormLabels(emptyNeeds(lead), lead), ai: false } });
        continue;
      }
      const p = prepareDialogue(`B${i + 1}`, lead, pseudonyms, names, allCustomerNames, now, { numbered: true });
      if ("blocked" in p) needsPending++;
      else preparedNeeds.push({ lead, prepared: p });
    }
    const maskedNeeds = maskRareCapitalised(preparedNeeds.map((p) => p.prepared.text));
    preparedNeeds.forEach((p, i) => (p.prepared.text = maskedNeeds[i]));

    // One queue for both analyses, alternating, so that neither waits for the other within the time budget.
    type Task = { kind: "classify" | "needs"; batch: { lead: NormalizedLead; prepared: PreparedDialogue }[] };
    const classifyTasks: Task[] = [];
    for (let i = 0; i < prepared.length; i += BATCH_SIZE) classifyTasks.push({ kind: "classify", batch: prepared.slice(i, i + BATCH_SIZE) });
    const needsTasks: Task[] = [];
    for (let i = 0; i < preparedNeeds.length; i += NEEDS_BATCH_SIZE) needsTasks.push({ kind: "needs", batch: preparedNeeds.slice(i, i + NEEDS_BATCH_SIZE) });
    const tasks: Task[] = [];
    for (let i = 0; i < Math.max(classifyTasks.length, needsTasks.length); i++) tasks.push(...[classifyTasks[i], needsTasks[i]].filter((t): t is Task => Boolean(t)));

    let budgetMessage: string | null = null;
    const fresh: NewAnalysis[] = [];
    await pool(tasks, AI_CONCURRENCY, async ({ kind, batch }) => {
      const missed = (n: number, reason: "failed" | "time_limit") => (kind === "needs" ? (needsPending += n) : skip(reason, n));
      if (budgetMessage) return missed(batch.length, "failed");
      // Stored results make the next run continue where this one stopped.
      if (Date.now() > deadline) return missed(batch.length, "time_limit");
      const slot = await beginAIRequest(null, "chat");
      if (!slot.ok) {
        budgetMessage = slot.message;
        return missed(batch.length, "failed");
      }
      if (kind === "needs") {
        try {
          const result = await classifyNeedsBatch(batch.map((b) => b.prepared), (u) => usage.onUsage(u));
          const missing = batch.filter((b) => !result.has(b.prepared.key));
          if (missing.length && Date.now() < deadline) {
            const retry = await classifyNeedsBatch(missing.map((b) => b.prepared), (u) => usage.onUsage(u));
            for (const [key, value] of retry) result.set(key, value);
          }
          for (const { lead, prepared: p } of batch) {
            const value = result.get(p.key);
            if (!value) {
              needsPending++;
              continue;
            }
            freshNeeds.push({ threadId: lead.row.threadId, fingerprint: needsFingerprint(lead), sourceLatestMessageAt: lead.row.latestMessageAt, needs: { ...withFormLabels(value, lead), ai: true } });
          }
          await finishAIRequest(slot.requestId, "completed");
        } catch (error) {
          console.error("[leads] AI needs batch failed", error instanceof AIProviderError ? error.code : "unknown");
          needsPending += batch.length;
          await finishAIRequest(slot.requestId, "failed");
        }
        return;
      }
      try {
        const result = await classifyBatch(batch.map((b) => b.prepared), (u) => usage.onUsage(u));
        // The model occasionally leaves out dialogues in a batch: one more call for just those.
        const missing = batch.filter((b) => !result.has(b.prepared.key));
        if (missing.length && Date.now() < deadline) {
          console.warn("[leads] AI batch incomplete, retrying", missing.length);
          const retry = await classifyBatch(missing.map((b) => b.prepared), (u) => usage.onUsage(u));
          for (const [key, value] of retry) result.set(key, value);
        }
        for (const { lead, prepared: p } of batch) {
          const raw = result.get(p.key);
          if (!raw) {
            skip("failed");
            continue;
          }
          const situation = followUpSituation(lead, now);
          const c = applyRules(raw, situation);
          done.set(lead.row.threadId, c);
          const row = selected.find((r) => r.threadId === lead.row.threadId)!;
          fresh.push({ threadId: row.threadId, fingerprint: sourceFingerprint(lead, now), sellerId: row.responderId, sourceLatestMessageAt: row.latestMessageAt, situationState: situation.state, classification: c });
        }
        await finishAIRequest(slot.requestId, "completed");
      } catch (error) {
        console.error("[leads] AI batch failed", error instanceof AIProviderError ? error.code : "unknown");
        skip("failed", batch.length);
        await finishAIRequest(slot.requestId, "failed");
      }
    });

    try {
      await store.saveAnalyses([...fresh, ...touched], ANALYSIS_VERSION, model.id);
    } catch {
      console.error("[leads] analyses could not be saved");
    }
    let needsSaved = true;
    try {
      await store.saveNeeds([...freshNeeds, ...needsTouched], NEEDS_VERSION, model.id);
    } catch {
      needsSaved = false;
      console.error("[leads] needs could not be saved");
    }
    if (!needsSaved) needsPending += freshNeeds.length + needsTouched.length;
    if (needsPending > 0) skip("needs_pending", needsPending);

    const dialogues: DialogueClassification[] = selected
      .filter((r) => done.has(r.threadId))
      .map((r) => ({ threadId: r.threadId, sellerId: r.responderId, ...done.get(r.threadId)! }));
    const counts: AICounts = {
      ...aiCounts(dialogues),
      needs: {
        candidates: needsCandidates.length,
        analysed: needsCandidates.length - Math.min(needsCandidates.length, needsPending),
        analysedNew: needsSaved ? freshNeeds.length : 0,
        pending: needsPending,
      },
    };

    let summary: AISummary | null = null;
    if (!budgetMessage) {
      const slot = await beginAIRequest(null, "chat");
      if (slot.ok) {
        try {
          summary = await combinedSummary(dialogues, (u) => usage.onUsage(u));
          await finishAIRequest(slot.requestId, "completed");
        } catch (error) {
          console.error("[leads] AI summary failed", error instanceof AIProviderError ? error.code : "unknown");
          await finishAIRequest(slot.requestId, "failed");
        }
      }
    }

    status = "completed";
    if (budgetMessage && dialogues.length === 0) return { ok: false, error: budgetMessage };
    const notAnalysedList = [...notAnalysed].map(([reason, count]) => ({ reason, count }));
    const runId = await store
      .saveRun({
        scopeType: "inbox",
        inboxId: input.inbox.id,
        regionId: null,
        from: input.period.from,
        to: input.period.to,
        analysisVersion: ANALYSIS_VERSION,
        model: model.id,
        factsVersion: FACTS_VERSION,
        startedAt,
        leads: rows.length,
        dialoguesAnalysed: dialogues.length,
        analysedNew: fresh.length,
        reused,
        notAnalysed: notAnalysedList,
        costUsd: usage.cost,
        facts: { leads: rows.length, eligible: eligible.length },
        counts,
        summary,
      })
      .catch(() => null);
    const names2 = await store.sellerNames([...new Set(dialogues.flatMap((d) => (d.sellerId ? [d.sellerId] : [])))]);
    return {
      ok: true,
      result: {
        run: {
          id: runId ?? "",
          finishedAt: new Date().toISOString(),
          from: input.period.from,
          to: input.period.to,
          dialoguesAnalysed: dialogues.length,
          analysedNew: fresh.length,
          reused,
          analysisVersion: ANALYSIS_VERSION,
          model: model.id,
          costUsd: usage.cost,
        },
        counts,
        summary: summary ? renderSummary(summary, names2) : null,
        legacySummary: null,
        notAnalysed: notAnalysedList,
      },
    };
  } finally {
    await finishAIRequest(begin.requestId, status);
  }
}

/**
 * The combined analysis of a region or all regions, from stored
 * classifications only: no HubSpot read and no new classification – one
 * model call. Coverage (how many of the dialogues have a stored analysis)
 * is part of the result.
 */
export async function summariseScope(
  input: { scopeType: "region" | "all"; regionId: string | null; inboxIds: string[]; period: { from: string; to: string } },
  userId: string,
  { store = leadStore(), now = new Date() }: { store?: LeadStore; now?: Date } = {},
): Promise<AIRunResult> {
  void now;
  const model = defaultChatModel();
  const startedAt = new Date().toISOString();
  const { start, end } = periodBounds(input.period);
  const rows = await store.leadRows(input.inboxIds, start, end);
  const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
  const stored = await store.loadAnalyses(eligible.map((r) => r.threadId), ANALYSIS_VERSION, model.id);
  const withAnalysis = eligible.filter((r) => stored.has(r.threadId));
  const dialogues: DialogueClassification[] = withAnalysis
    .slice(-MAX_SUMMARY_DIALOGUES)
    .map((r) => ({ threadId: r.threadId, sellerId: r.responderId, ...stored.get(r.threadId)!.classification }));
  if (dialogues.length < 3) {
    return { ok: false, error: `Det finns för få AI-analyserade dialoger i urvalet (${dialogues.length} av ${eligible.length}). Analysera inkorgarna först.` };
  }
  const begin = await beginAIRequest(userId, "chat");
  if (!begin.ok) return { ok: false, error: begin.message };
  const usage = usageRecorder(userId);
  let status: "completed" | "failed" = "failed";
  try {
    const counts = aiCounts(dialogues);
    const summary = await combinedSummary(dialogues, (u) => usage.onUsage(u));
    status = "completed";
    const notAnalysed = [
      { reason: "no_registered_reply" as const, count: rows.length - eligible.length },
      { reason: "no_stored_analysis" as const, count: eligible.length - withAnalysis.length },
      { reason: "limit" as const, count: withAnalysis.length - dialogues.length },
    ].filter((n) => n.count > 0);
    const runId = await store
      .saveRun({
        scopeType: input.scopeType,
        inboxId: null,
        regionId: input.regionId,
        from: input.period.from,
        to: input.period.to,
        analysisVersion: ANALYSIS_VERSION,
        model: model.id,
        factsVersion: FACTS_VERSION,
        startedAt,
        leads: rows.length,
        dialoguesAnalysed: dialogues.length,
        analysedNew: 0,
        reused: dialogues.length,
        notAnalysed,
        costUsd: usage.cost,
        facts: { leads: rows.length, eligible: eligible.length },
        counts,
        summary,
      })
      .catch(() => null);
    const names = await store.sellerNames([...new Set(dialogues.flatMap((d) => (d.sellerId ? [d.sellerId] : [])))]);
    return {
      ok: true,
      result: {
        run: {
          id: runId ?? "",
          finishedAt: new Date().toISOString(),
          from: input.period.from,
          to: input.period.to,
          dialoguesAnalysed: dialogues.length,
          analysedNew: 0,
          reused: dialogues.length,
          analysisVersion: ANALYSIS_VERSION,
          model: model.id,
          costUsd: usage.cost,
        },
        counts,
        summary: summary ? renderSummary(summary, names) : null,
        legacySummary: null,
        notAnalysed,
      },
    };
  } catch (error) {
    console.error("[leads] scope summary failed", error instanceof AIProviderError ? error.code : "unknown");
    return { ok: false, error: "AI-sammanvägningen kunde inte genomföras. Försök igen." };
  } finally {
    await finishAIRequest(begin.requestId, status);
  }
}
