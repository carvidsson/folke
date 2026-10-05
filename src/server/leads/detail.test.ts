import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LeadRow } from "@/lib/leads/types";

/**
 * Which inboxes of a region a region analysis runs (ADR-053): only those that lack a current analysis
 * of the dialogues or the customer needs, or whose period is not fetched – from stored data only.
 * Synthetic data only.
 */

let rows: LeadRow[] = [];
let syncs: { inboxId: string; from: string; to: string; syncedAt: string; complete: boolean }[] = [];
let analyses = new Map<string, { sourceLatestMessageAt: string | null; situationState: string }>();
let needs = new Map<string, { sourceLatestMessageAt: string | null }>();
vi.mock("@/server/data/leads", () => ({
  listLeadRows: async () => rows,
  listSyncs: async () => syncs,
  leadStore: () => ({ loadAnalyses: async () => analyses }),
  getThreadUrlTemplate: async () => null,
  listRuns: async () => [],
  sellerNames: async () => new Map(),
}));
vi.mock("./overview", () => ({ loadNeedsOrNull: async () => needs, isWaiting: () => false, threadUrl: () => null }));
vi.mock("./service", () => ({ aiCounts: () => null }));
vi.mock("./runs", () => ({ renderStoredRun: async () => null }));

const { analysisCoverage } = await import("./detail");

const TODAY = "2026-10-04";
const PERIOD = { preset: "custom" as const, from: "2026-09-28", to: "2026-10-03", label: "" };
const NOW = new Date("2026-10-04T10:00:00.000Z");
const inboxes = [
  { id: "900001", name: "Syntetisk A" },
  { id: "900002", name: "Syntetisk B" },
  { id: "900003", name: "Syntetisk C" },
  { id: "900004", name: "Syntetisk D" },
];
const data = { scopeInboxes: inboxes, scope: { type: "region", regionId: "r", inboxId: null, name: "Ort", trail: [] } } as never;

function row(threadId: string, inboxId: string, p: Partial<LeadRow> = {}): LeadRow {
  return {
    threadId,
    inboxId,
    arrivedAt: "2026-09-30T08:00:00.000Z",
    arrivalWindow: "business_hours",
    channel: "form",
    source: null,
    formName: null,
    vehicle: null,
    status: "registered_reply",
    firstResponseAt: null,
    calendarMinutes: 30,
    businessMinutes: 30,
    ownerId: null,
    responderId: null,
    assignmentEvents: 0,
    movedIntoInbox: false,
    threadOpen: false,
    customerMessages: 1,
    sellerMessages: 1,
    internalComments: 0,
    customerWroteLast: false,
    latestMessageAt: "2026-09-30T09:00:00.000Z",
    lastCustomerMessageAt: null,
    firstSellerAfterCustomerAt: null,
    followedUp: false,
    vehicleBrand: null,
    vehicleModel: null,
    vehicleSource: null,
    regnrKind: null,
    ...p,
  };
}
const synced = (inboxId: string, syncedAt = "2026-10-04T09:30:00.000Z") => ({ inboxId, from: "2026-09-01", to: TODAY, syncedAt, complete: true });

beforeEach(() => {
  // A: everything current. B: a changed dialogue. C: never fetched. D: fetched, no leads.
  rows = [row("1", "900001"), row("2", "900002", { latestMessageAt: "2026-10-01T09:00:00.000Z" })];
  syncs = [synced("900001"), synced("900002"), synced("900004")];
  analyses = new Map([
    ["1", { sourceLatestMessageAt: "2026-09-30T09:00:00.000Z", situationState: "none" }],
    ["2", { sourceLatestMessageAt: "2026-09-30T09:00:00.000Z", situationState: "none" }],
  ]);
  needs = new Map([
    ["1", { sourceLatestMessageAt: "2026-09-30T09:00:00.000Z" }],
    ["2", { sourceLatestMessageAt: "2026-10-01T09:00:00.000Z" }],
  ]);
});

describe("region analysis coverage", () => {
  it("reuses current inboxes and runs the changed and unfetched ones; an inbox without leads is not relevant", async () => {
    const c = await analysisCoverage(data, PERIOD, TODAY, NOW);
    const byId = Object.fromEntries(c.map((x) => [x.id, x]));
    expect(byId["900001"]).toMatchObject({ relevant: true, current: true });
    expect(byId["900002"]).toMatchObject({ relevant: true, current: false, analysed: 0, eligible: 1 });
    expect(byId["900003"]).toMatchObject({ relevant: true, current: false, fetched: false });
    expect(byId["900004"]).toMatchObject({ relevant: false });
  });

  it("a missing customer-needs analysis also makes an inbox not current", async () => {
    needs = new Map();
    const c = await analysisCoverage(data, PERIOD, TODAY, NOW);
    expect(c.find((x) => x.id === "900001")).toMatchObject({ current: false, needsCurrent: 0, candidates: 1 });
  });

  it("a period that includes today is current only with a fetch within the hour", async () => {
    const withToday = { ...PERIOD, to: TODAY };
    syncs = [synced("900001", "2026-10-04T08:30:00.000Z")];
    const [a] = await analysisCoverage(data, withToday, TODAY, NOW);
    expect(a).toMatchObject({ fetched: true, current: false });
    syncs = [synced("900001", "2026-10-04T09:30:00.000Z")];
    expect((await analysisCoverage(data, withToday, TODAY, NOW))[0]).toMatchObject({ current: true });
  });
});
