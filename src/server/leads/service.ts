import "server-only";

import {
  BEHAVIOURS,
  type AISummary,
  type Behaviour,
  type BehaviourStatus,
  type DialogueClassification,
  type ExclusionReason,
  type InboxOption,
  type LeadAIResult,
  type LeadReport,
  type NotAnalysedReason,
} from "@/lib/leads/types";
import { AIProviderError } from "@/server/ai/errors";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { defaultChatModel } from "@/server/ai/models";
import { chatCostUsd } from "@/server/ai/pricing";
import type { UsageReport } from "@/server/ai/types";
import { recordChatUsage } from "@/server/ai/usage";
import { leadStore, type LeadStore, type NewAnalysis, type StoredAnalysis } from "@/server/data/leads";

import {
  ANALYSIS_VERSION,
  applyRules,
  classifyBatch,
  customerIdentifiers,
  followUpSituation,
  prepareDialogue,
  renderSummary,
  sourceFingerprint,
  summarise,
  toStoredSummary,
  type RawClassification,
} from "./analysis";
import { startOfStockholmDate } from "./business-hours";
import { TtlCache } from "./cache";
import {
  getAgentName,
  HubSpotError,
  listChannelAccountNames,
  listInboxes,
  listMessages,
  listThreads,
  type HubSpotMessage,
} from "./hubspot";
import { normalizeThread, type NormalizedLead } from "./normalize";
import { maskRareCapitalised, pseudonymise } from "./redact";
import { leadFacts, sellerFacts } from "./stats";

/**
 * The lead analysis flow (ADR-046):
 * HubSpot (read-only) → normalisation → deterministic facts → redaction →
 * structured AI classification in batches → aggregation.
 *
 * Persisted (ADR-047): deterministic facts per lead, versioned AI results per
 * dialogue and one record per AI run – never message texts or customer
 * contact details. Raw histories are only cached in memory (cache.ts).
 */

/** The rules that turn a HubSpot thread into facts (normalize.ts). Bump when they change. */
export const FACTS_VERSION = 1;

export const MAX_PERIOD_DAYS = 92;
const FETCH_CONCURRENCY = 4;
const BATCH_SIZE = 6;
const AI_CONCURRENCY = 5;
/** No new batch starts after this: the server action must finish within the platform limit (300 s). */
export const AI_TIME_BUDGET_MS = 200_000;
export const MAX_AI_DIALOGUES = 150;

const histories = new TtlCache<HubSpotMessage[]>(30 * 60_000, 3000);
const agentNames = new TtlCache<string | null>(60 * 60_000, 500);
const formNamesCache = new TtlCache<Map<string, string>>(10 * 60_000, 1);
const inboxCache = new TtlCache<InboxOption[]>(10 * 60_000, 1);

export function clearLeadCachesForTests() {
  for (const c of [histories, agentNames, formNamesCache, inboxCache]) c.clear();
}

