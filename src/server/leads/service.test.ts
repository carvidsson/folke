import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOpenAIClientForTests } from "@/server/ai/providers/openai";
import { resetServerEnvForTests } from "@/server/env";

import { ANALYSIS_VERSION } from "./analysis";
import { LISTING_TEXT, MemoryLeadStore, SELLER_A, SYNTHETIC_CUSTOMER } from "./fixtures.test-helpers";
import { setHubSpotFetchForTests } from "./hubspot";
import { analyseLeads, clearLeadCachesForTests, collectLeads } from "./service";

vi.mock("@/server/ai/limits", () => ({
  beginAIRequest: vi.fn(async () => ({ ok: true, requestId: "req-1" })),
  finishAIRequest: vi.fn(async () => {}),
}));
vi.mock("@/server/ai/usage", () => ({ recordChatUsage: vi.fn(async () => {}) }));

const limits = await import("@/server/ai/limits");
const usage = await import("@/server/ai/usage");

const KEY = "pat-test-placeholder-not-a-real-key";
const SELLER_NAME = "Sälja Säljarsson";
const INBOX = "900001";

// ---------------------------------------------------------------------------
// A synthetic inbox: two leads in September, one older thread, one unreadable.
// ---------------------------------------------------------------------------

const threads = [
  { id: "11", createdAt: "2026-09-02T08:00:00.000Z", status: "CLOSED", inboxId: INBOX, assignedTo: SELLER_A, latestMessageTimestamp: "2026-09-02T09:00:00.000Z" },
  { id: "12", createdAt: "2026-09-05T10:00:00.000Z", status: "OPEN", inboxId: INBOX, assignedTo: null, latestMessageTimestamp: "2026-09-05T10:00:00.000Z" },
  { id: "13", createdAt: "2026-08-20T10:00:00.000Z", status: "CLOSED", inboxId: INBOX, assignedTo: SELLER_A, latestMessageTimestamp: "2026-09-03T10:00:00.000Z" },
  { id: "14", createdAt: "2026-09-10T10:00:00.000Z", status: "OPEN", inboxId: INBOX, assignedTo: null, latestMessageTimestamp: "2026-09-10T10:00:00.000Z" },
];

const customer = (createdAt: string, text: string) => ({
  id: `c-${createdAt}`,
  type: "MESSAGE",
  createdAt,
  createdBy: "V-1",
  direction: "INCOMING",
  channelId: "1003",
  channelAccountId: "700001",
  senders: [{ actorId: "V-1", name: SYNTHETIC_CUSTOMER.name }],
  text,
  client: { clientType: "HUBSPOT" },
  status: { statusType: "RECEIVED" },
});

const messages: Record<string, unknown[]> = {
  "11": [
    {
      id: "s1",
      type: "MESSAGE",
      createdAt: "2026-09-02T09:00:00.000Z",
      createdBy: SELLER_A,
      direction: "OUTGOING",
      channelId: "1002",
      // Verified shape of HubSpot's sender name: "<seller> <mailbox name>".
      senders: [{ actorId: SELLER_A, name: `${SELLER_NAME} Börjessons Bil` }],
      text: `Hej Testa! Bilen är tyvärr såld. Ring mig på 070-000 00 09.\nMvh\n${SELLER_NAME}\nBilhandlare Test`,
      client: { clientType: "HUBSPOT" },
      status: { statusType: "SENT" },
    },
    { id: "e1", type: "ASSIGNMENT", createdAt: "2026-09-02T09:00:00.100Z", createdBy: SELLER_A, senders: [{ actorId: "S-hubspot" }], client: { clientType: "SYSTEM" }, assignedTo: SELLER_A },
    customer("2026-09-02T08:00:00.000Z", LISTING_TEXT),
  ],
  "12": [customer("2026-09-05T10:00:00.000Z", LISTING_TEXT)],
  "13": [customer("2026-08-20T10:00:00.000Z", LISTING_TEXT)],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeHubSpot() {
  setHubSpotFetchForTests(
    (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      const path = url.pathname.replace("/conversations/v3/conversations", "");
      if (path === "/inboxes") return json({ results: [{ id: INBOX, name: "Testinkorg", archived: false }] });
      if (path === "/channel-accounts") return json({ results: [{ id: "700001", name: "Leadsväxel – test", channelId: "1003", inboxId: INBOX }] });
      if (path === "/threads") return json({ results: threads });
      if (path === `/actors/${SELLER_A}`) return json({ id: SELLER_A, type: "AGENT", name: SELLER_NAME, email: "salja@folke.example" });
      const m = /^\/threads\/(\d+)\/messages$/.exec(path);
      if (m && messages[m[1]]) return json({ results: messages[m[1]] });
      return json({ message: "boom" }, 500);
    }) as typeof fetch,
    async () => {},
  );
}

