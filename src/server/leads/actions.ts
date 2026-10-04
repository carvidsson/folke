"use server";

import { after } from "next/server";
import { z } from "zod";

import { daysBetween, resolvePeriod } from "@/lib/leads/periods";
import { OPPORTUNITY_TYPES, STRENGTH_TYPES, type EvidenceFilter, type EvidenceRow, type LeadActionResult, type LeadAIResult } from "@/lib/leads/types";
import { leadAnalysisExternalAllowed } from "@/server/ai/guard";
import { defaultChatModel } from "@/server/ai/models";
import { logSecurityEvent } from "@/server/audit";
import { getRun, latestAnalysisJob, leadStore, startAnalysisJob, type AnalysisJob } from "@/server/data/leads";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { requireLeadAccess } from "./access";
import { stockholmTime } from "./business-hours";
import { HubSpotError, hubSpotConfigured } from "./hubspot";
import { evidence, resolveScope, RESPONSE_BUCKETS } from "./overview";
import { effectiveJob, runInboxAnalysisJob } from "./jobs";
import { ANALYSIS_VERSION } from "./analysis";
import { renderStoredRun } from "./runs";
import { MAX_SYNC_DAYS, summariseScope } from "./service";
import { syncInbox } from "./sync";

/**
 * Lead analysis actions for users with access (ADR-048). Every action
 * re-resolves the scope through RLS: an inbox or region the user may not see
 * is simply not found. Reads HubSpot read-only; writes only to Folke.
 */