/** Runs tasks with a fixed number of workers; results keep their order. */
async function pool<T, R>(items: T[], workers: number, task: (item: T) => Promise<R>): Promise<R[]> {
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

export async function inboxOptions(): Promise<InboxOption[]> {
  const cached = inboxCache.get("all");
  if (cached) return cached;
  const inboxes = await listInboxes();
  inboxCache.set("all", inboxes);
  return inboxes;
}

async function formNames(): Promise<Map<string, string>> {
  const cached = formNamesCache.get("all");
  if (cached) return cached;
  const names = await listChannelAccountNames();
  formNamesCache.set("all", names);
  return names;
}

async function sellerNames(ids: string[]): Promise<Map<string, string>> {
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

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface Collected {
  report: LeadReport;
  leads: NormalizedLead[];
  names: Map<string, string>;
}

/** Fetches and normalises the leads that arrived in [from, to] (Stockholm dates, inclusive). */
export async function collectLeads(
  input: { inboxId: string; from: string; to: string },
  store: LeadStore = leadStore(),
): Promise<Collected> {
  const inbox = (await inboxOptions()).find((i) => i.id === input.inboxId);
  if (!inbox) throw new HubSpotError("not_found");
  const start = startOfStockholmDate(input.from);
  const end = startOfStockholmDate(addDays(input.to, 1));

  const [{ threads, complete: allPages }, forms] = await Promise.all([listThreads(inbox.id, start), formNames()]);
  const inPeriod = threads.filter((t) => {
    const created = Date.parse(t.createdAt);
    return created >= start.getTime() && created < end.getTime();
  });

  const excluded = new Map<ExclusionReason, number>();
  const exclude = (reason: ExclusionReason) => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  const results = await pool(inPeriod, FETCH_CONCURRENCY, async (thread) => {
    const key = `${thread.id}:${thread.latestMessageTimestamp ?? ""}`;
    let history = histories.get(key);
    if (!history) {
      try {
        history = await listMessages(thread.id);
        histories.set(key, history);
      } catch (error) {
        // Partial failure: the thread is reported as not read, the rest continues.
        console.error("[leads] could not read a thread", error instanceof HubSpotError ? error.code : "unknown");
        return { ok: false as const, reason: "fetch_failed" as const };
      }
    }
    return normalizeThread(thread, history, { inboxId: inbox.id, formNames: forms });
  });

  const leads: NormalizedLead[] = [];
  for (const r of results) {
    if (r.ok) leads.push(r.lead);
    else exclude(r.reason);
  }
  leads.sort((a, b) => a.row.arrivedAt.localeCompare(b.row.arrivedAt));
  const rows = leads.map((l) => l.row);

  const sellerIds = new Set<string>();
  for (const l of leads) {
    if (l.row.ownerId) sellerIds.add(l.row.ownerId);
    for (const m of l.dialogue) if (m.sellerId) sellerIds.add(m.sellerId);
  }
  const names = await sellerNames([...sellerIds]);
  const facts = leadFacts(rows);
  const fetchFailed = excluded.get("fetch_failed") ?? 0;

  const limitations = [
    "Kontorstid är måndag–fredag 09.00–18.00 svensk tid. Helgdagar räknas som vanliga vardagar.",
    "Bara säljsvar som är registrerade i HubSpot syns. Kontakt per telefon, sms eller e-post utanför HubSpot syns inte, så ”Inget registrerat säljsvar i HubSpot” betyder inte att kunden blev utan svar.",
    "Ägare är trådens nuvarande ägare i HubSpot. Den som svarar blir ofta ägare automatiskt, så ägare och första svarare sammanfaller nästan alltid.",
    "Leads som har flyttats till en annan inkorg ingår inte i urvalet.",
    "Registreringsnummer, modell och mätarställning saknas eller är platshållare i de flesta annonsleads och används därför inte.",
  ];
  if (facts.movedIntoInbox > 0) {
    limitations.push(`${facts.movedIntoInbox} leads har flyttats hit från en annan inkorg. Svarstiden räknas från när de kom in till HubSpot.`);
  }
  if (!allPages) limitations.unshift("Urvalet var för stort för att hämtas helt. Välj en kortare period.");
  if (fetchFailed > 0) limitations.unshift(`${fetchFailed} trådar kunde inte läsas från HubSpot. Siffrorna är ofullständiga.`);

  // Persist the facts (structured data only) and read the history for the inbox.
  let history: LeadReport["history"] = null;
  try {
    await store.saveFacts({
      inbox,
      sellers: [...sellerIds].map((id) => ({ id, name: names.get(id) ?? null })),
      rows,
      factsVersion: FACTS_VERSION,
    });
    history = await store.history(inbox.id);
  } catch {
    console.error("[leads] facts could not be saved");
    limitations.unshift("Resultatet kunde inte sparas i Folke. Siffrorna gäller bara den här hämtningen.");
  }

  const report: LeadReport = {
    inbox,
    period: { from: input.from, to: input.to },
    generatedAt: new Date().toISOString(),
    dataset: {
      threadsFetched: threads.length,
      outsidePeriod: threads.length - inPeriod.length,
      leads: leads.length,
      excluded: [...excluded].map(([reason, count]) => ({ reason, count })),
      complete: allPages && fetchFailed === 0,
    },
    facts,
    sellers: sellerFacts(rows, names),
    leads: rows,
    limitations,
    history,
  };
  return { report, leads, names };
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------

export type AIRunResult = { ok: true; result: LeadAIResult } | { ok: false; error: string };

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

export function aiCounts(dialogues: DialogueClassification[]): LeadAIResult["counts"] {
  const behaviours = emptyBehaviourCounts();
  for (const d of dialogues) for (const b of BEHAVIOURS) behaviours[b][d.behaviours[b].status]++;
  const sold = dialogues.filter((d) => d.carStatus === "sold_or_reserved");
  return {
    intent: distribution(dialogues.map((d) => d.intent)),
    purchaseIntent: distribution(dialogues.map((d) => d.purchaseIntent)),
    behaviours,
    carSold: sold.length,
    soldWithAlternative: sold.filter((d) => d.alternativeOffered === "yes").length,
    soldWithoutAlternative: sold.filter((d) => d.alternativeOffered === "no").length,
  };
}

/**
 * Classifies the dialogues with a registered seller reply and writes a
 * combined analysis. A stored classification is reused when the analysis
 * version, the model and the source fingerprint are unchanged; otherwise the
 * dialogue is analysed again and the stored row replaced.
 *
 * Budgets: one user-level check for the run (daily budget, concurrency,
 * rate) and a monthly-budget check before every call. Usage is recorded per call.
 */
export async function analyseLeads(
  collected: Collected,
  userId: string,
  { store = leadStore(), now = new Date() }: { store?: LeadStore; now?: Date } = {},
): Promise<AIRunResult> {
  const model = defaultChatModel();
  const startedAt = new Date().toISOString();
  const begin = await beginAIRequest(userId, "chat");
  if (!begin.ok) return { ok: false, error: begin.message };
  let status: "completed" | "failed" = "failed";
  let costUsd = 0;
  const onUsage = (usage: UsageReport) => {
    costUsd += chatCostUsd(usage.model, usage);
    void recordChatUsage({
      userId,
      assistantId: null,
      conversationId: null,
      provider: "openai",
      dataClass: "internal",
      usage,
      purpose: "lead_analysis",
    });
  };

  try {
    const notAnalysed = new Map<NotAnalysedReason, number>();
    const skip = (reason: NotAnalysedReason, n = 1) => {
      if (n > 0) notAnalysed.set(reason, (notAnalysed.get(reason) ?? 0) + n);
    };

    const candidates = collected.leads.filter((l) => l.row.status === "registered_reply" && l.dialogue.some((m) => m.role === "seller"));
    skip("no_registered_reply", collected.leads.length - candidates.length);
    const selected = candidates.slice(-MAX_AI_DIALOGUES);
    skip("limit", candidates.length - selected.length);

    // Stored results for this method (version + model).
    let stored: Map<string, StoredAnalysis>;
    try {
      stored = await store.loadAnalyses(selected.map((l) => l.row.threadId), ANALYSIS_VERSION, model.id);
    } catch {
      return { ok: false, error: "Tidigare analyser kunde inte läsas. Försök igen." };
    }

    // Pseudonyms for every seller in the selection, in order of first appearance –
    // and for every other known HubSpot user (owners), who may be named in a text.
    const pseudonyms = pseudonymise([
      ...selected.flatMap((l) => l.dialogue.flatMap((m) => (m.sellerId ? [m.sellerId] : []))),
      ...collected.names.keys(),
    ]);
    // Names only (not contact details) of every customer in the period.
    const allCustomerNames = [...new Set(collected.leads.flatMap((l) => customerIdentifiers(l).filter((v) => !/[@\d]/.test(v))))];

    const done = new Map<string, RawClassification>();
    const fingerprints = new Map<string, string>();
    let reused = 0;
    const pending = [];
    for (const [i, lead] of selected.entries()) {
      const fingerprint = sourceFingerprint(lead, now);
      fingerprints.set(lead.row.threadId, fingerprint);
      const previous = stored.get(lead.row.threadId);
      if (previous && previous.fingerprint === fingerprint) {
        done.set(lead.row.threadId, previous.classification);
        reused++;
        continue;
      }
      const prepared = prepareDialogue(`D${i + 1}`, lead, pseudonyms, collected.names, allCustomerNames, now);
      if ("blocked" in prepared) skip("redaction_check");
      else pending.push({ lead, prepared });
    }
    // Safety net for names the form does not know (see maskRareCapitalised).
    const masked = maskRareCapitalised(pending.map((p) => p.prepared.text));
    pending.forEach((p, i) => (p.prepared.text = masked[i]));

    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));
    let budgetMessage: string | null = null;
    const fresh: NewAnalysis[] = [];
    const deadline = Date.now() + AI_TIME_BUDGET_MS;
    await pool(batches, AI_CONCURRENCY, async (batch) => {
      if (budgetMessage) return skip("failed", batch.length);
      // Stored results make the next run continue where this one stopped.
      if (Date.now() > deadline) return skip("time_limit", batch.length);
      const slot = await beginAIRequest(null, "chat");
      if (!slot.ok) {
        budgetMessage = slot.message;
        return skip("failed", batch.length);
      }
      try {
        const result = await classifyBatch(batch.map((b) => b.prepared), onUsage);
        for (const { lead, prepared } of batch) {
          const raw = result.get(prepared.key);
          if (!raw) {
            skip("failed");
            continue;
          }
          const c = applyRules(raw, followUpSituation(lead, now));
          done.set(lead.row.threadId, c);
          fresh.push({ threadId: lead.row.threadId, fingerprint: fingerprints.get(lead.row.threadId)!, sellerId: lead.row.responderId, classification: c });
        }
        await finishAIRequest(slot.requestId, "completed");
      } catch (error) {
        console.error("[leads] AI batch failed", error instanceof AIProviderError ? error.code : "unknown");
        skip("failed", batch.length);
        await finishAIRequest(slot.requestId, "failed");
      }
    });

    let saveFailed = false;
    try {
      await store.saveAnalyses(fresh, ANALYSIS_VERSION, model.id);
    } catch {
      saveFailed = true;
    }

    const dialogues: DialogueClassification[] = selected
      .filter((l) => done.has(l.row.threadId))
      .map((l) => ({ threadId: l.row.threadId, sellerId: l.row.responderId, ...done.get(l.row.threadId)! }));
    const counts = aiCounts(dialogues);

    // The combined analysis needs at least a few dialogues to say anything.
    let storedSummary: AISummary | null = null;
    if (dialogues.length >= 3 && !budgetMessage) {
      const aliasToActor = new Map([...pseudonyms].map(([actor, alias]) => [alias, actor]));
      const perActor = new Map<string, number>();
      for (const d of dialogues) if (d.sellerId) perActor.set(d.sellerId, (perActor.get(d.sellerId) ?? 0) + 1);
      const slot = await beginAIRequest(null, "chat");
      if (slot.ok) {
        try {
          const relevance = Object.fromEntries(
            BEHAVIOURS.map((b) => {
              const c = counts.behaviours[b];
              return [b, { relevanta: c.done + c.missing, gjort: c.done, saknades: c.missing, ej_relevant: c.not_relevant, går_ej_att_avgöra: c.unclear }];
            }),
          );
          const raw = await summarise(
            {
              dialogues: dialogues.map((d) => ({ seller: d.sellerId ? (pseudonyms.get(d.sellerId) ?? null) : null, classification: d })),
              counts: {
                beteenden: relevance,
                ärende: counts.intent,
                köpintention: counts.purchaseIntent,
                såld_eller_reserverad_bil: {
                  dialoger: counts.carSold,
                  alternativ_erbjöds: counts.soldWithAlternative,
                  inget_alternativ: counts.soldWithoutAlternative,
                },
              },
            },
            onUsage,
          );
          storedSummary = toStoredSummary(raw, aliasToActor, perActor);
          await finishAIRequest(slot.requestId, "completed");
        } catch (error) {
          console.error("[leads] AI summary failed", error instanceof AIProviderError ? error.code : "unknown");
          await finishAIRequest(slot.requestId, "failed");
        }
      }
    }

    status = "completed";
    if (budgetMessage && dialogues.length === 0) return { ok: false, error: budgetMessage };
    const result: LeadAIResult = {
      analysisVersion: ANALYSIS_VERSION,
      model: model.id,
      dialoguesAnalysed: dialogues.length,
      notAnalysed: [...notAnalysed].map(([reason, count]) => ({ reason, count })),
      analysedNew: fresh.length,
      reused,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      counts,
      summary: storedSummary ? renderSummary(storedSummary, collected.names) : null,
    };

    try {
      await store.saveRun({
        inboxId: collected.report.inbox.id,
        from: collected.report.period.from,
        to: collected.report.period.to,
        analysisVersion: ANALYSIS_VERSION,
        model: model.id,
        factsVersion: FACTS_VERSION,
        startedAt,
        leads: collected.report.dataset.leads,
        dialoguesAnalysed: result.dialoguesAnalysed,
        analysedNew: result.analysedNew,
        reused: result.reused,
        notAnalysed: result.notAnalysed,
        costUsd: result.costUsd,
        // Aggregates only: sellers by HubSpot id, never by name.
        facts: { facts: collected.report.facts, sellers: collected.report.sellers.map((s) => ({ ...s, name: undefined })) },
        counts,
        summary: storedSummary,
      });
    } catch {
      saveFailed = true;
    }
    if (saveFailed) console.error("[leads] analysis could not be saved");
    return { ok: true, result };
  } finally {
    await finishAIRequest(begin.requestId, status);
  }
}

