import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvForTests } from "@/server/env";

import { setHubSpotFetchForTests } from "./hubspot";
import { clearLeadCachesForTests } from "./service";

/**
 * Server-side access control of the lead analysis actions (ADR-048). The
 * database (RLS) is mocked here as "what the user's session returns"; the
 * policies themselves are tested in tests/db/leads.test.ts and tests/live.
 */

vi.mock("@/server/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/audit", () => ({ logSecurityEvent: vi.fn(async () => {}) }));
vi.mock("@/server/data/leads", () => ({
  myLeadAccess: vi.fn(),
  listLeadRegions: vi.fn(async () => [{ id: REGION_A, name: "Region A", sortOrder: 1 }]),
  listLeadInboxes: vi.fn(async () => visibleInboxes),
  listSyncs: vi.fn(async () => []),
  listLeadRows: vi.fn(async () => []),
  sellerNames: vi.fn(async () => new Map()),
  getThreadUrlTemplate: vi.fn(async () => null),
  getRun: vi.fn(async () => null),
  leadStore: vi.fn(() => ({ loadAnalyses: async () => new Map() })),
}));

const REGION_A = "11111111-1111-4111-8111-111111111111";
const REGION_B = "22222222-2222-4222-8222-222222222222";
let visibleInboxes: { id: string; name: string; configured: boolean; active: boolean; regionId: string | null; facility: null; brand: null }[] = [];

const { getSession } = await import("@/server/auth/session");
const { logSecurityEvent } = await import("@/server/audit");
const data = await import("@/server/data/leads");
const actions = await import("./actions");
const admin = await import("./admin-actions");

const KEY = "pat-test-placeholder-not-a-real-key";
let hubSpotCalls = 0;

function as(role: "system_admin" | "assistant_manager" | "employee", access: { hasAccess: boolean; allRegions?: boolean; regionIds?: string[] }) {
  vi.mocked(getSession).mockResolvedValue({ user: { id: "11111111-1111-4111-8111-111111111111", role } as never, sessionStartedAt: new Date() });
  vi.mocked(data.myLeadAccess).mockResolvedValue({ hasAccess: access.hasAccess, isAdmin: role === "system_admin", allRegions: access.allRegions ?? false, regionIds: access.regionIds ?? [] });
}

