import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeadChatState } from "@/lib/leads/chat";
import type { ChatRequest } from "@/lib/chat/protocol";
import { setOpenAIClientForTests } from "@/server/ai/providers/openai";
import { resetServerEnvForTests } from "@/server/env";

/**
 * The Leadanalys chat's planner and the server's validation of it (2026-10-06). Synthetic data only;
 * OpenAI, the AI limits and the data loading are fakes – nothing is called or stored.
 */

vi.mock("@/server/ai/limits", () => ({ beginAIRequest: vi.fn(async () => ({ ok: true, requestId: "r" })), finishAIRequest: vi.fn(async () => {}) }));
vi.mock("@/server/ai/usage", () => ({ recordChatUsage: vi.fn(async () => {}) }));
const loadSelection = vi.fn<(...args: unknown[]) => Promise<null>>(async () => null);
vi.mock("./load", () => ({ loadSelection: (...args: unknown[]) => loadSelection(...args) }));

const { applyPlan, nextGoal, normalizePeriod } = await import("./plan");
const { PLANNER_MODEL } = await import("./planner");
const { interpretTurn } = await import("./turn");
const { pseudonymsFor } = await import("./pseudonyms");
const { selectionStatus, isCurrentAnalysis } = await import("./status");
type Plan = import("./planner").Plan;
type LeadEntities = import("./scope").LeadEntities;

const TODAY = "2026-10-06";
const NOW = new Date("2026-10-06T10:00:00Z");
const R_A = "11111111-1111-4111-8111-111111111111";
const R_B = "22222222-2222-4222-8222-222222222222";
const entities: LeadEntities = {
  regions: [{ id: R_A, name: "Alingsås" }],
  inboxes: [
    { id: "100", name: "Alingsås Volkswagen PB", regionId: R_A, facility: "Alingsås", brand: "Volkswagen" },
    { id: "101", name: "Alingsås VW TRP", regionId: R_A, facility: "Alingsås", brand: "Volkswagen Transportbilar" },
  ],
  sellers: [
    { id: "A-11", name: "Mia Exempelsson", inboxIds: ["101"] },
    { id: "A-12", name: "Felix Testsson", inboxIds: ["100"] },
    { id: "A-13", name: "Johan Provsson", inboxIds: ["100"] },
    { id: "A-14", name: "Johan Demosson", inboxIds: ["100"] },
  ],
  // A seller in Folke the user may NOT see (another region).
  knownNames: ["Mia Exempelsson", "Felix Testsson", "Johan Provsson", "Johan Demosson", "Lisa Doldsson"],
};
const pseudonyms = pseudonymsFor(entities.sellers, entities.knownNames);
const alias = (id: string) => pseudonyms.aliasOf.get(id)!;

const base: LeadChatState = {
  regionId: R_A,
  inboxId: "101",
  sellerId: "A-11",
  preset: "7d",
  from: "2026-09-30",
  to: TODAY,
  intents: ["patterns", "examples"],
  comparison: false,
  focus: [],
  goal: { intents: ["patterns", "examples"], question: "Hur arbetar Mia med sina leads?", askedAt: "2026-10-06T09:00:00.000Z" },
  pending: { id: "8d6e2f8e-6a7b-4c39-9a7e-2d1f5c3b4a10", kind: "analyse", regionId: R_A, inboxId: "101", sellerId: "A-11", from: "2026-09-30", to: TODAY, inboxIds: ["101"], createdAt: "2026-10-06T09:00:00.000Z" },
};