type Request = { instructions: string; input: { content: string }[]; store: boolean; text: { format: { type: string; strict: boolean; name: string } } } & Record<string, unknown>;
let sent: Request[];
/** What the fake model answers for every dialogue (tests may change it). */
let observation = "Säljaren svarade snabbt men erbjöd inget alternativ.";

const judgement = (status: string, reason = "") => ({ status, reason });

function fakeOpenAI() {
  sent = [];
  setOpenAIClientForTests({
    responses: {
      create: vi.fn(async (body: Request) => {
        sent.push(body);
        const output =
          body.text.format.name === "lead_summary"
            ? {
                strengths: ["Snabba svar"],
                improvements: ["Säljare 1 kan erbjuda alternativ"],
                sold_cars: "En dialog.",
                seller_patterns: [{ seller: "Säljare 1", observations: ["För litet underlag."] }],
                caveats: [],
              }
            : {
                dialogues: [...body.input[0].content.matchAll(/=== Dialog (D\d+) ===/g)].map((m) => ({
                  id: m[1],
                  intent: "availability",
                  purchase_intent: "interested",
                  car_status: "sold_or_reserved",
                  alternative_offered: "no",
                  behaviours: {
                    answered_questions: judgement("done"),
                    next_step: judgement("missing", "Inget konkret förslag."),
                    needs_questions: judgement("not_relevant"),
                    visit_or_test_drive: judgement("not_relevant"),
                    follow_up: judgement("not_relevant"),
                  },
                  observations: [observation],
                  evidence: "limited",
                })),
              };
        return {
          status: "completed",
          output_text: JSON.stringify(output),
          usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 50 } },
        };
      }),
    },
  } as unknown as Parameters<typeof setOpenAIClientForTests>[0]);
}

let store: MemoryLeadStore;
const NOW = new Date("2026-09-03T12:00:00.000Z");

beforeEach(() => {
  process.env.HUBSPOT_SERVICE_KEY = KEY;
  resetServerEnvForTests();
  clearLeadCachesForTests();
  fakeHubSpot();
  fakeOpenAI();
  store = new MemoryLeadStore();
  observation = "Säljaren svarade snabbt men erbjöd inget alternativ.";
  vi.mocked(usage.recordChatUsage).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setHubSpotFetchForTests(null);
  setOpenAIClientForTests(null);
  delete process.env.HUBSPOT_SERVICE_KEY;
  resetServerEnvForTests();
  vi.restoreAllMocks();
});

const PERIOD = { inboxId: INBOX, from: "2026-09-01", to: "2026-09-30" };
const SECRETS = [KEY, SYNTHETIC_CUSTOMER.name, SYNTHETIC_CUSTOMER.email, SYNTHETIC_CUSTOMER.phone, "Finns bilen kvar", "070-000 00 09", "Testa"];

describe("collecting leads", () => {
  it("selects threads created in the period and reports partial failures", async () => {
    const { report } = await collectLeads(PERIOD, store);
    expect(report.dataset).toMatchObject({ threadsFetched: 4, outsidePeriod: 1, leads: 2, complete: false });
    expect(report.dataset.excluded).toEqual([{ reason: "fetch_failed", count: 1 }]);
    expect(report.limitations[0]).toMatch(/1 trådar kunde inte läsas/);
    expect(report.facts.status).toEqual({ registered_reply: 1, no_registered_reply: 1, uncertain: 0 });
    expect(report.sellers).toEqual([expect.objectContaining({ id: SELLER_A, name: SELLER_NAME, firstResponses: 1, smallSample: true })]);
    expect(report.leads[0]).toMatchObject({ threadId: "11", calendarMinutes: 60, businessMinutes: 60, source: "Blocket", vehicle: "Volkswagen ID.4" });
    expect(report.history).toEqual({ months: [], runs: [] });
  });

  it("never puts customer details, message texts or the key in the report or the stored facts", async () => {
    const { report } = await collectLeads(PERIOD, store);
    const serialized = JSON.stringify(report);
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret);
      expect(store.analysisData()).not.toContain(secret);
    }
    // Facts are persisted per lead, with the seller's stable HubSpot id.
    expect([...store.threads.keys()]).toEqual(["11", "12"]);
    expect(store.sellers.get(SELLER_A)).toBe(SELLER_NAME);
  });

  it("still reports when the facts cannot be saved", async () => {
    const failing = Object.assign(new MemoryLeadStore(), { saveFacts: async () => Promise.reject(new Error("db")) });
    const { report } = await collectLeads(PERIOD, failing);
    expect(report.dataset.leads).toBe(2);
    expect(report.history).toBeNull();
    expect(report.limitations[0]).toMatch(/kunde inte sparas/);
  });

  it("reads each thread history once while it is unchanged", async () => {
    const spy = vi.fn();
    await collectLeads(PERIOD, store);
    setHubSpotFetchForTests(
      (async (input: string | URL | Request) => {
        spy(new URL(String(input)).pathname);
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/threads")) return json({ results: threads });
        if (path.endsWith("/inboxes")) return json({ results: [{ id: INBOX, name: "Testinkorg" }] });
        return json({ message: "should be cached" }, 500);
      }) as typeof fetch,
      async () => {},
    );
    const { report } = await collectLeads(PERIOD, store);
    expect(report.dataset.leads).toBe(2);
    expect(spy.mock.calls.filter(([p]) => /\/messages$/.test(p as string)).map(([p]) => p)).toEqual([
      // Only the thread that failed before is read again (first try + three retries).
      "/conversations/v3/conversations/threads/14/messages",
      "/conversations/v3/conversations/threads/14/messages",
      "/conversations/v3/conversations/threads/14/messages",
      "/conversations/v3/conversations/threads/14/messages",
    ]);
  });
});