beforeEach(() => {
  hubSpotCalls = 0;
  process.env.HUBSPOT_SERVICE_KEY = KEY;
  resetServerEnvForTests();
  clearLeadCachesForTests();
  visibleInboxes = [{ id: "900001", name: "Testinkorg A", configured: true, active: true, regionId: REGION_A, facility: null, brand: null }];
  setHubSpotFetchForTests(
    (async () => {
      hubSpotCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch,
    async () => {},
  );
  vi.mocked(logSecurityEvent).mockClear();
});

afterEach(() => {
  setHubSpotFetchForTests(null);
  delete process.env.HUBSPOT_SERVICE_KEY;
  resetServerEnvForTests();
});

const SCOPE = { regionId: REGION_A, preset: "30d" };
const userActions = () => [
  () => actions.syncLeadsAction(SCOPE),
  () => actions.analyseInboxAction({ inboxId: "900001" }),
  () => actions.summariseScopeAction(SCOPE),
  () => actions.openRunAction("33333333-3333-4333-8333-333333333333"),
  () => actions.evidenceAction(SCOPE, { filter: "no_reply_open" }),
];

describe("lead analysis actions", () => {
  it("refuse users without lead access, log the attempt and never call HubSpot", async () => {
    for (const role of ["employee", "assistant_manager"] as const) {
      as(role, { hasAccess: false });
      for (const call of userActions()) await expect(call()).rejects.toThrow("Behörighet saknas");
    }
    expect(hubSpotCalls).toBe(0);
    expect(logSecurityEvent).toHaveBeenCalledWith("access.denied", expect.objectContaining({ metadata: { area: "leads" } }));
  });

  it("treat an inbox or region outside the user's access as not found", async () => {
    as("employee", { hasAccess: true, regionIds: [REGION_A] });
    // RLS returns only region A's inbox to this user.
    await expect(actions.analyseInboxAction({ inboxId: "900002" })).resolves.toMatchObject({ ok: false });
    await expect(actions.syncLeadsAction({ regionId: REGION_B })).resolves.toEqual({ ok: false, error: "Urvalet hittades inte." });
    await expect(actions.evidenceAction({ regionId: REGION_B }, { filter: "no_reply_open" })).resolves.toEqual({ ok: false, error: "Urvalet hittades inte." });
    // A sync request naming another inbox only touches what the scope allows.
    const result = await actions.syncLeadsAction({ regionId: REGION_A }, ["900002"]);
    expect(result).toEqual({ ok: true, data: { done: [], remaining: [], incomplete: [] } });
    expect(hubSpotCalls).toBe(0);
  });

  it("validate input before doing anything", async () => {
    as("employee", { hasAccess: true, regionIds: [REGION_A] });
    await expect(actions.syncLeadsAction({ inboxId: "../x" })).resolves.toEqual({ ok: false, error: "Urvalet hittades inte." });
    await expect(actions.syncLeadsAction({ regionId: REGION_A, preset: "custom", from: "2026-01-01", to: "2026-09-30" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/högst 92 dagar/) });
    await expect(actions.evidenceAction(SCOPE, { filter: "everything" })).resolves.toEqual({ ok: false, error: "Ogiltigt urval." });
    await expect(actions.evidenceAction(SCOPE, { threadIds: ["1; drop table"] })).resolves.toEqual({ ok: false, error: "Ogiltigt urval." });
    await expect(actions.openRunAction("not-a-uuid")).resolves.toEqual({ ok: false, error: "Analysen hittades inte." });
    expect(hubSpotCalls).toBe(0);
  });

  it("keep AI behind its flag and the all-regions summary behind all-region access", async () => {
    as("employee", { hasAccess: true, regionIds: [REGION_A] });
    await expect(actions.analyseInboxAction({ inboxId: "900001" })).resolves.toEqual({ ok: false, error: "AI-analysen är inte aktiverad i den här miljön." });
    process.env.FOLKE_LEAD_ANALYSIS_AI = "on";
    process.env.FOLKE_AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-placeholder";
    resetServerEnvForTests();
    try {
      await expect(actions.summariseScopeAction({})).resolves.toEqual({ ok: false, error: "Sammanvägningen för alla regioner kräver åtkomst till alla regioner." });
    } finally {
      process.env.FOLKE_LEAD_ANALYSIS_AI = "off";
      process.env.FOLKE_AI_PROVIDER = "mock";
      delete process.env.OPENAI_API_KEY;
      resetServerEnvForTests();
    }
  });

  it("return evidence without the key or any dialogue text", async () => {
    as("employee", { hasAccess: true, regionIds: [REGION_A] });
    const result = await actions.evidenceAction(SCOPE, { filter: "no_reply_open" });
    expect(result).toEqual({ ok: true, data: [] });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("lead analysis configuration", () => {
  it("is for system administrators only – lead access is not enough", async () => {
    as("employee", { hasAccess: true, allRegions: true });
    const calls = [
      () => admin.saveLeadInboxAction({ id: "900001", active: true }),
      () => admin.saveLeadRegionAction({ name: "Ny", sortOrder: 1 }),
      () => admin.deleteLeadRegionAction(REGION_A),
      () => admin.addLeadGrantAction({ subject: "user", subjectId: REGION_A, regionId: null }),
      () => admin.removeLeadGrantAction(REGION_A),
      () => admin.saveThreadUrlAction("https://app.hubspot.com/x"),
      () => admin.clearThreadUrlAction(),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow("Behörighet saknas");
    expect(logSecurityEvent).toHaveBeenCalledWith("access.denied", expect.objectContaining({ metadata: { area: "leads.admin" } }));
    expect(hubSpotCalls).toBe(0);
  });
});
