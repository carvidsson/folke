import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Period } from "@/lib/leads/types";
import { logSecurityEvent } from "@/server/audit";
import { leadStore, startAnalysisJob, updateAnalysisJob, type AnalysisJob } from "@/server/data/leads";

import { HubSpotError } from "./hubspot";
import { classifyInbox, finishInboxAnalysis, summariseScope } from "./service";
import { syncInbox } from "./sync";

/**
 * The AI analysis of an inbox as a server-side job (ADR-051). The action registers the job in the
 * database and returns at once; this runs after the response (Next.js after(), within the route's max
 * duration – 800 s on Vercel Pro), so it does not depend on the browser staying connected. It keeps a heartbeat and
 * ends as completed (with the stored run) or failed (with a short message). The status is read from the
 * database by the Leadanalys page and the chat. A region runs its inboxes as such jobs (ADR-053).
 */

/** How often a running job reports that it is alive. */
export const HEARTBEAT_MS = 20_000;
/** Without a heartbeat for this long, or older than this, a job can no longer be running (same limits as the database). */
export const STALE_HEARTBEAT_MS = 150_000;
export const STALE_AGE_MS = 6 * 60_000;

export const STALE_MESSAGE = "Analysen avbröts innan den blev klar.";

/** A "running" job that can no longer be running is shown as failed (the next start marks it so). */
export function effectiveJob(job: AnalysisJob, now = new Date()): AnalysisJob {
  if (job.status !== "running") return job;
  const stale = now.getTime() - Date.parse(job.heartbeatAt) > STALE_HEARTBEAT_MS || now.getTime() - Date.parse(job.startedAt) > STALE_AGE_MS;
  return stale ? { ...job, status: "failed", error: STALE_MESSAGE } : job;
}

export async function runInboxAnalysisJob(input: {
  jobId: string;
  inbox: { id: string; name: string };
  period: Period;
  userId: string;
  /** The user's own client, created during the request: RLS applies to everything the job reads and writes. */
  supabase: SupabaseClient;
  /** Set by a region batch: the job stops in time for the batch's own limit. */
  deadline?: number;
  /**
   * Set by a region batch (ADR-053): called when the inbox's dialogues are classified and stored. The
   * batch then goes on with the next inbox while this job writes the inbox's combined analysis.
   */
  onClassified?: () => void;
}): Promise<void> {
  const { jobId, inbox, period, userId, supabase, deadline, onClassified } = input;
  const store = leadStore(supabase);
  const finish = async (update: Parameters<typeof updateAnalysisJob>[1]) => {
    try {
      await updateAnalysisJob(jobId, update, supabase);
    } catch (error) {
      console.error("[leads/job] could not record the end of a job", error instanceof Error ? error.message : "unknown");
    }
  };
  const beat = setInterval(() => void updateAnalysisJob(jobId, { status: "running" }, supabase).catch(() => {}), HEARTBEAT_MS);
  try {
    // Fresh facts first: the analysis decides from them what has changed.
    try {
      await syncInbox(inbox, period, store, { deadline: Math.min(Date.now() + 60_000, deadline ?? Infinity) });
    } catch (error) {
      console.error("[leads/job] HubSpot request failed", error instanceof HubSpotError ? error.code : "unknown");
      await finish({ status: "failed", error: "Det gick inte att hämta data från HubSpot. Försök igen." });
      return;
    }
    const classified = await classifyInbox({ inbox, period }, userId, { store, deadline });
    if (!classified.ok) {
      await finish({ status: "failed", error: classified.error });
      return;
    }
    onClassified?.();
    const run = await finishInboxAnalysis(classified.classified);
    if (!run.ok) {
      await finish({ status: "failed", error: run.error });
      return;
    }
    await finish({ status: "completed", runId: run.result.run.id || null });
    await logSecurityEvent("leads.ai_analysis_run", {
      actorId: userId,
      targetType: "hubspot_inbox",
      targetId: inbox.id,
      metadata: {
        from: period.from,
        to: period.to,
        job: jobId,
        dialogues: run.result.run.dialoguesAnalysed,
        analysedNew: run.result.run.analysedNew,
        reused: run.result.run.reused,
        model: run.result.run.model,
        costUsd: run.result.run.costUsd,
      },
    });
  } catch (error) {
    console.error("[leads/job] analysis failed", error instanceof Error ? error.name : "unknown");
    await finish({ status: "failed", error: "Analysen kunde inte genomföras. Försök igen." });
  } finally {
    clearInterval(beat);
  }
}