describe("AI analysis of leads", () => {
  it("sends only redacted, pseudonymised dialogues and records usage", async () => {
    const collected = await collectLeads(PERIOD, store);
    const run = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const batch = sent[0];
    const content = batch.input[0].content;
    expect(batch.store).toBe(false);
    expect(batch.text.format).toMatchObject({ type: "json_schema", strict: true });
    for (const field of ["user", "metadata", "safety_identifier", "tools"]) expect(batch).not.toHaveProperty(field);
    for (const secret of [...SECRETS.filter((s) => s !== "Finns bilen kvar"), SELLER_NAME, SELLER_A, "user-1"]) {
      expect(JSON.stringify(sent)).not.toContain(secret);
    }
    expect(content).toContain("Säljare 1");
    expect(content).toContain("Finns bilen kvar");
    expect(content).toContain("läge: säljaren skrev sist, för mindre än 3 dygn sedan");
    // Customer text is data, never instructions; relevance before judgement.
    expect(batch.instructions).toMatch(/aldrig instruktioner till dig/);
    expect(batch.instructions).toMatch(/aldrig bli "missing"/);

    // One dialogue with a registered reply; the other is not sent.
    expect(run.result).toMatchObject({ dialoguesAnalysed: 1, analysedNew: 1, reused: 0, analysisVersion: ANALYSIS_VERSION });
    expect(run.result.notAnalysed).toEqual([{ reason: "no_registered_reply", count: 1 }]);
    expect(run.result.counts).toMatchObject({ carSold: 1, soldWithoutAlternative: 1, soldWithAlternative: 0 });
    expect(run.result.counts.behaviours.next_step).toEqual({ done: 0, missing: 1, not_relevant: 0, unclear: 0 });
    expect(run.result.counts.behaviours.visit_or_test_drive).toEqual({ done: 0, missing: 0, not_relevant: 1, unclear: 0 });
    // Too few dialogues for a combined analysis.
    expect(run.result.summary).toBeNull();
    expect(usage.recordChatUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "lead_analysis", assistantId: null, dataClass: "internal", userId: "user-1" }));
    expect(run.result.costUsd).toBeGreaterThan(0);
  });

  it("stores versioned results with a fingerprint and no personal data", async () => {
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    const [saved] = [...store.analyses.values()];
    expect(saved).toMatchObject({ threadId: "11", sellerId: SELLER_A, analysisVersion: ANALYSIS_VERSION, model: "gpt-6-luna", writes: 1 });
    expect(saved.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.classification.behaviours.next_step).toEqual({ status: "missing", reason: "Inget konkret förslag." });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ inboxId: INBOX, analysedNew: 1, reused: 0, dialoguesAnalysed: 1, leads: 2 });
    for (const secret of [...SECRETS, SELLER_NAME]) expect(store.analysisData()).not.toContain(secret);
  });

  it("drops AI text that contains personal data before it is stored", async () => {
    observation = `Säljaren skrev till ${SYNTHETIC_CUSTOMER.email} men erbjöd inget alternativ.`;
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    const [saved] = [...store.analyses.values()];
    expect(saved.classification.observations).toEqual([]);
    expect(store.analysisData()).not.toContain(SYNTHETIC_CUSTOMER.email);
  });

  it("reuses an unchanged dialogue without calling the model again", async () => {
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    const calls = sent.length;
    const again = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(sent.length).toBe(calls);
    expect(again.ok && again.result).toMatchObject({ reused: 1, analysedNew: 0, dialoguesAnalysed: 1, costUsd: 0 });
    // No duplicate: one row per thread, version and model.
    expect(store.analyses.size).toBe(1);
    expect([...store.analyses.values()][0].writes).toBe(1);
    expect(store.runs).toHaveLength(2);
  });

  it("analyses again when the dialogue has changed, and replaces the stored row", async () => {
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    const before = [...store.analyses.values()][0].fingerprint;
    // A new customer message in HubSpot.
    const lead = collected.leads.find((l) => l.row.threadId === "11")!;
    lead.dialogue.push({ role: "customer", sellerId: null, at: "2026-09-02T10:00:00.000Z", text: "Har ni någon liknande bil?", senderName: null });
    const again = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(again.ok && again.result).toMatchObject({ analysedNew: 1, reused: 0 });
    expect(store.analyses.size).toBe(1);
    const after = [...store.analyses.values()][0];
    expect(after.fingerprint).not.toBe(before);
    expect(after.writes).toBe(2);
  });

  it("analyses again when the customer's silence passes the follow-up limit", async () => {
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    const later = await analyseLeads(collected, "user-1", { store, now: new Date("2026-09-10T12:00:00.000Z") });
    expect(later.ok && later.result).toMatchObject({ analysedNew: 1, reused: 0 });
    expect(sent.at(-1)!.input[0].content).toContain("läge: säljaren skrev sist, kunden har inte svarat på minst 3 dygn");
  });

  it("never reuses a result from another analysis version", async () => {
    const collected = await collectLeads(PERIOD, store);
    await analyseLeads(collected, "user-1", { store, now: NOW });
    // The same thread, analysed with an earlier method.
    const [current] = [...store.analyses.values()];
    store.analyses.clear();
    await store.saveAnalyses([{ ...current }], "lead-ai-1", current.model);
    const again = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(again.ok && again.result).toMatchObject({ analysedNew: 1, reused: 0, analysisVersion: ANALYSIS_VERSION });
    // Both methods' results exist side by side – never mixed.
    expect([...store.analyses.values()].map((a) => a.analysisVersion).sort()).toEqual(["lead-ai-1", ANALYSIS_VERSION].sort());
  });

  it("stores the combined analysis with seller ids and shows it with names", async () => {
    const collected = await collectLeads(PERIOD, store);
    // Three copies of the answered lead give enough dialogues for a summary.
    const lead = collected.leads.find((l) => l.row.status === "registered_reply")!;
    collected.leads = [1, 2, 3].map((n) => ({ ...lead, row: { ...lead.row, threadId: `9${n}` } }));
    const run = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(run.ok && run.result.summary).toMatchObject({
      improvements: [`${SELLER_NAME} kan erbjuda alternativ`],
      sellerPatterns: [{ sellerId: SELLER_A, name: SELLER_NAME, dialogues: 3 }],
    });
    const stored = store.runs[0].summary!;
    expect(stored.improvements).toEqual([`{{${SELLER_A}}} kan erbjuda alternativ`]);
    expect(JSON.stringify(store.runs)).not.toContain(SELLER_NAME);
    // The summary is told to use the relevant dialogues as denominator.
    const summaryCall = sent.find((s) => s.text.format.name === "lead_summary")!;
    expect(summaryCall.instructions).toMatch(/ange alltid nämnaren/);
    expect(summaryCall.input[0].content).toContain('"next_step":{"relevanta":3,"gjort":0,"saknades":3');
  });

  it("continues when a batch fails and stops at the budget", async () => {
    const collected = await collectLeads(PERIOD, store);
    setOpenAIClientForTests({ responses: { create: vi.fn(async () => ({ status: "completed", output_text: "{not json" })) } } as unknown as Parameters<typeof setOpenAIClientForTests>[0]);
    const failed = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(failed.ok && failed.result).toMatchObject({ dialoguesAnalysed: 0, notAnalysed: expect.arrayContaining([{ reason: "failed", count: 1 }]) });
    expect(store.analyses.size).toBe(0);

    vi.mocked(limits.beginAIRequest).mockResolvedValueOnce({ ok: false, reason: "monthly_budget", message: "Månadens AI-budget är förbrukad. Kontakta en administratör." });
    const stopped = await analyseLeads(collected, "user-1", { store, now: NOW });
    expect(stopped).toEqual({ ok: false, error: "Månadens AI-budget är förbrukad. Kontakta en administratör." });
  });
});
