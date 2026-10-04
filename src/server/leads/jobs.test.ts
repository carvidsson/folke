import { describe, expect, it } from "vitest";

import type { AnalysisJob } from "@/server/data/leads";

import { effectiveJob, STALE_MESSAGE } from "./jobs";

/** A job that can no longer be running is shown as failed (ADR-051); the database marks it on the next start. */
describe("analysis job status", () => {
  const now = new Date("2026-10-04T08:00:00.000Z");
  const job = (startedSecondsAgo: number, heartbeatSecondsAgo: number, status: AnalysisJob["status"] = "running"): AnalysisJob => ({
    id: "j",
    status,
    startedAt: new Date(now.getTime() - startedSecondsAgo * 1000).toISOString(),
    heartbeatAt: new Date(now.getTime() - heartbeatSecondsAgo * 1000).toISOString(),
    finishedAt: null,
    runId: null,
    error: null,
  });

  it("a running job with a recent heartbeat is running", () => {
    expect(effectiveJob(job(120, 10), now).status).toBe("running");
  });

  it("no heartbeat for 150 s, or older than 6 minutes: it can no longer be running", () => {
    expect(effectiveJob(job(200, 160), now)).toMatchObject({ status: "failed", error: STALE_MESSAGE });
    expect(effectiveJob(job(400, 5), now)).toMatchObject({ status: "failed", error: STALE_MESSAGE });
  });

  it("finished jobs are shown as they are", () => {
    expect(effectiveJob(job(400, 400, "completed"), now).status).toBe("completed");
  });
});
