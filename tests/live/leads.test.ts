/**
 * LIVE tests of the persistent lead analysis and its access model (ADR-047,
 * ADR-048) against the DEVELOPMENT Supabase project: the real store
 * (src/server/data/leads.ts) through PostgREST with signed-in synthetic
 * users. Synthetic regions, inboxes and ids only (never real HubSpot ids);
 * everything is removed afterwards. No calls to HubSpot or OpenAI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";
import { leadStore, listLeadInboxes, listLeadRows, myLeadAccess } from "@/server/data/leads";
import type { RawClassification } from "@/server/leads/analysis";

import { cleanup, createGroup, createUser, isDevelopmentProject, service, type LiveUser } from "./helpers";

const SEED = String(Date.now()).slice(-8);
const INBOX_A = `991${SEED}`;
const INBOX_B = `992${SEED}`;
const THREAD_A = `9931${SEED}`;
const THREAD_B = `9932${SEED}`;
const SELLER = `A-99${SEED}`;
const FROM = new Date("2026-09-01T00:00:00Z");
const TO = new Date("2026-10-01T00:00:00Z");

function row(threadId: string, inboxId: string, partial: Partial<LeadRow> = {}): LeadRow {
  return {
    threadId,
    inboxId,
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
    latestMessageAt: "2026-09-02T09:00:00.000Z",
    lastCustomerMessageAt: "2026-09-02T08:00:00.000Z",
    firstSellerAfterCustomerAt: "2026-09-02T09:00:00.000Z",
    followedUp: false,
    vehicleBrand: "Volkswagen",
    vehicleModel: "ID.4",
    vehicleSource: "fields",
    regnrKind: "virtual",
    ...partial,
  };
}

const classification: RawClassification = {
  intent: "availability",
  purchaseIntent: "clear",
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
  assessment: {
    goal: "Vill provköra bilen.",
    questions: [{ text: "Finns bilen kvar?", answered: "yes" }],
    signals: ["vill komma och titta"],
    timeframe: "",
    budget: "",
    objections: [],
    infoNeeded: [],
    progress: "partly",
    progressReason: "Frågan besvarades men inget besök föreslogs.",
    missedOpportunity: "yes",
    missedReason: "Kunden ville komma och titta men fick ingen tid.",
  },
};

describe.skipIf(!isDevelopmentProject)("lead analysis store and access (live, development project)", () => {
  let admin: LiveUser;
  let regionUser: LiveUser;
  let allUser: LiveUser;
  let noAccess: LiveUser;
  let regionA: string;
  let regionB: string;

  beforeAll(async () => {
    const svc = service();
    admin = await createUser("leadadmin", { role: "system_admin" });
    regionUser = await createUser("leadregion");
    allUser = await createUser("leadalla");
    noAccess = await createUser("leadingen");
    const group = await createGroup("leadregion");
    await svc.from("group_members").insert({ group_id: group, user_id: regionUser.id, is_manager: false });
    const regions = await svc
      .from("lead_regions")
      .insert([
        { name: `Test – live A ${SEED}`, sort_order: 900 },
        { name: `Test – live B ${SEED}`, sort_order: 901 },
      ])
      .select("id, sort_order");
    expect(regions.error).toBeNull();
    const sorted = [...regions.data!].sort((a, b) => a.sort_order - b.sort_order);
    regionA = sorted[0].id;
    regionB = sorted[1].id;
    // Configuration and grants are written by the system administrator's own session (RLS).
    const inboxes = await admin.client.from("lead_inboxes").insert([
      { hubspot_inbox_id: INBOX_A, name: "Test – live inkorg A", active: true, region_id: regionA },
      { hubspot_inbox_id: INBOX_B, name: "Test – live inkorg B", active: true, region_id: regionB },
    ]);
    expect(inboxes.error).toBeNull();
    const grants = await admin.client.from("lead_access_grants").insert([
      { group_id: group, region_id: regionA },
      { user_id: allUser.id, region_id: null },
    ]);
    expect(grants.error).toBeNull();
  });

  afterAll(async () => {
    const svc = service();
    await svc.from("lead_analysis_runs").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_analysis_runs").delete().in("region_id", [regionA, regionB]);
    await svc.from("lead_dialogue_analyses").delete().in("hubspot_thread_id", [THREAD_A, THREAD_B]);
    await svc.from("lead_threads").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_syncs").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_access_grants").delete().in("region_id", [regionA, regionB]);
    await svc.from("lead_access_grants").delete().eq("user_id", allUser.id);
    await svc.from("lead_inboxes").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_regions").delete().in("id", [regionA, regionB]);
    await svc.from("lead_sellers").delete().eq("hubspot_actor_id", SELLER);
    await cleanup();
  });

  it("reports each user's access from the database", async () => {
    expect(await myLeadAccess(admin.client)).toMatchObject({ hasAccess: true, isAdmin: true, allRegions: true });
    expect(await myLeadAccess(regionUser.client)).toEqual({ hasAccess: true, isAdmin: false, allRegions: false, regionIds: [regionA] });
    expect(await myLeadAccess(allUser.client)).toMatchObject({ hasAccess: true, allRegions: true });
    expect(await myLeadAccess(noAccess.client)).toMatchObject({ hasAccess: false });
  });

  it("a region-limited user refreshes and reads only their region", async () => {
    const store = leadStore(regionUser.client);
    await store.saveFacts({ sellers: [{ id: SELLER, name: "Live Säljare" }], rows: [row(THREAD_A, INBOX_A)], factsVersion: 2 });
    await store.recordSync({ inboxId: INBOX_A, from: "2026-09-01", to: "2026-09-30", leads: 1, complete: true });
    // Another region: refused by RLS.
    await expect(store.saveFacts({ sellers: [], rows: [row(THREAD_B, INBOX_B)], factsVersion: 2 })).rejects.toThrow();
    await expect(store.recordSync({ inboxId: INBOX_B, from: "2026-09-01", to: "2026-09-30", leads: 0, complete: true })).rejects.toThrow();
    // The administrator stores region B's lead.
    await leadStore(admin.client).saveFacts({ sellers: [], rows: [row(THREAD_B, INBOX_B)], factsVersion: 2 });

    const visible = (await listLeadInboxes(regionUser.client)).map((i) => i.id);
    expect(visible).toContain(INBOX_A);
    expect(visible).not.toContain(INBOX_B);
    const rows = await listLeadRows([INBOX_A, INBOX_B], FROM, TO, regionUser.client);
    expect(rows.map((r) => r.threadId)).toEqual([THREAD_A]);
    expect(rows[0]).toMatchObject({ vehicleBrand: "Volkswagen", vehicleModel: "ID.4", regnrKind: "virtual", lastCustomerMessageAt: "2026-09-02T08:00:00.000Z" });
  });

  it("all-region and no-access users see accordingly", async () => {
    const all = await listLeadRows([INBOX_A, INBOX_B], FROM, TO, allUser.client);
    expect(all.map((r) => r.threadId).sort()).toEqual([THREAD_A, THREAD_B].sort());
    expect(await listLeadRows([INBOX_A, INBOX_B], FROM, TO, noAccess.client)).toEqual([]);
    for (const table of ["lead_regions", "lead_inboxes", "lead_threads", "lead_dialogue_analyses", "lead_analysis_runs", "lead_syncs", "lead_settings", "lead_access_grants"]) {
      const { data } = await noAccess.client.from(table).select("*").limit(5);
      expect(data ?? [], table).toEqual([]);
    }
  });

  it("stores analyses once per thread and method, with the basis for reuse, and runs per scope", async () => {
    const store = leadStore(regionUser.client);
    const analysis = { threadId: THREAD_A, fingerprint: "a".repeat(64), sellerId: SELLER, sourceLatestMessageAt: "2026-09-02T09:00:00.000Z", situationState: "waiting", classification };
    await store.saveAnalyses([analysis], "lead-ai-3", "gpt-6-luna");
    await store.saveAnalyses([{ ...analysis, fingerprint: "b".repeat(64) }], "lead-ai-3", "gpt-6-luna");
    const loaded = await store.loadAnalyses([THREAD_A, THREAD_B], "lead-ai-3", "gpt-6-luna");
    expect(loaded.size).toBe(1);
    expect(loaded.get(THREAD_A)).toMatchObject({ fingerprint: "b".repeat(64), sourceLatestMessageAt: "2026-09-02T09:00:00.000Z", situationState: "waiting", classification });
    // Region B's analysis cannot be written by the region-limited user.
    await expect(store.saveAnalyses([{ ...analysis, threadId: THREAD_B }], "lead-ai-3", "gpt-6-luna")).rejects.toThrow();

    const base = { from: "2026-09-01", to: "2026-09-30", analysisVersion: "lead-ai-3", model: "gpt-6-luna", factsVersion: 2, startedAt: new Date().toISOString(), leads: 1, dialoguesAnalysed: 1, analysedNew: 1, reused: 0, notAnalysed: [], costUsd: 0.0001, facts: {}, counts: {}, summary: null };
    expect(await store.saveRun({ ...base, scopeType: "inbox", inboxId: INBOX_A, regionId: null })).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.saveRun({ ...base, scopeType: "region", inboxId: null, regionId: regionA })).toMatch(/^[0-9a-f-]{36}$/);
    await expect(store.saveRun({ ...base, scopeType: "region", inboxId: null, regionId: regionB })).rejects.toThrow();
    await expect(store.saveRun({ ...base, scopeType: "all", inboxId: null, regionId: null })).rejects.toThrow();
  });

  it("explicitly: a region-A user cannot read region B's lead, analysis or sync through the API (20261013090000)", async () => {
    const admin_ = leadStore(admin.client);
    await admin_.saveAnalyses(
      [{ threadId: THREAD_B, fingerprint: "c".repeat(64), sellerId: SELLER, sourceLatestMessageAt: null, situationState: "none", classification }],
      "lead-ai-live",
      "gpt-6-luna",
    );
    await admin_.recordSync({ inboxId: INBOX_B, from: "2026-09-01", to: "2026-09-30", leads: 1, complete: true });
    const c = regionUser.client;
    expect((await c.from("lead_threads").select("hubspot_thread_id").eq("hubspot_thread_id", THREAD_B)).data).toEqual([]);
    expect((await c.from("lead_dialogue_analyses").select("hubspot_thread_id").eq("hubspot_thread_id", THREAD_B)).data).toEqual([]);
    expect((await c.from("lead_syncs").select("hubspot_inbox_id").eq("hubspot_inbox_id", INBOX_B)).data).toEqual([]);
    // Embedded through a readable table does not help either.
    expect((await c.from("lead_dialogue_analyses").select("hubspot_thread_id, lead_threads!inner(hubspot_inbox_id)").eq("lead_threads.hubspot_inbox_id", INBOX_B)).data ?? []).toEqual([]);
    // The administrator does see them (the rows exist).
    expect((await admin.client.from("lead_dialogue_analyses").select("hubspot_thread_id").eq("hubspot_thread_id", THREAD_B)).data).toHaveLength(1);
    // The helper functions are not reachable through the API: the app schema is not exposed.
    const rpc = await c.schema("app").rpc("readable_lead_inboxes");
    expect(rpc.error).not.toBeNull();
    expect(rpc.data).toBeNull();
    const rpcPublic = await c.rpc("readable_lead_inboxes" as never);
    expect(rpcPublic.error).not.toBeNull();
  });

  it("configuration and grants are for system administrators only, and history cannot be deleted", async () => {
    const update = await regionUser.client.from("lead_inboxes").update({ active: false }).eq("hubspot_inbox_id", INBOX_A).select("hubspot_inbox_id");
    expect(update.data ?? []).toEqual([]);
    const grant = await regionUser.client.from("lead_access_grants").insert({ user_id: regionUser.id, region_id: null });
    expect(grant.error).not.toBeNull();
    const region = await allUser.client.from("lead_regions").insert({ name: `Kapad ${SEED}` });
    expect(region.error).not.toBeNull();
    await admin.client.from("lead_threads").delete().eq("hubspot_thread_id", THREAD_A);
    const still = await service().from("lead_threads").select("hubspot_thread_id").eq("hubspot_thread_id", THREAD_A);
    expect(still.data).toHaveLength(1);
  });
});
