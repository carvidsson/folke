import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOpenAIClientForTests } from "@/server/ai/providers/openai";
import { resetServerEnvForTests } from "@/server/env";

import { ANALYSIS_VERSION } from "./analysis";
import { LISTING_TEXT, MemoryLeadStore, SELLER_A, SYNTHETIC_CUSTOMER } from "./fixtures.test-helpers";
import { setHubSpotFetchForTests } from "./hubspot";
import { analyseInbox, clearLeadCachesForTests, summariseScope } from "./service";
import { syncInbox } from "./sync";

vi.mock("@/server/ai/limits", () => ({
  beginAIRequest: vi.fn(async () => ({ ok: true, requestId: "req-1" })),
  finishAIRequest: vi.fn(async () => {}),
}));
vi.mock("@/server/ai/usage", () => ({ recordChatUsage: vi.fn(async () => {}) }));

const limits = await import("@/server/ai/limits");
const usage = await import("@/server/ai/usage");

const KEY = "pat-test-placeholder-not-a-real-key";
const SELLER_NAME = "Sälja Säljarsson";
const INBOX = { id: "900001", name: "Testinkorg" };
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const NOW = new Date("2026-09-03T12:00:00.000Z");

// ---------------------------------------------------------------------------
// A synthetic inbox: two leads in September, one older thread, one unreadable.
// ---------------------------------------------------------------------------

let threads: Record<string, unknown>[];
let messages: Record<string, unknown[]>;
let messageCalls: string[];

