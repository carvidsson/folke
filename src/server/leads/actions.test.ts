import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvForTests } from "@/server/env";

import { setHubSpotFetchForTests } from "./hubspot";
import { clearLeadCachesForTests } from "./service";

vi.mock("@/server/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/audit", () => ({ logSecurityEvent: vi.fn(async () => {}) }));

const { getSession } = await import("@/server/auth/session");
const { logSecurityEvent } = await import("@/server/audit");
const { leadAIAnalysisAction, leadReportAction } = await import("./actions");

const KEY = "pat-test-placeholder-not-a-real-key";
let hubSpotCalls = 0;

function as(role: "system_admin" | "assistant_manager" | "employee") {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: "11111111-1111-4111-8111-111111111111", role } as never,
    sessionStartedAt: new Date(),
  });
}

beforeEach(() => {
  hubSpotCalls = 0;
  process.env.HUBSPOT_SERVICE_KEY = KEY;
  resetServerEnvForTests();
  clearLeadCachesForTests();
  setHubSpotFetchForTests(
    (async (input: string | URL | Request) => {
      hubSpotCalls++;
      const path = new URL(String(input)).pathname;
      const body = path.endsWith("/inboxes")
        ? { results: [{ id: "900001", name: "Testinkorg" }] }
        : { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
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

const VALID = { inboxId: "900001", from: "2026-09-01", to: "2026-09-30" };

describe("lead analysis actions", () => {
  it("are for system administrators only, and log denied attempts", async () => {
    for (const role of ["employee", "assistant_manager"] as const) {
      as(role);
      await expect(leadReportAction(VALID)).rejects.toThrow("Behörighet saknas");
      await expect(leadAIAnalysisAction(VALID)).rejects.toThrow("Behörighet saknas");
    }
    expect(hubSpotCalls).toBe(0);
    expect(logSecurityEvent).toHaveBeenCalledWith("access.denied", expect.objectContaining({ metadata: { area: "admin.leads" } }));
  });

  it("validates inbox and period before calling HubSpot", async () => {
    as("system_admin");
    const cases: [unknown, string][] = [
      [{ ...VALID, inboxId: "../x" }, "Välj en inkorg och en giltig period."],
      [{ ...VALID, from: "2026-10-01", to: "2026-09-01" }, "Startdatum måste ligga före slutdatum."],
      [{ ...VALID, from: "2026-01-01", to: "2026-09-01" }, "Välj en period på högst 92 dagar."],
      [{ ...VALID, from: "2099-01-01", to: "2099-01-02" }, "Perioden kan inte sluta i framtiden."],
      [{ ...VALID, from: "2026-02-31" }, "Välj en inkorg och en giltig period."],
      [null, "Välj en inkorg och en giltig period."],
    ];
    for (const [input, error] of cases) {
      await expect(leadReportAction(input)).resolves.toEqual({ ok: false, error });
    }
    expect(hubSpotCalls).toBe(0);
  });

  it("returns a report without the key, and logs the read", async () => {
    as("system_admin");
    const result = await leadReportAction(VALID);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logSecurityEvent).toHaveBeenCalledWith("leads.report_generated", expect.objectContaining({ targetId: "900001" }));
  });

  it("reports a missing key or unknown inbox in Swedish", async () => {
    as("system_admin");
    await expect(leadReportAction({ ...VALID, inboxId: "123" })).resolves.toEqual({ ok: false, error: "Inkorgen hittades inte i HubSpot." });
    delete process.env.HUBSPOT_SERVICE_KEY;
    resetServerEnvForTests();
    await expect(leadReportAction(VALID)).resolves.toEqual({ ok: false, error: "HubSpot är inte konfigurerat i den här miljön." });
  });

  it("refuses AI analysis unless it is explicitly enabled", async () => {
    as("system_admin");
    await expect(leadAIAnalysisAction(VALID)).resolves.toEqual({ ok: false, error: "AI-analysen är inte aktiverad i den här miljön." });
    expect(hubSpotCalls).toBe(0);
  });
});
