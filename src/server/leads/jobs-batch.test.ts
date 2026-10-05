import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI analysis of a region (ort) in one click (ADR-053): the region's inboxes run as ordinary inbox
 * jobs, two at a time, within the batch's time budget, and the region's combined analysis is written
 * once at the end. Synthetic data only; no HubSpot or OpenAI.
 */

const startAnalysisJob = vi.fn();
const updateAnalysisJob = vi.fn(async () => true);
vi.mock("@/server/data/leads", () => ({ startAnalysisJob, updateAnalysisJob, leadStore: () => ({}) }));
vi.mock("@/server/audit", () => ({ logSecurityEvent: vi.fn(async () => {}) }));
const syncInbox = vi.fn(async () => ({ complete: true }));
vi.mock("./sync", () => ({ syncInbox }));
const analyseInbox = vi.fn();
const summariseScope = vi.fn(async () => ({ ok: true, result: {} }));
vi.mock("./service", () => ({ analyseInbox, summariseScope }));

const { BATCH_BUDGET_MS, runRegionAnalysisBatch } = await import("./jobs");

const PERIOD = { preset: "7d" as const, from: "2026-09-28", to: "2026-10-04", label: "Senaste 7 dagarna" };
const inboxes = ["900001", "900002", "900003", "900004", "900005"].map((id) => ({ id, name: `Syntetisk inkorg ${id}` }));
const input = (over: Partial<Parameters<typeof runRegionAnalysisBatch>[0]> = {}) => ({
  inboxes,
  region: { id: "region-1", inboxIds: inboxes.map((i) => i.id) },
  period: PERIOD,
  userId: "user-1",
  supabase: {} as never,
  jobKey: (inboxId: string) => ({ inboxId, from: PERIOD.from, to: PERIOD.to, analysisVersion: "lead-ai-3.1", model: "m" }),
  ...over,
});
const run = { ok: true, result: { run: { id: "run", dialoguesAnalysed: 1, analysedNew: 1, reused: 0, model: "m", costUsd: 0 } } };

beforeEach(() => {
  vi.clearAllMocks();
  startAnalysisJob.mockImplementation(async (key: { inboxId: string }) => ({ id: `job-${key.inboxId}`, created: true }));
});
afterEach(() => vi.restoreAllMocks());

describe("region analysis batch", () => {
  it("analyses every inbox as its own job, two at a time, then writes the region's combined analysis once", async () => {
    let active = 0;
    let most = 0;
    const order: string[] = [];
    analyseInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      order.push(inbox.id);
      return run;
    });
    await runRegionAnalysisBatch(input());
    expect(order.sort()).toEqual(inboxes.map((i) => i.id));
    expect(most).toBe(2);
    expect(updateAnalysisJob).toHaveBeenCalledWith("job-900003", { status: "completed", runId: "run" }, expect.anything());
    // Each inbox analysis stops in time for the batch.
    expect(analyseInbox.mock.calls[0][2]).toMatchObject({ deadline: expect.any(Number) });
    expect(summariseScope).toHaveBeenCalledTimes(1);
    expect(summariseScope).toHaveBeenCalledWith(expect.objectContaining({ scopeType: "region", regionId: "region-1" }), "user-1", expect.anything());
    // The combined analysis comes after the last inbox.
    expect(summariseScope.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...analyseInbox.mock.invocationCallOrder));
  });

  it("leaves an inbox that is already being analysed to that job, and has no combined analysis for 'Utan region'", async () => {
    startAnalysisJob.mockImplementation(async (key: { inboxId: string }) => ({ id: `job-${key.inboxId}`, created: key.inboxId !== "900002" }));
    analyseInbox.mockResolvedValue(run);
    await runRegionAnalysisBatch(input({ region: null }));
    expect(analyseInbox.mock.calls.map((c) => c[0].inbox.id)).not.toContain("900002");
    expect(analyseInbox).toHaveBeenCalledTimes(4);
    expect(summariseScope).not.toHaveBeenCalled();
  });

  it("starts no inbox it cannot finish within the budget – the rest is analysed at the next click", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    analyseInbox.mockImplementation(async () => {
      // Each inbox takes four minutes.
      now += 240_000;
      return run;
    });
    await runRegionAnalysisBatch(input());
    // 740 s: two in parallel take 4 min each; the third pair would start with < 90 s left.
    expect(BATCH_BUDGET_MS).toBeLessThan(800_000);
    expect(analyseInbox.mock.calls.length).toBeLessThan(inboxes.length);
    expect(startAnalysisJob.mock.calls.length).toBe(analyseInbox.mock.calls.length);
  });
});