function today() {
  const t = stockholmTime(new Date());
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

const id = z.string().regex(/^[0-9]{1,20}$/);
const regionId = z.union([z.uuid(), z.literal("none")]);
const scopeInput = z.object({
  regionId: regionId.nullish(),
  inboxId: id.nullish(),
  preset: z.enum(["7d", "30d", "this_month", "last_month", "custom"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

function hubSpotMessage(error: unknown): string {
  const code = error instanceof HubSpotError ? error.code : "unknown";
  console.error("[leads] HubSpot request failed", code);
  switch (code) {
    case "not_configured":
      return "HubSpot är inte konfigurerat i den här miljön.";
    case "auth":
    case "forbidden":
      return "HubSpot nekade åtkomst. Kontrollera servicenyckeln och att den har behörigheten conversations.read.";
    case "rate_limited":
      return "HubSpot begränsar antalet anrop just nu. Försök igen om en minut.";
    default:
      return "Det gick inte att hämta data från HubSpot. Försök igen.";
  }
}

async function scopeAndPeriod(raw: unknown) {
  const parsed = scopeInput.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const data = await resolveScope({ regionId: v.regionId ?? null, inboxId: v.inboxId ?? null });
  if (!data) return null;
  return { data, period: resolvePeriod(v.preset, today(), v.from, v.to) };
}

/**
 * Fetches the scope's inboxes from HubSpot for the period, one inbox after
 * another until ~180 s have passed. Returns which inboxes remain; the page
 * calls again until none remain.
 */
export async function syncLeadsAction(
  raw: unknown,
  only?: string[],
): Promise<LeadActionResult<{ done: string[]; remaining: string[]; incomplete: string[] }>> {
  const { session } = await requireLeadAccess();
  if (!hubSpotConfigured()) return { ok: false, error: hubSpotMessage(new HubSpotError("not_configured")) };
  const resolved = await scopeAndPeriod(raw);
  if (!resolved) return { ok: false, error: "Urvalet hittades inte." };
  const { data, period } = resolved;
  if (daysBetween(period.from, period.to) > MAX_SYNC_DAYS) {
    return { ok: false, error: `Välj en period på högst ${MAX_SYNC_DAYS} dagar för att hämta från HubSpot.` };
  }
  const allowed = new Set(data.scopeInboxes.map((i) => i.id));
  const queue = (only ?? [...allowed]).filter((i) => typeof i === "string" && allowed.has(i));
  const deadline = Date.now() + 200_000;
  const store = leadStore();
  const done: string[] = [];
  const incomplete: string[] = [];
  try {
    for (const inboxId of queue) {
      if (Date.now() > deadline - 30_000) break;
      const inbox = data.scopeInboxes.find((i) => i.id === inboxId)!;
      const result = await syncInbox(inbox, period, store, { deadline });
      done.push(inboxId);
      if (!result.complete) incomplete.push(inboxId);
    }
  } catch (error) {
    if (!done.length) return { ok: false, error: hubSpotMessage(error) };
  }
  await logSecurityEvent("leads.synced", {
    actorId: session.user.id,
    targetType: "lead_scope",
    targetId: data.scope.inboxId ?? data.scope.regionId ?? "all",
    metadata: { from: period.from, to: period.to, inboxes: done.length, incomplete: incomplete.length },
  });
  return { ok: true, data: { done, remaining: queue.filter((i) => !done.includes(i)), incomplete } };
}

/** The job and, when it is done, the stored run as the page shows it. */
export interface InboxAnalysisState {
  job: { id: string; status: "running" | "completed" | "failed"; startedAt: string; finishedAt: string | null; error: string | null } | null;
  result: LeadAIResult | null;
  /** True when a start joined a job that was already running (nothing new was started). */
  alreadyRunning?: boolean;
}

async function inboxAndPeriod(raw: unknown) {
  const resolved = await scopeAndPeriod(raw);
  if (!resolved || resolved.data.scope.type !== "inbox") return null;
  return { inbox: resolved.data.scopeInboxes[0], period: resolved.period };
}

const jobKey = (inboxId: string, period: { from: string; to: string }) => ({ inboxId, from: period.from, to: period.to, analysisVersion: ANALYSIS_VERSION, model: defaultChatModel().id });

async function stateOf(job: AnalysisJob | null): Promise<InboxAnalysisState> {
  if (!job) return { job: null, result: null };
  const shown = effectiveJob(job);
  const run = shown.status === "completed" && shown.runId ? await getRun(shown.runId) : null;
  return {
    job: { id: shown.id, status: shown.status, startedAt: shown.startedAt, finishedAt: shown.finishedAt, error: shown.error },
    result: run ? await renderStoredRun(run) : null,
  };
}

/**
 * Starts the AI analysis of one inbox as a server-side job (ADR-051) and returns at once: the work runs
 * after the response, so it continues when the browser goes away. An analysis of the same inbox, period
 * and method that is already running is joined, never started twice. Used by the Leadanalys page and the
 * chat alike.
 */
export async function startInboxAnalysisAction(raw: unknown): Promise<LeadActionResult<InboxAnalysisState>> {
  const { session } = await requireLeadAccess();
  if (!leadAnalysisExternalAllowed()) return { ok: false, error: "AI-analysen är inte aktiverad i den här miljön." };
  if (!hubSpotConfigured()) return { ok: false, error: hubSpotMessage(new HubSpotError("not_configured")) };
  const resolved = await inboxAndPeriod(raw);
  if (!resolved) return { ok: false, error: "Inkorgen hittades inte." };
  const { inbox, period } = resolved;
  if (daysBetween(period.from, period.to) > MAX_SYNC_DAYS) return { ok: false, error: `Välj en period på högst ${MAX_SYNC_DAYS} dagar.` };
  const supabase = await createSupabaseServerClient();
  let started: { id: string; created: boolean };
  try {
    started = await startAnalysisJob(jobKey(inbox.id, period), supabase);
  } catch {
    return { ok: false, error: "Analysen kunde inte startas. Försök igen." };
  }
  if (started.created) {
    // After the response: within the route's max duration, independent of the browser.
    after(() => runInboxAnalysisJob({ jobId: started.id, inbox, period, userId: session.user.id, supabase }));
  }
  const job = await latestAnalysisJob(jobKey(inbox.id, period), supabase);
  return { ok: true, data: { ...(await stateOf(job)), alreadyRunning: !started.created } };
}

/** The status of the latest analysis of an inbox and period – read from the database, so it survives reloads. */
export async function inboxAnalysisStatusAction(raw: unknown): Promise<LeadActionResult<InboxAnalysisState>> {
  await requireLeadAccess();
  const resolved = await inboxAndPeriod(raw);
  if (!resolved) return { ok: false, error: "Inkorgen hittades inte." };
  try {
    return { ok: true, data: await stateOf(await latestAnalysisJob(jobKey(resolved.inbox.id, resolved.period))) };
  } catch {
    return { ok: false, error: "Status kunde inte hämtas." };
  }
}

/** AI's combined reading of a region or all regions, from stored classifications only. */
export async function summariseScopeAction(raw: unknown): Promise<LeadActionResult<LeadAIResult>> {
  const { session, access } = await requireLeadAccess();
  if (!leadAnalysisExternalAllowed()) return { ok: false, error: "AI-analysen är inte aktiverad i den här miljön." };
  const resolved = await scopeAndPeriod(raw);
  if (!resolved || resolved.data.scope.type === "inbox") return { ok: false, error: "Urvalet hittades inte." };
  const { data, period } = resolved;
  if (data.scope.type === "all" && !access.allRegions) return { ok: false, error: "Sammanvägningen för alla regioner kräver åtkomst till alla regioner." };
  if (data.scope.regionId === "none") return { ok: false, error: "Välj en region." };
  const run = await summariseScope({ scopeType: data.scope.type === "all" ? "all" : "region", regionId: data.scope.regionId, inboxIds: data.scopeInboxes.map((i) => i.id), period }, session.user.id);
  if (!run.ok) return run;
  await logSecurityEvent("leads.ai_analysis_run", {
    actorId: session.user.id,
    targetType: "lead_scope",
    targetId: data.scope.regionId ?? "all",
    metadata: { from: period.from, to: period.to, dialogues: run.result.run.dialoguesAnalysed, model: run.result.run.model, costUsd: run.result.run.costUsd },
  });
  return { ok: true, data: run.result };
}

/** Opens a stored analysis – no HubSpot or OpenAI call. RLS decides whether the user may see it. */
export async function openRunAction(runId: string): Promise<LeadActionResult<LeadAIResult>> {
  await requireLeadAccess();
  if (!z.uuid().safeParse(runId).success) return { ok: false, error: "Analysen hittades inte." };
  const run = await getRun(runId);
  if (!run) return { ok: false, error: "Analysen hittades inte." };
  return { ok: true, data: await renderStoredRun(run) };
}

const evidenceFilters = [
  "no_reply_open",
  "customer_last_stale",
  "clear_intent_customer_last",
  "waiting_customer",
  "follow_up_missing",
  "unanswered_questions",
  "missed_opportunity",
  "next_step_missing",
  "undetermined",
  "stated_other_channel",
  "virtual",
] as const;
const oneOf = (prefix: string, values: readonly string[]) => z.string().regex(new RegExp("^" + prefix + ":(" + values.join("|") + ")$"));
const evidenceFilter = z.union([
  z.enum(evidenceFilters),
  oneOf("opportunity", OPPORTUNITY_TYPES),
  oneOf("strength", STRENGTH_TYPES),
  oneOf("bucket", RESPONSE_BUCKETS.map((b) => b.id)),
  // A source name as stored (any text, bounded); it is only compared, never used in a query.
  z.string().regex(/^source:.{1,80}$/),
]);

/** The leads behind an insight or a finding: structured reasons and HubSpot links, no dialogue text. */
export async function evidenceAction(raw: unknown, selection: { filter?: string; threadIds?: string[] }): Promise<LeadActionResult<EvidenceRow[]>> {
  await requireLeadAccess();
  const resolved = await scopeAndPeriod(raw);
  if (!resolved) return { ok: false, error: "Urvalet hittades inte." };
  const filter = evidenceFilter.optional().safeParse(selection?.filter);
  const threadIds = z.array(id).max(300).optional().safeParse(selection?.threadIds);
  if (!filter.success || !threadIds.success || (!filter.data && !threadIds.data)) return { ok: false, error: "Ogiltigt urval." };
  try {
    return { ok: true, data: await evidence(resolved.data, resolved.period, { filter: filter.data as EvidenceFilter | undefined, threadIds: threadIds.data }) };
  } catch {
    return { ok: false, error: "Underlaget kunde inte hämtas." };
  }
}