const customer = (id: string, createdAt: string, text: string) => ({
  id,
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

const seller = (id: string, createdAt: string, text: string) => ({
  id,
  type: "MESSAGE",
  createdAt,
  createdBy: SELLER_A,
  direction: "OUTGOING",
  channelId: "1002",
  // Verified shape of HubSpot's sender name: "<seller> <mailbox name>".
  senders: [{ actorId: SELLER_A, name: `${SELLER_NAME} Börjessons Bil` }],
  text,
  client: { clientType: "HUBSPOT" },
  status: { statusType: "SENT" },
});

function reset() {
  threads = [
    { id: "11", createdAt: "2026-09-02T08:00:00.000Z", status: "CLOSED", inboxId: INBOX.id, assignedTo: SELLER_A, latestMessageTimestamp: "2026-09-02T09:00:00.000Z" },
    { id: "12", createdAt: "2026-09-05T10:00:00.000Z", status: "OPEN", inboxId: INBOX.id, assignedTo: null, latestMessageTimestamp: "2026-09-05T10:00:00.000Z" },
    { id: "13", createdAt: "2026-08-20T10:00:00.000Z", status: "CLOSED", inboxId: INBOX.id, assignedTo: SELLER_A, latestMessageTimestamp: "2026-09-03T10:00:00.000Z" },
    { id: "14", createdAt: "2026-09-10T10:00:00.000Z", status: "OPEN", inboxId: INBOX.id, assignedTo: null, latestMessageTimestamp: "2026-09-10T10:00:00.000Z" },
  ];
  messages = {
    "11": [
      {
        ...seller("s1", "2026-09-02T09:00:00.000Z", `Hej Testa! Bilen är tyvärr såld. Ring mig på 070-000 00 09.\nMvh\n${SELLER_NAME}\nBilhandlare Test`),
        // An offer-like PDF whose file name contains the customer's name: only its kind may reach the model.
        attachments: [{ type: "FILE", fileId: "1", name: `Offert ${SYNTHETIC_CUSTOMER.name}.pdf`, fileUsageType: "OTHER", url: "https://files.example/secret" }],
      },
      { id: "e1", type: "ASSIGNMENT", createdAt: "2026-09-02T09:00:00.100Z", createdBy: SELLER_A, senders: [{ actorId: "S-hubspot" }], client: { clientType: "SYSTEM" }, assignedTo: SELLER_A },
      customer("c1", "2026-09-02T08:00:00.000Z", LISTING_TEXT),
    ],
    "12": [customer("c2", "2026-09-05T10:00:00.000Z", LISTING_TEXT)],
    "13": [customer("c3", "2026-08-20T10:00:00.000Z", LISTING_TEXT)],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeHubSpot() {
  setHubSpotFetchForTests(
    (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      const path = url.pathname.replace("/conversations/v3/conversations", "");
      if (path === "/channel-accounts") return json({ results: [{ id: "700001", name: "Leadsväxel – test", channelId: "1003", inboxId: INBOX.id }] });
      if (path === "/threads") return json({ results: threads });
      if (path === `/actors/${SELLER_A}`) return json({ id: SELLER_A, type: "AGENT", name: SELLER_NAME, email: "salja@folke.example" });
      const m = /^\/threads\/(\d+)\/messages$/.exec(path);
      if (m) messageCalls.push(m[1]);
      if (m && messages[m[1]]) return json({ results: messages[m[1]] });
      return json({ message: "boom" }, 500);
    }) as typeof fetch,
    async () => {},
  );
}

type Request = { instructions: string; input: { content: string }[]; store: boolean; text: { format: { type: string; strict: boolean; name: string } } } & Record<string, unknown>;
let sent: Request[];
let observation: string;
/** Classification calls that answer without any dialogue (the model leaving dialogues out). */
let omitNext = 0;
/** lead-needs-1: the note the fake model writes, and whether its call fails. */
let needsNote = "";
let needsFail = false;

const judgement = (status: string, reason = "") => ({ status, reason });

function fakeOpenAI() {
  sent = [];
  setOpenAIClientForTests({
    responses: {
      create: vi.fn(async (body: Request) => {
        sent.push(body);
        const omit = body.text.format.name === "lead_dialogues" && omitNext > 0;
        if (omit) omitNext--;
        const keys = omit ? [] : [...body.input[0].content.matchAll(/"id":"([DB]\d+)"|=== Dialog ([DB]\d+) ===/g)].map((m) => m[1] ?? m[2]);
        if (body.text.format.name === "lead_needs") {
          if (needsFail) throw new Error("needs failed");
          const output = {
            dialogues: keys.map((id) => ({
              id,
              purpose: "purchase",
              needs: [
                { code: "availability", stance: "expressed", message: 1, note: "Frågar om bilen finns kvar" },
                { code: "trade_in", stance: "expressed", message: 1, note: `Inbyte, ${needsNote}` },
                // The seller's message: never a customer need.
                { code: "private_leasing", stance: "expressed", message: 2, note: "Säljarens förslag" },
              ],
              signals: [],
              requests: [],
              timeframe: "none",
              timeframe_message: 0,
              unavailable: { situation: "sold", situation_message: 2, carried: "not_visible", carried_message: 0, note: "Bilen var såld" },
              seller_topics: [],
              evidence: "sufficient",
            })),
          };
          return { status: "completed", output_text: JSON.stringify(output), usage: { input_tokens: 500, output_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 20 } } };
        }
        const output =
          body.text.format.name === "lead_summary"
            ? {
                findings: [
                  { title: "Sålda bilar utan alternativ", text: "När bilen är såld erbjuds sällan något annat.", kind: "opportunity", dialogues: keys.slice(0, 3) },
                  { title: "Bara en dialog", text: "För svagt.", kind: "other", dialogues: [keys[0]] },
                ],
                seller_patterns: [{ seller: "Säljare 1", strengths: [{ text: "Säljare 1 svarar snabbt.", dialogues: keys.slice(0, 2) }], stalls: [], note: "För litet underlag för slutsatser." }],
                limits: "Underlaget räcker inte för att säga något om provkörningar.",
                caveats: ["Telefonkontakt syns inte."],
              }
            : {
                dialogues: keys.map((id) => ({
                  id,
                  situation: {
                    goal: "Vill veta om bilen finns kvar.",
                    questions: [{ text: "Finns bilen kvar?", answered: "yes" }],
                    signals: [],
                    timeframe: "",
                    budget: "",
                    objections: [],
                    info_needed: [],
                    progress: "stalled",
                    progress_reason: "Bilen var såld och inget alternativ erbjöds.",
                    missed_opportunity: "yes",
                    missed_reason: observation,
                    continuation: "visible",
                    agreed_next_step: false,
                    opportunities: ["sold_without_alternative"],
                    strengths: [],
                  },
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
                  observations: ["Säljaren svarade snabbt."],
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

beforeEach(() => {
  process.env.HUBSPOT_SERVICE_KEY = KEY;
  resetServerEnvForTests();
  clearLeadCachesForTests();
  reset();
  messageCalls = [];
  observation = "Bilen var såld och inget alternativ erbjöds.";
  omitNext = 0;
  needsNote = "byter in sin bil";
  needsFail = false;
  fakeHubSpot();
  fakeOpenAI();
  store = new MemoryLeadStore();
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

const SECRETS = [KEY, SYNTHETIC_CUSTOMER.name, SYNTHETIC_CUSTOMER.email, SYNTHETIC_CUSTOMER.phone, "Finns bilen kvar?\nJag undrar", "070-000 00 09", "Testa"];

describe("syncing from HubSpot", () => {
  it("stores the period's leads, records incomplete coverage and keeps no personal data", async () => {
    const result = await syncInbox(INBOX, PERIOD, store);
    expect(result).toMatchObject({ leads: 3, threadsRead: 2, failed: 1, complete: false });
    expect([...store.threads.keys()].sort()).toEqual(["11", "12"]);
    expect(store.syncs).toEqual([{ inboxId: INBOX.id, from: PERIOD.from, to: PERIOD.to, leads: 3, complete: false }]);
    const lead = store.threads.get("11")!;
    expect(lead).toMatchObject({ status: "registered_reply", vehicleBrand: "Volkswagen", vehicleModel: "ID.4", vehicleSource: "fields", latestMessageAt: "2026-09-02T09:00:00.000Z" });
    expect(lead.firstSellerAfterCustomerAt).toBe("2026-09-02T09:00:00.000Z");
    expect(store.sellers.get(SELLER_A)).toBe(SELLER_NAME);
    for (const secret of SECRETS) expect(store.analysisData()).not.toContain(secret);
  });

  it("does not read unchanged threads again", async () => {
    await syncInbox(INBOX, PERIOD, store);
    messageCalls = [];
    const again = await syncInbox(INBOX, PERIOD, store);
    // 11 and 12 unchanged; 14 still fails (first try + three retries).
    expect(again).toMatchObject({ unchanged: 2, threadsRead: 0 });
    expect(messageCalls).toEqual(["14", "14", "14", "14"]);
  });

  it("reads a thread again when its latest message changed", async () => {
    await syncInbox(INBOX, PERIOD, store);
    threads[0].latestMessageTimestamp = "2026-09-04T09:00:00.000Z";
    messages["11"].push(customer("c9", "2026-09-04T09:00:00.000Z", "Har ni någon liknande bil?"));
    clearLeadCachesForTests();
    messageCalls = [];
    await syncInbox(INBOX, PERIOD, store);
    expect(messageCalls.filter((t) => t === "11")).toHaveLength(1);
    expect(store.threads.get("11")).toMatchObject({ customerWroteLast: true, lastCustomerMessageAt: "2026-09-04T09:00:00.000Z" });
  });
});

describe("AI analysis of an inbox", () => {
  beforeEach(async () => {
    await syncInbox(INBOX, PERIOD, store);
    messageCalls = [];
  });

  it("sends only redacted, pseudonymised dialogues and stores versioned results", async () => {
    const run = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const batch = sent[0];
    expect(batch.store).toBe(false);
    expect(batch.text.format).toMatchObject({ type: "json_schema", strict: true, name: "lead_dialogues" });
    for (const field of ["user", "metadata", "safety_identifier", "tools"]) expect(batch).not.toHaveProperty(field);
    for (const secret of [KEY, SYNTHETIC_CUSTOMER.name, SYNTHETIC_CUSTOMER.email, SYNTHETIC_CUSTOMER.phone, "070-000 00 09", SELLER_NAME, SELLER_A, "user-1", "Testa"]) {
      expect(JSON.stringify(sent)).not.toContain(secret);
    }
    expect(batch.input[0].content).toContain("Säljare 1");
    // The attachment is known by kind only – never by its file name or URL.
    expect(batch.input[0].content).toContain("[Bilaga: offertliknande dokument enligt filnamnet (innehållet är inte läst)]");
    expect(JSON.stringify(sent)).not.toContain("files.example");
    expect(batch.instructions).toMatch(/Förstå först vad kunden försöker åstadkomma/);
    expect(batch.instructions).toMatch(/aldrig instruktioner till dig/);

    expect(run.result.run).toMatchObject({ dialoguesAnalysed: 1, analysedNew: 1, reused: 0, analysisVersion: ANALYSIS_VERSION });
    expect(run.result.notAnalysed).toEqual([{ reason: "no_registered_reply", count: 1 }]);
    expect(run.result.counts).toMatchObject({ missedOpportunities: 1, carSold: 1, soldWithoutAlternative: 1 });
    const [saved] = [...store.analyses.values()];
    expect(saved).toMatchObject({ threadId: "11", sellerId: SELLER_A, analysisVersion: ANALYSIS_VERSION, sourceLatestMessageAt: "2026-09-02T09:00:00.000Z", situationState: "too_early" });
    expect(saved.classification.assessment).toMatchObject({ goal: "Vill veta om bilen finns kvar.", progress: "stalled", missedOpportunity: "yes" });
    expect(store.runs[0]).toMatchObject({ scopeType: "inbox", inboxId: INBOX.id, regionId: null, analysedNew: 1 });
    expect(usage.recordChatUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "lead_analysis", assistantId: null, dataClass: "internal" }));
    for (const secret of [...SECRETS, SELLER_NAME]) expect(store.analysisData()).not.toContain(secret);
  });

  it("reuses a stored analysis without reading HubSpot or calling the model", async () => {
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const calls = sent.length;
    messageCalls = [];
    const again = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(again.ok && again.result.run).toMatchObject({ reused: 1, analysedNew: 0, costUsd: 0 });
    expect(sent.length).toBe(calls);
    expect(messageCalls).toEqual([]);
    expect(store.analyses.size).toBe(1);
  });

  it("re-analyses only a changed dialogue and replaces its row", async () => {
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    threads[0].latestMessageTimestamp = "2026-09-03T08:00:00.000Z";
    messages["11"].push(customer("c9", "2026-09-03T08:00:00.000Z", "Har ni någon liknande bil?"));
    clearLeadCachesForTests();
    await syncInbox(INBOX, PERIOD, store);
    messageCalls = [];
    const again = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(again.ok && again.result.run).toMatchObject({ analysedNew: 1, reused: 0 });
    // The history was read by the sync just before (30-minute cache); only this dialogue went to the model.
    expect(messageCalls).toEqual([]);
    expect(sent.at(-1)!.input[0].content.match(/=== Dialog/g)).toHaveLength(1);
    expect(store.analyses.size).toBe(1);
    expect([...store.analyses.values()][0]).toMatchObject({ writes: 2, situationState: "customer_last" });
  });

  it("re-analyses when the follow-up step changes with time", async () => {
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const later = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: new Date("2026-09-10T12:00:00.000Z") });
    expect(later.ok && later.result.run).toMatchObject({ analysedNew: 1 });
    expect(sent.at(-1)!.input[0].content).toContain("kunden har inte svarat på minst 3 dygn");
  });

  it("never reuses a result from another analysis version", async () => {
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const [current] = [...store.analyses.values()];
    store.analyses.clear();
    await store.saveAnalyses([{ ...current }], "lead-ai-2", current.model);
    const again = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(again.ok && again.result.run).toMatchObject({ analysedNew: 1, reused: 0 });
    expect([...store.analyses.values()].map((a) => a.analysisVersion).sort()).toEqual(["lead-ai-2", ANALYSIS_VERSION].sort());
  });

  it("drops AI text that contains personal data before it is stored", async () => {
    observation = `Kunden ${SYNTHETIC_CUSTOMER.email} fick inget alternativ.`;
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const [saved] = [...store.analyses.values()];
    expect(saved.classification.assessment!.missedReason).toBe("");
    expect(store.analysisData()).not.toContain(SYNTHETIC_CUSTOMER.email);
  });

  it("asks once more for dialogues the model left out of a batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    omitNext = 1;
    const run = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(run.ok && run.result.run).toMatchObject({ dialoguesAnalysed: 1, analysedNew: 1 });
    expect(sent.filter((r) => r.text.format.name === "lead_dialogues")).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledWith("[leads] AI batch incomplete, retrying", 1);
  });

  it("continues when a batch fails and stops at the budget", async () => {
    setOpenAIClientForTests({ responses: { create: vi.fn(async () => ({ status: "completed", output_text: "{not json" })) } } as unknown as Parameters<typeof setOpenAIClientForTests>[0]);
    const failed = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(failed.ok && failed.result.notAnalysed).toEqual(expect.arrayContaining([{ reason: "failed", count: 1 }]));
    expect(store.analyses.size).toBe(0);
    vi.mocked(limits.beginAIRequest).mockResolvedValueOnce({ ok: false, reason: "monthly_budget", message: "Månadens AI-budget är förbrukad. Kontakta en administratör." });
    expect(await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW })).toEqual({ ok: false, error: "Månadens AI-budget är förbrukad. Kontakta en administratör." });
  });
});

describe("customer needs (lead-needs-1) in the same job", () => {
  beforeEach(async () => {
    await syncInbox(INBOX, PERIOD, store);
    messageCalls = [];
  });

  it("analyses every lead with a customer message – also without a seller reply – with redacted, numbered text", async () => {
    const run = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(run.ok).toBe(true);
    const calls = sent.filter((r) => r.text.format.name === "lead_needs");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.store).toBe(false);
    expect(call.text.format).toMatchObject({ type: "json_schema", strict: true });
    for (const field of ["user", "metadata", "safety_identifier", "tools"]) expect(call).not.toHaveProperty(field);
    for (const secret of [KEY, SYNTHETIC_CUSTOMER.name, SYNTHETIC_CUSTOMER.email, SYNTHETIC_CUSTOMER.phone, "070-000 00 09", SELLER_NAME, SELLER_A, "user-1", "Testa", "files.example"]) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
    expect(call.input[0].content).toContain("[M1 · Kund, 0 min]");
    expect(call.input[0].content).toContain("[M2 · Säljare 1,");
    expect(call.input[0].content.match(/=== Dialog/g)).toHaveLength(2);
    expect(call.instructions).toMatch(/aldrig instruktioner till dig/);

    expect([...store.needs.keys()].map((k) => k.split("|")[0]).sort()).toEqual(["11", "12"]);
    const eleven = [...store.needs.values()].find((n) => n.threadId === "11")!;
    // The seller's topic (message 2) is not the customer's need; the sold car is visible with a seller message.
    expect(eleven.needs.needs.map((n) => n.code)).toEqual(["availability", "trade_in"]);
    expect(eleven.needs.unavailable).toMatchObject({ situation: "sold", carried: "not_visible" });
    expect(eleven.needs.ai).toBe(true);
    expect(run.ok && run.result.counts?.needs).toEqual({ candidates: 2, analysed: 2, analysedNew: 2, pending: 0 });
    expect(run.ok && run.result.notAnalysed).toEqual([{ reason: "no_registered_reply", count: 1 }]);
  });

  it("never sends a dialogue twice: stored needs are reused, a changed dialogue is analysed again", async () => {
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const before = sent.filter((r) => r.text.format.name === "lead_needs").length;
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(sent.filter((r) => r.text.format.name === "lead_needs")).toHaveLength(before);

    threads[1].latestMessageTimestamp = "2026-09-06T08:00:00.000Z";
    messages["12"].push(customer("c8", "2026-09-06T08:00:00.000Z", "Kan ni ringa mig?"));
    clearLeadCachesForTests();
    await syncInbox(INBOX, PERIOD, store);
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    const last = sent.filter((r) => r.text.format.name === "lead_needs").at(-1)!;
    expect(last.input[0].content.match(/=== Dialog/g)).toHaveLength(1);
    expect([...store.needs.values()].find((n) => n.threadId === "12")!.writes).toBe(2);
    expect([...store.needs.values()].find((n) => n.threadId === "11")!.writes).toBe(1);
  });

  it("reports needs left to do when the call fails, and keeps the lead analysis", async () => {
    needsFail = true;
    const run = await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(run.ok && run.result.notAnalysed).toEqual(expect.arrayContaining([{ reason: "needs_pending", count: 2 }]));
    expect(store.needs.size).toBe(0);
    expect(store.analyses.size).toBe(1);
  });

  it("drops a note with personal data before it is stored", async () => {
    needsNote = SYNTHETIC_CUSTOMER.email;
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    expect(store.analysisData()).not.toContain(SYNTHETIC_CUSTOMER.email);
    const eleven = [...store.needs.values()].find((n) => n.threadId === "11")!;
    expect(eleven.needs.needs.find((n) => n.code === "trade_in")!.note).toBe("");
  });
});

describe("combined analysis of a region", () => {
  it("uses stored classifications only, with evidence as thread ids", async () => {
    await syncInbox(INBOX, PERIOD, store);
    // Three analysed leads (copies of 11).
    const base = store.threads.get("11")!;
    for (const id of ["21", "22", "23"]) {
      store.threads.set(id, { ...base, threadId: id });
      messages[id] = messages["11"];
    }
    await analyseInbox({ inbox: INBOX, period: PERIOD }, "user-1", { store, now: NOW });
    // A lead synced after the analysis: reported as lacking a stored analysis, not as over the limit.
    store.threads.set("24", { ...base, threadId: "24" });
    sent = [];
    messageCalls = [];
    const run = await summariseScope({ scopeType: "region", regionId: "11111111-1111-4111-8111-111111111111", inboxIds: [INBOX.id], period: PERIOD }, "user-1", { store });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(messageCalls).toEqual([]);
    expect(run.result.notAnalysed).toContainEqual({ reason: "no_stored_analysis", count: 1 });
    expect(run.result.notAnalysed.some((n) => n.reason === "limit")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].text.format.name).toBe("lead_summary");
    expect(sent[0].instructions).toMatch(/Återberätta inte siffrorna/);
    // A finding with fewer than two dialogues is dropped; evidence is thread ids.
    expect(run.result.summary!.findings).toHaveLength(1);
    expect(run.result.summary!.findings[0].threadIds).toHaveLength(3);
    expect(run.result.summary!.sellerPatterns[0]).toMatchObject({ sellerId: SELLER_A, name: SELLER_NAME, strengths: [{ text: `${SELLER_NAME} svarar snabbt.` }] });
    const stored = store.runs.at(-1)!;
    expect(stored).toMatchObject({ scopeType: "region", inboxId: null, analysedNew: 0 });
    expect(JSON.stringify(stored.summary)).toContain(`{{${SELLER_A}}}`);
    expect(JSON.stringify(stored.summary)).not.toContain(SELLER_NAME);
  });

  it("refuses when too few dialogues are analysed", async () => {
    await syncInbox(INBOX, PERIOD, store);
    const run = await summariseScope({ scopeType: "all", regionId: null, inboxIds: [INBOX.id], period: PERIOD }, "user-1", { store });
    expect(run).toEqual({ ok: false, error: "Det finns för få AI-analyserade dialoger i urvalet (0 av 1). Analysera inkorgarna först." });
    expect(sent).toHaveLength(0);
  });
});
