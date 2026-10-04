import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Period } from "@/lib/leads/types";
import { logSecurityEvent } from "@/server/audit";
import { leadStore, updateAnalysisJob, type AnalysisJob } from "@/server/data/leads";

import { HubSpotError } from "./hubspot";
import { analyseInbox } from "./service";
import { syncInbox } from "./sync";

/**
 * The AI analysis of an inbox as a server-side job (ADR-051). The action registers the job in the
 * database and returns at once; this runs after the response (Next.js after(), within the route's max
 * duration of 300 s), so it does not depend on the browser staying connected. It keeps a heartbeat and
 * ends as completed (with the stored run) or failed (with a short message). The status is read from the
 * database by the Leadanalys page and the chat.
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
}): Promise<void> {
  const { jobId, inbox, period, userId, supabase } = input;
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
      await syncInbox(inbox, period, store, { deadline: Date.now() + 60_000 });
    } catch (error) {
      console.error("[leads/job] HubSpot request failed", error instanceof HubSpotError ? error.code : "unknown");
      await finish({ status: "failed", error: "Det gick inte att hämta data från HubSpot. Försök igen." });
      return;
    }
    const run = await analyseInbox({ inbox, period }, userId, { store });
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
