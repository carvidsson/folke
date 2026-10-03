/**
 * LIVE tests of the persistent lead analysis (ADR-047) against the
 * DEVELOPMENT Supabase project: the real store (src/server/data/leads.ts)
 * through PostgREST with a signed-in system administrator, RLS for other
 * roles, reuse and versioning keys, and history aggregation. Synthetic ids
 * only (never real HubSpot ids); everything is removed afterwards. No calls
 * to HubSpot or OpenAI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";
import { leadStore } from "@/server/data/leads";
import type { RawClassification } from "@/server/leads/analysis";

import { cleanup, createUser, isDevelopmentProject, service, type LiveUser } from "./helpers";

// Synthetic HubSpot-like ids, far outside the real id ranges.
const SEED = String(Date.now()).slice(-9);
const INBOX = `99${SEED}`;
const THREADS = [`9901${SEED}`, `9902${SEED}`];
const SELLER = `A-99${SEED}`;

function row(threadId: string, partial: Partial<LeadRow> = {}): LeadRow {
  return {
    threadId,
    arrivedAt: "2026-09-02T08:00:00.000Z",
    arrivalWindow: "business_hours",
    channel: "form",
    source: "Blocket",
    formName: "Test – live formulär",
    vehicle: "Volkswagen Testmodell",
    status: "registered_reply",
    firstResponseAt: "2026-09-02T09:00:00.000Z",
    calendarMinutes: 60,
    businessMinutes: 60,
    ownerId: SELLER,
    responderId: SELLER,
    assignmentEvents: 1,
    movedIntoInbox: false,
    threadOpen: false,
    customerMessages: 1,
    sellerMessages: 1,
    internalComments: 0,
    customerWroteLast: false,
    ...partial,
  };
}

const classification: RawClassification = {
  intent: "availability",
  purchaseIntent: "interested",
  carStatus: "available",
  alternativeOffered: "not_applicable",
  behaviours: {
    answered_questions: { status: "done", reason: "" },
    next_step: { status: "missing", reason: "Inget konkret förslag." },
    needs_questions: { status: "not_relevant", reason: "" },
    visit_or_test_drive: { status: "missing", reason: "Ingen inbjudan trots köpintresse." },
    follow_up: { status: "not_relevant", reason: "" },
  },
  observations: ["Säljaren svarade snabbt."],
  evidence: "sufficient",
};

describe.skipIf(!isDevelopmentProject)("lead analysis store (live, development project)", () => {
  let admin: LiveUser;
  let employee: LiveUser;

  beforeAll(async () => {
    admin = await createUser("leadadmin", { role: "system_admin" });
    employee = await createUser("leadanstalld");
  });

  afterAll(async () => {
    const svc = service();
    await svc.from("lead_analysis_runs").delete().eq("hubspot_inbox_id", INBOX);
    await svc.from("lead_dialogue_analyses").delete().in("hubspot_thread_id", THREADS);
    await svc.from("lead_threads").delete().in("hubspot_thread_id", THREADS);
    await svc.from("lead_sellers").delete().eq("hubspot_actor_id", SELLER);
    await svc.from("lead_inboxes").delete().eq("hubspot_inbox_id", INBOX);
    await cleanup();
  });

  it("saves facts and reads them back as history, without duplicates on a second save", async () => {
    const store = leadStore(admin.client);
    const inbox = { id: INBOX, name: "Test – live inkorg" };
    await store.saveFacts({ inbox, sellers: [{ id: SELLER, name: "Live Säljare" }], rows: [row(THREADS[0]), row(THREADS[1], { status: "no_registered_reply", firstResponseAt: null, calendarMinutes: null, businessMinutes: null, responderId: null })], factsVersion: 1 });
    // The same period fetched again; the seller's name is unknown this time and must not be erased.
    await store.saveFacts({ inbox, sellers: [{ id: SELLER, name: null }], rows: [row(THREADS[0], { businessMinutes: 45 }), row(THREADS[1], { status: "no_registered_reply", firstResponseAt: null, calendarMinutes: null, businessMinutes: null, responderId: null })], factsVersion: 1 });

    const svc = service();
    const threads = await svc.from("lead_threads").select("hubspot_thread_id, business_minutes").in("hubspot_thread_id", THREADS).order("hubspot_thread_id");
    expect(threads.data).toEqual([
      { hubspot_thread_id: THREADS[0], business_minutes: 45 },
      { hubspot_thread_id: THREADS[1], business_minutes: null },
    ]);
    const seller = await svc.from("lead_sellers").select("display_name").eq("hubspot_actor_id", SELLER).single();
    expect(seller.data?.display_name).toBe("Live Säljare");

    const history = await store.history(INBOX, new Date("2026-10-01T00:00:00Z"));
    expect(history.months).toEqual([{ month: "2026-09", leads: 2, registeredReply: 1, medianBusinessMinutes: 45, medianCalendarMinutes: 60 }]);
  });

  it("stores an analysis once per thread, version and model, and replaces it when the source changes", async () => {
    const store = leadStore(admin.client);
    await store.saveAnalyses([{ threadId: THREADS[0], fingerprint: "a".repeat(64), sellerId: SELLER, classification }], "lead-ai-2", "gpt-6-luna");
    let loaded = await store.loadAnalyses(THREADS, "lead-ai-2", "gpt-6-luna");
    expect(loaded.get(THREADS[0])).toEqual({ fingerprint: "a".repeat(64), classification });

    // A changed dialogue: same key, new fingerprint – replaced, not duplicated.
    await store.saveAnalyses([{ threadId: THREADS[0], fingerprint: "b".repeat(64), sellerId: SELLER, classification }], "lead-ai-2", "gpt-6-luna");
    // Another analysis version: kept apart.
    await store.saveAnalyses([{ threadId: THREADS[0], fingerprint: "b".repeat(64), sellerId: SELLER, classification }], "lead-ai-3", "gpt-6-luna");
    const rows = await service().from("lead_dialogue_analyses").select("analysis_version, source_fingerprint").eq("hubspot_thread_id", THREADS[0]).order("analysis_version");
    expect(rows.data).toEqual([
      { analysis_version: "lead-ai-2", source_fingerprint: "b".repeat(64) },
      { analysis_version: "lead-ai-3", source_fingerprint: "b".repeat(64) },
    ]);
    loaded = await store.loadAnalyses(THREADS, "lead-ai-2", "gpt-6-luna");
    expect(loaded.get(THREADS[0])?.fingerprint).toBe("b".repeat(64));
    expect((await store.loadAnalyses(THREADS, "lead-ai-2", "another-model")).size).toBe(0);
  });

  it("records runs in the administrator's name and lists them", async () => {
    const store = leadStore(admin.client);
    await store.saveRun({
      inboxId: INBOX,
      from: "2026-09-01",
      to: "2026-09-30",
      analysisVersion: "lead-ai-2",
      model: "gpt-6-luna",
      factsVersion: 1,
      startedAt: new Date().toISOString(),
      leads: 2,
      dialoguesAnalysed: 1,
      analysedNew: 1,
      reused: 0,
      notAnalysed: [{ reason: "no_registered_reply", count: 1 }],
      costUsd: 0.000123,
      facts: { facts: {}, sellers: [{ id: SELLER }] },
      counts: {},
      summary: { strengths: [], improvements: [`{{${SELLER}}} kan föreslå provkörning`], soldCars: "", sellerPatterns: [], caveats: [] },
    });
    const run = await service().from("lead_analysis_runs").select("created_by, cost_usd").eq("hubspot_inbox_id", INBOX).single();
    expect(run.data?.created_by).toBe(admin.id);
    expect(Number(run.data?.cost_usd)).toBeCloseTo(0.000123, 6);
    const history = await store.history(INBOX);
    expect(history.runs).toEqual([expect.objectContaining({ dialoguesAnalysed: 1, analysedNew: 1, analysisVersion: "lead-ai-2" })]);
  });

  it("other roles can neither read nor write the analysis data", async () => {
    for (const table of ["lead_inboxes", "lead_sellers", "lead_threads", "lead_dialogue_analyses", "lead_analysis_runs"]) {
      const { data } = await employee.client.from(table).select("*").limit(5);
      expect(data ?? [], table).toEqual([]);
    }
    const store = leadStore(employee.client);
    await expect(store.saveFacts({ inbox: { id: INBOX, name: "Kapad" }, sellers: [], rows: [], factsVersion: 1 })).rejects.toThrow();
    // A system administrator cannot delete history either.
    await admin.client.from("lead_threads").delete().eq("hubspot_thread_id", THREADS[0]);
    const still = await service().from("lead_threads").select("hubspot_thread_id").eq("hubspot_thread_id", THREADS[0]);
    expect(still.data).toHaveLength(1);
  });
});
