import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI analysis of a region (ort) in one click (ADR-053): the region's inboxes run as ordinary inbox
 * jobs, two at a time, within the batch's time budget. The combined analyses stay off the critical path:
 * the batch moves on once an inbox is classified, and the region's combined analysis starts when every
 * inbox is classified, while the last inboxes write theirs. Synthetic data only; no HubSpot or OpenAI.
 */

const startAnalysisJob = vi.fn();
const updateAnalysisJob = vi.fn<(id: string, update: { status: string }, client: unknown) => Promise<boolean>>(async () => true);
vi.mock("@/server/data/leads", () => ({ startAnalysisJob, updateAnalysisJob, leadStore: () => ({}) }));
vi.mock("@/server/audit", () => ({ logSecurityEvent: vi.fn(async () => {}) }));
const syncInbox = vi.fn(async () => ({ complete: true }));
vi.mock("./sync", () => ({ syncInbox }));
const classifyInbox = vi.fn();
const finishInboxAnalysis = vi.fn();
const summariseScope = vi.fn(async () => ({ ok: true, result: {} }));
vi.mock("./service", () => ({ classifyInbox, finishInboxAnalysis, summariseScope }));

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  startAnalysisJob.mockImplementation(async (key: { inboxId: string }) => ({ id: `job-${key.inboxId}`, created: true }));
  classifyInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => ({ ok: true, classified: { inbox: inbox.id } }));
  finishInboxAnalysis.mockResolvedValue(run);
});
afterEach(() => vi.restoreAllMocks());

describe("region analysis batch", () => {
  it("classifies every inbox as its own job, two at a time; each job then writes its own run", async () => {
    let active = 0;
    let most = 0;
    classifyInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => {
      active++;
      most = Math.max(most, active);
      await sleep(5);
      active--;
      return { ok: true, classified: { inbox: inbox.id } };
    });
    await runRegionAnalysisBatch(input());
    expect(classifyInbox.mock.calls.map((c) => c[0].inbox.id).sort()).toEqual(inboxes.map((i) => i.id));
    expect(most).toBe(2);
    expect(finishInboxAnalysis).toHaveBeenCalledTimes(5);
    expect(updateAnalysisJob).toHaveBeenCalledWith("job-900003", { status: "completed", runId: "run" }, expect.anything());
    expect(classifyInbox.mock.calls[0][2]).toMatchObject({ deadline: expect.any(Number) });
    expect(summariseScope).toHaveBeenCalledTimes(1);
    expect(summariseScope).toHaveBeenCalledWith(expect.objectContaining({ scopeType: "region", regionId: "region-1" }), "user-1", expect.anything());
  });

  it("keeps the combined analyses off the critical path: the next inbox does not wait for one, and the region's starts once all are classified", async () => {
    const order: string[] = [];
    classifyInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => {
      order.push(`classify ${inbox.id}`);
      await sleep(5);
      order.push(`classified ${inbox.id}`);
      return { ok: true, classified: { inbox: inbox.id } };
    });
    // An inbox's combined analysis takes longer than classifying the next inbox.
    finishInboxAnalysis.mockImplementation(async (c: { inbox: string }) => {
      order.push(`summary ${c.inbox}`);
      await sleep(40);
      order.push(`summarised ${c.inbox}`);
      return run;
    });
    summariseScope.mockImplementation(async () => {
      order.push("region summary");
      return { ok: true, result: {} };
    });
    await runRegionAnalysisBatch(input());
    // The third inbox is classified before the first inbox's combined analysis is done.
    expect(order.indexOf("classified 900003")).toBeLessThan(order.indexOf("summarised 900001"));
    // The region's combined analysis starts after every inbox is classified, and before the last inbox's is done.
    const region = order.indexOf("region summary");
    for (const i of inboxes) expect(region).toBeGreaterThan(order.indexOf(`classified ${i.id}`));
    expect(region).toBeLessThan(order.indexOf("summarised 900005"));
    // The batch ends only when every job has written its run.
    expect(finishInboxAnalysis).toHaveBeenCalledTimes(5);
    expect(updateAnalysisJob.mock.calls.filter((c) => (c[1] as { status: string }).status === "completed")).toHaveLength(5);
  });

  it("an inbox that fails is reported as failed and the batch goes on", async () => {
    classifyInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => (inbox.id === "900002" ? { ok: false, error: "Analysen kunde inte genomföras." } : { ok: true, classified: { inbox: inbox.id } }));
    await runRegionAnalysisBatch(input());
    expect(updateAnalysisJob).toHaveBeenCalledWith("job-900002", { status: "failed", error: "Analysen kunde inte genomföras." }, expect.anything());
    expect(finishInboxAnalysis).toHaveBeenCalledTimes(4);
    expect(summariseScope).toHaveBeenCalledTimes(1);
  });

  it("leaves an inbox that is already being analysed to that job, and has no combined analysis for 'Utan region'", async () => {
    startAnalysisJob.mockImplementation(async (key: { inboxId: string }) => ({ id: `job-${key.inboxId}`, created: key.inboxId !== "900002" }));
    await runRegionAnalysisBatch(input({ region: null }));
    expect(classifyInbox.mock.calls.map((c) => c[0].inbox.id)).not.toContain("900002");
    expect(classifyInbox).toHaveBeenCalledTimes(4);
    expect(summariseScope).not.toHaveBeenCalled();
  });

  it("starts no inbox it cannot finish within the budget – the rest is analysed at the next click", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    classifyInbox.mockImplementation(async ({ inbox }: { inbox: { id: string } }) => {
      // Each inbox takes four minutes.
      now += 240_000;
      return { ok: true, classified: { inbox: inbox.id } };
    });
    await runRegionAnalysisBatch(input());
    expect(BATCH_BUDGET_MS).toBeLessThan(800_000);
    expect(classifyInbox.mock.calls.length).toBeLessThan(inboxes.length);
    expect(startAnalysisJob.mock.calls.length).toBe(classifyInbox.mock.calls.length);
  });
});