const plan = (p: Partial<Plan> = {}): Plan => ({
  kind: "question",
  out_of_scope_topic: null,
  clarify_text: null,
  seller: { op: "keep", alias: null, name_text: null },
  scope: { op: "keep", region_text: null, inbox_text: null },
  period: { op: "keep", unit: null, amount: null, month: null, year: null, from: null, to: null },
  compare: "keep",
  topics: [],
  needs_focus: [],
  examples: { count: null, polarity: null },
  request: "none",
  ...p,
});
const apply = (p: Partial<Plan>, text = "", from: LeadChatState | null = base) => applyPlan({ plan: plan(p), text, entities, base: from, today: TODAY, pseudonyms, now: NOW });
const answerOf = (r: ReturnType<typeof apply>) => {
  if (r.turn.kind !== "answer") throw new Error(`not an answer: ${r.turn.kind}`);
  return r.turn;
};

describe("periods are normalised by the server", () => {
  const cur = { from: "2026-09-30", to: TODAY };
  const p = (x: Partial<Plan["period"]>) => normalizePeriod({ op: "keep", unit: null, amount: null, month: null, year: null, from: null, to: null, ...x }, cur, TODAY);
  it("natural periods become real dates; presets only when the dates are theirs", () => {
    expect(p({ op: "last_n", unit: "days", amount: 60 })).toEqual({ ok: true, preset: "custom", from: "2026-08-08", to: TODAY });
    expect(p({ op: "last_n", unit: "days", amount: 90 })).toMatchObject({ from: "2026-07-09", to: TODAY });
    expect(p({ op: "last_n", unit: "weeks", amount: 2 })).toMatchObject({ from: "2026-09-23" });
    expect(p({ op: "last_n", unit: "months", amount: 3 })).toMatchObject({ from: "2026-07-07", to: TODAY });
    expect(p({ op: "last_n", unit: "days", amount: 30 })).toMatchObject({ preset: "30d" });
    expect(p({ op: "calendar_month", month: 8 })).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    // A month still to come this year is last year's.
    expect(p({ op: "calendar_month", month: 11 })).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(p({ op: "since", month: 9 })).toMatchObject({ from: "2026-09-01", to: TODAY });
    expect(p({ op: "range", from: "2026-08-01", to: "2026-09-30" })).toMatchObject({ from: "2026-08-01", to: "2026-09-30" });
  });
  it("relative changes build on the current period", () => {
    // 7 days → the 7 days before; twice as far back.
    expect(p({ op: "previous" })).toMatchObject({ from: "2026-09-23", to: "2026-09-29" });
    expect(p({ op: "extend" })).toMatchObject({ from: "2026-09-23", to: TODAY });
    // A calendar month → the month before.
    expect(normalizePeriod({ op: "previous", unit: null, amount: null, month: null, year: null, from: null, to: null }, { from: "2026-09-01", to: "2026-09-30" }, TODAY)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
  });
  it("invalid or too long periods are refused, never used", () => {
    expect(p({ op: "last_n", unit: "days", amount: 400 })).toEqual({ ok: false, reason: "too_long" });
    expect(p({ op: "last_n", unit: "days", amount: 0 })).toEqual({ ok: false, reason: "amount" });
    expect(p({ op: "range", from: "2026-13-01", to: "2026-10-01" })).toEqual({ ok: false, reason: "range" });
    expect(p({ op: "range", from: "2026-10-01", to: "2026-09-01" })).toEqual({ ok: false, reason: "order" });
    expect(p({ op: "calendar_month", month: 0 })).toEqual({ ok: false, reason: "month" });
    // The future is cut at today.
    expect(p({ op: "range", from: "2026-10-01", to: "2026-12-31" })).toMatchObject({ to: TODAY });
  });
});

describe("the server validates every plan", () => {
  it("a period change keeps seller, scope and goal; the pending step of the old period is dropped", () => {
    const t = answerOf(apply({ period: { op: "last_n", unit: "days", amount: 60, month: null, year: null, from: null, to: null } }, "Ta senaste 60 dagarna istället"));
    expect(t.state).toMatchObject({ sellerId: "A-11", inboxId: "101", regionId: R_A, from: "2026-08-08", to: TODAY, goal: base.goal, pending: null });
    expect(t.intents).toEqual(["patterns", "examples"]);
  });
  it("another seller by alias keeps the goal; a correction back too", () => {
    const felix = answerOf(apply({ seller: { op: "set", alias: alias("A-12"), name_text: null } }, "Ta Felix istället"));
    expect(felix.state).toMatchObject({ sellerId: "A-12", inboxId: "100", goal: base.goal });
    const back = answerOf(apply({ seller: { op: "set", alias: alias("A-11"), name_text: null } }, "Nej, jag menade Mia", felix.state));
    expect(back.state).toMatchObject({ sellerId: "A-11", goal: base.goal });
  });
  it("a seller, region or inbox the user may not see is not found – never widened, never revealed", () => {
    // A hidden seller reaches the planner as "[namn]"; whatever it proposes, nothing resolves.
    expect(pseudonyms.hide("Hur går det för Lisa Doldsson?")).toBe("Hur går det för [namn]?");
    expect(apply({ seller: { op: "set", alias: null, name_text: "[namn]" } }, "Hur går det för Lisa Doldsson?").turn).toMatchObject({ kind: "not_found" });
    expect(apply({ seller: { op: "set", alias: "Säljare 99", name_text: null } }, "Säljare 99").turn).toMatchObject({ kind: "not_found" });
    expect(apply({ scope: { op: "set", region_text: "Skåne", inbox_text: null } }, "Ta Skåne").turn).toMatchObject({ kind: "not_found" });
    expect(apply({ scope: { op: "set", region_text: null, inbox_text: "Karlskrona Audi" } }, "Ta Karlskrona Audi").turn).toMatchObject({ kind: "not_found" });
    // A visible inbox of the same brand elsewhere is never chosen for a hidden one.
    expect(apply({ scope: { op: "set", region_text: null, inbox_text: "Karlskrona Volkswagen" } }, "Ta Karlskrona Volkswagen").turn).toMatchObject({ kind: "not_found" });
    expect(answerOf(apply({ scope: { op: "set", region_text: null, inbox_text: "VW TRP" } }, "Ta VW TRP")).state.inboxId).toBe("101");
    expect(answerOf(apply({ scope: { op: "set", region_text: null, inbox_text: "Alingsås Volkswagen PB" } }, "Ta Alingsås Volkswagen PB")).state.inboxId).toBe("100");
    const t = apply({ seller: { op: "set", alias: null, name_text: "Lisa" } }, "Ta Lisa");
    expect(t.turn).toMatchObject({ kind: "not_found" });
    expect(JSON.stringify(t.turn)).not.toMatch(/Lisa|Doldsson|R_B/);
    void R_B;
  });
  it("an ambiguous name is asked about, with the visible candidates", () => {
    const t = apply({ seller: { op: "set", alias: null, name_text: "[namn]" } }, "Ta Johan");
    expect(t.turn).toMatchObject({ kind: "clarify", text: expect.stringMatching(/Johan Provsson.*Johan Demosson|Johan Demosson.*Johan Provsson/) });
  });
  it("examples narrow the goal for one turn; a new subject is a new goal", () => {
    const ex = answerOf(apply({ topics: ["examples"], examples: { count: 2, polarity: "good" } }, "Ge mig två bra exempel"));
    expect(ex.state.goal).toEqual(base.goal);
    expect(ex.examples).toEqual({ polarity: "good", count: 2 });
    const coaching = answerOf(apply({ topics: ["coaching"] }, "Förbered mig inför ett coachingsamtal med Mia"));
    expect(coaching.state.goal).toMatchObject({ intents: ["meeting"], question: "Förbered mig inför ett coachingsamtal med Mia" });
  });
  it("comparison, requests and what is out of scope", () => {
    expect(answerOf(apply({ compare: "previous_period" })).intents).toContain("comparison");
    expect(answerOf(apply({ request: "confirm_pending" }, "Ja, gör det"))).toMatchObject({ request: "action", state: { pending: base.pending } });
    expect(answerOf(apply({ request: "decline" }, "Nej tack")).request).toBe("decline");
    expect(apply({ compare: "other_seller" }).turn).toMatchObject({ kind: "clarify" });
    expect(apply({ kind: "out_of_scope", out_of_scope_topic: "sales" }).turn).toMatchObject({ kind: "out_of_scope", topic: "sales" });
    expect(apply({ period: { op: "last_n", unit: "days", amount: 500, month: null, year: null, from: null, to: null } }).turn).toMatchObject({ kind: "clarify", text: expect.stringMatching(/högst ett år/) });
  });
  it("no goal yet: a selection change alone stays an overview", () => {
    const t = answerOf(apply({ period: { op: "last_n", unit: "days", amount: 60, month: null, year: null, from: null, to: null } }, "60 dagar", { ...base, goal: null, intents: [] }));
    expect(t.intents).toEqual(["overview"]);
    expect(nextGoal(null, [], [], "x", NOW).goal).toBeNull();
  });
});

describe("one definition of the analysis status", () => {
  it("current means the same latest message and follow-up step – as the analysis job and the page", () => {
    const row = { latestMessageAt: "2026-10-01T10:00:00.000Z", lastCustomerMessageAt: null, firstSellerAfterCustomerAt: null, followedUp: false, sellerMessages: 1 } as never;
    expect(isCurrentAnalysis(row, { sourceLatestMessageAt: "2026-10-01T10:00:00.000Z", situationState: "none" } as never, NOW)).toBe(true);
    expect(isCurrentAnalysis(row, { sourceLatestMessageAt: "2026-09-01T10:00:00.000Z", situationState: "none" } as never, NOW)).toBe(false);
    expect(isCurrentAnalysis(row, { sourceLatestMessageAt: "2026-10-01T10:00:00.000Z", situationState: "waiting" } as never, NOW)).toBe(false);
  });
  it("counts the seller's dialogues and says what is missing", () => {
    const r = (id: string, responder: string) => ({ threadId: id, inboxId: "101", status: "registered_reply", sellerMessages: 1, customerMessages: 1, responderId: responder, ownerId: responder }) as never;
    const status = selectionStatus({
      rows: [r("1", "A-11"), r("2", "A-11"), r("3", "A-12")],
      analyses: new Map([["1", {}]]),
      needs: new Map(),
      sellerId: "A-11",
      coverage: { inboxes: 1, completeInboxes: 1, coveredDays: 7, totalDays: 7, complete: true, oldestSyncAt: null, newestSyncAt: null, missing: [] },
      period: { preset: "7d", from: "2026-09-30", to: TODAY, label: "Senaste 7 dagarna" },
      today: TODAY,
      intents: ["patterns"],
      inboxIds: ["101"],
    });
    expect(status).toMatchObject({ dialogues: { relevant: 2, current: 1, missing: 1 }, requires: { dialogues: true, needs: false }, complete: false });
  });
});

describe("the planner call", () => {
  let sent: Record<string, unknown>[] = [];
  const answer = (p: unknown) => ({ status: "completed", output_text: JSON.stringify(p), usage: { input_tokens: 900, output_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  beforeEach(() => {
    sent = [];
    process.env.FOLKE_LEAD_ANALYSIS_AI = "on";
    process.env.FOLKE_LEAD_CHAT_AI = "on";
    process.env.FOLKE_AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-placeholder";
    resetServerEnvForTests();
  });
  afterEach(() => {
    setOpenAIClientForTests(null);
    delete process.env.FOLKE_LEAD_CHAT_AI;
    process.env.FOLKE_LEAD_ANALYSIS_AI = "off";
    process.env.FOLKE_AI_PROVIDER = "mock";
    delete process.env.OPENAI_API_KEY;
    resetServerEnvForTests();
  });
  const fake = (respond: (body: Record<string, unknown>) => unknown) =>
    setOpenAIClientForTests({ responses: { create: vi.fn(async (body: Record<string, unknown>) => (sent.push(body), respond(body))) } } as never);
  const request = (content: string, leadTurn?: ChatRequest["leadTurn"]): ChatRequest => ({ assistantId: "00000000-0000-4000-8000-000000000000", conversationId: null, message: { content }, ...(leadTurn ? { leadTurn } : {}) });
  const interpret = (content: string, leadTurn?: ChatRequest["leadTurn"]) =>
    interpretTurn({ parsed: request(content, leadTurn), base, previousState: base, context: null, entities, pseudonyms, today: TODAY, now: NOW, userId: "u", assistantId: "a", conversationId: "c", supabase: {} as never });

  it("gpt-6-luna, effort none, a strict schema – and no real name in anything sent", async () => {
    fake(() => answer(plan({ period: { op: "last_n", unit: "days", amount: 60, month: null, year: null, from: null, to: null } })));
    const r = await interpret("Kan du ta ett bredare urval på Mia Exempelsson, senaste 60 dagarna");
    expect(r.via).toBe("planner");
    expect(r.turn).toMatchObject({ kind: "answer", state: { sellerId: "A-11", from: "2026-08-08" } });
    const body = sent[0] as { model: string; reasoning: { effort: string }; text: { format: { strict: boolean } }; input: { content: string }[] };
    expect(body.model).toBe(PLANNER_MODEL);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning.effort).toBe("none");
    expect(body.text.format.strict).toBe(true);
    const outgoing = JSON.stringify(sent);
    expect(outgoing).not.toMatch(/Exempelsson|Testsson|Provsson|Doldsson|Mia |A-1\d/);
    expect(outgoing).toContain(alias("A-11"));
  });

  it("a timeout, an error, invalid JSON or a plan outside the schema fall back to the rule-based reading", async () => {
    for (const respond of [
      () => {
        const e = new Error("Request timed out.");
        e.name = "APIConnectionTimeoutError";
        throw e;
      },
      () => {
        throw new Error("boom");
      },
      () => ({ status: "completed", output_text: "{not json", usage: null }),
      () => answer({ kind: "question", seller: "Mia" }),
    ]) {
      fake(respond);
      const r = await interpret("hur går det för Mia senaste 30 dagarna?");
      expect(r.via).toBe("fallback");
      expect(r.planner?.plannerOutcome).toMatch(/timeout|error|invalid/);
      // The rule-based reading still works, and the goal is kept as before.
      expect(r.turn).toMatchObject({ kind: "answer", state: { sellerId: "A-11", preset: "30d" } });
    }
  });

  it("a structured click never reaches the planner", async () => {
    fake(() => {
      throw new Error("must not be called");
    });
    const cont = await interpret("Fortsätt: Hur arbetar Mia med sina leads?", { kind: "continue", pendingId: base.pending!.id });
    expect(cont).toMatchObject({ via: "structured", turn: { kind: "answer", request: "continue", intents: ["patterns", "examples"], state: { sellerId: "A-11", goal: base.goal } } });
    const ask = await interpret("Hur väl driver Mia dialogerna mot nästa steg?", { kind: "ask", topics: ["follow_up_next_steps"] });
    expect(ask).toMatchObject({ via: "structured", turn: { state: { goal: { intents: ["patterns", "examples"], question: "Hur väl driver Mia dialogerna mot nästa steg?" } } } });
    const choose = await interpret("Jag vill veta mer om Felix Testsson", { kind: "choose_seller", sellerId: "A-12" });
    expect(choose).toMatchObject({ via: "structured", turn: { request: "seller_intro", state: { sellerId: "A-12", inboxId: "100" } } });
    // A seller the user may not see, even in a crafted click.
    expect((await interpret("x", { kind: "choose_seller", sellerId: "A-99" })).turn).toMatchObject({ kind: "not_found" });
    expect(sent).toHaveLength(0);
  });
});