// ---------------------------------------------------------------------------
// A region (ort): all relevant inboxes in one click
// ---------------------------------------------------------------------------

/** Within the Leadanalys page's and the chat's max duration (800 s, Vercel Pro with Fluid compute): the batch ends before it. */
export const BATCH_BUDGET_MS = 740_000;
/** Inbox analyses at the same time: the per-user AI concurrency limit (FOLKE_AI_MAX_CONCURRENT_PER_USER). */
const BATCH_PARALLEL = 2;
/** No new inbox starts with less time than this left; what remains is analysed at the next click. */
const MIN_TIME_FOR_INBOX_MS = 90_000;
/** Kept free at the end of the batch for the combined analyses (about 15–25 s). */
const SUMMARY_TIME_MS = 40_000;

/**
 * Analyses the inboxes of a region that lack a current analysis – each as its own inbox job (ADR-051),
 * two at a time – and writes the region's combined analysis from the stored classifications (ADR-053).
 * Runs after the response, independent of the browser. Every inbox job is registered when it starts (so
 * its heartbeat and limits apply as for a single inbox); an inbox already running is left to it.
 *
 * The combined analyses are kept off the critical path: the batch moves on to the next inbox as soon as
 * an inbox's dialogues are classified, while that inbox's job writes its own combined analysis; the
 * region's starts when every inbox is classified, at the same time as the last inboxes' ones.
 */
export async function runRegionAnalysisBatch(input: {
  inboxes: { id: string; name: string }[];
  region: { id: string; inboxIds: string[] } | null;
  period: Period;
  userId: string;
  supabase: SupabaseClient;
  jobKey: (inboxId: string) => Parameters<typeof startAnalysisJob>[0];
}): Promise<void> {
  const end = Date.now() + BATCH_BUDGET_MS;
  const queue = [...input.inboxes];
  const jobs: Promise<void>[] = [];
  const worker = async () => {
    for (let inbox = queue.shift(); inbox; inbox = queue.shift()) {
      if (end - Date.now() < MIN_TIME_FOR_INBOX_MS) return;
      let job: { id: string; created: boolean };
      try {
        job = await startAnalysisJob(input.jobKey(inbox.id), input.supabase);
      } catch {
        console.error("[leads/batch] could not register an inbox job");
        continue;
      }
      if (!job.created) continue;
      let classified = () => {};
      const ready = new Promise<void>((resolve) => (classified = resolve));
      const running = runInboxAnalysisJob({
        jobId: job.id,
        inbox,
        period: input.period,
        userId: input.userId,
        supabase: input.supabase,
        // Room for the combined analyses after the last inbox.
        deadline: end - SUMMARY_TIME_MS,
        onClassified: classified,
      });
      jobs.push(running);
      // On to the next inbox once this one is classified (or its job has ended early).
      await Promise.race([ready, running]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_PARALLEL, queue.length) }, worker));

  // Every inbox is classified: the region's combined analysis, while the last inboxes write theirs.
  const region =
    input.region && end - Date.now() > SUMMARY_TIME_MS / 2
      ? summariseScope({ scopeType: "region", regionId: input.region.id, inboxIds: input.region.inboxIds, period: input.period }, input.userId, { store: leadStore(input.supabase) })
          .then((run) => {
            if (!run.ok) console.info("[leads/batch] no combined analysis", run.error.slice(0, 80));
          })
          .catch(() => console.error("[leads/batch] combined analysis failed"))
      : Promise.resolve();
  await Promise.all([...jobs, region]);
}
