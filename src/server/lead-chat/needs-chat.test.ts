import { describe, expect, it } from "vitest";

import type { LeadChatState } from "@/lib/leads/chat";
import type { DialogueNeeds, Need } from "@/lib/leads/needs";
import { resolvePeriod } from "@/lib/leads/periods";
import type { CoverageInfo, LeadRow } from "@/lib/leads/types";
import type { StoredAnalysis, StoredNeeds } from "@/server/data/leads";

import { buildBrief, type BriefInput } from "./brief";
import { findGaps } from "./gaps";
import { parseQuestion } from "./intent";
import { assertNoIdentifiers, pseudonymsFor } from "./pseudonyms";
import { resolveTurn, type LeadEntities } from "./scope";

/** Customer needs in the lead chat (ADR-052): the deterministic parts. Synthetic data only. */

const TODAY = "2026-10-03";
const R_A = "11111111-1111-4111-8111-111111111111";
const entities: LeadEntities = {
  regions: [{ id: R_A, name: "Alingsås" }],
  inboxes: [
    { id: "100", name: "Alingsås Volkswagen PB", regionId: R_A, facility: "Alingsås", brand: "Volkswagen" },
    { id: "102", name: "Alingsås Skoda", regionId: R_A, facility: "Alingsås", brand: "Škoda" },
  ],
  sellers: [{ id: "A-11", name: "Mia Exempelsson", inboxIds: ["100"] }],
};

const answer = (text: string, previous: LeadChatState | null = null) => {
  const t = resolveTurn({ text, today: TODAY, entities, previous, context: null });
  if (t.kind !== "answer") throw new Error(`${text}: ${t.kind}`);
  return t;
};

describe("needs questions", () => {
  it.each([
    ["Vad frågar kunderna mest om?", []],
    ["Vad är vanligast bland Blocket-leads?", []],
    ["Hur ser privatleasing ut?", ["need:private_leasing"]],
    ["Vad kombineras oftast med inbyte?", ["need:trade_in"]],
    ["Vilka behov är vanligast bland Virtuell-leads?", []],
    ["Hur hanterar vi kunder med tydliga köpsignaler?", ["strong_signal"]],
    ["Visa exempel där kunden vill köpa inom kort men inget tydligt nästa steg syns.", ["strong_signal", "soon", "next_step"]],
    ["Vad händer när bilen kunden frågar på är såld?", ["unavailable"]],
    ["Föreslår vi alternativ när ursprungsbilen inte längre är tillgänglig?", ["need:availability", "unavailable"]],
  ])("%s → needs, focus %j", (q, focus) => {
    const p = parseQuestion(q, TODAY);
    expect(p.intents).toContain("needs");
    expect(p.needsFocus).toEqual(focus);
    expect(p.outOfScope).toBeNull();
  });

  it("snabb leverans is a need, not a response time", () => {
    expect(parseQuestion("Hur många vill ha snabb leverans?", TODAY).intents).toEqual(["needs"]);
    expect(parseQuestion("Svarar vi snabbt?", TODAY).intents).toContain("response_time");
  });

  it("a follow-up that names a source or Virtuell keeps the needs and their focus", () => {
    const first = answer("Hur ser privatleasing ut?");
    expect(first.intents).toEqual(["needs"]);
    const next = answer("Och bland Blocket-leads?", first.state);
    expect(next.intents).toEqual(expect.arrayContaining(["needs", "source"]));
    expect(next.state.needsFocus).toEqual(["need:private_leasing"]);
    const virtual = answer("Hur är det för Virtuell?", next.state);
    expect(virtual.intents).toEqual(expect.arrayContaining(["needs", "virtual"]));
    // A new subject drops them.
    const other = answer("Hur är svarstiden?", virtual.state);
    expect(other.intents).toEqual(["response_time"]);
    expect(other.state.needsFocus).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

function row(p: Partial<LeadRow>): LeadRow {
  return {
    threadId: "1",
    inboxId: "100",
    arrivedAt: "2026-09-20T08:00:00.000Z",
    arrivalWindow: "business_hours",
    channel: "form",
    source: "Blocket",
    formName: null,
    vehicle: null,
    status: "registered_reply",
    firstResponseAt: null,
    calendarMinutes: 30,
    businessMinutes: 30,
    ownerId: "A-11",
    responderId: "A-11",
    assignmentEvents: 1,
    movedIntoInbox: false,
    threadOpen: false,
    customerMessages: 1,
    sellerMessages: 1,
    internalComments: 0,
    customerWroteLast: false,
    latestMessageAt: null,
    lastCustomerMessageAt: null,
    firstSellerAfterCustomerAt: null,
    followedUp: false,
    vehicleBrand: "Volkswagen",
    vehicleModel: "ID.4",
    vehicleSource: "subject",
    regnrKind: "plate",
    ...p,
  };
}

const need = (code: Need, note = "") => ({ code, stance: "expressed" as const, source: "customer_message" as const, message: 1, note });

function labels(p: Partial<DialogueNeeds>): StoredNeeds {
  return {
    fingerprint: "x",
    sourceLatestMessageAt: null,
    analysedAt: "",
    needs: {
      purpose: "purchase",
      needs: [],
      signals: [],
      requests: [],
      timeframe: "none",
      unavailable: { situation: "none", carried: "not_applicable", note: "" },
      sellerTopics: [],
      evidence: "sufficient",
      ai: true,
      ...p,
    },
  };
}

function analysis(agreed: boolean): StoredAnalysis {
  return {
    fingerprint: "x",
    sourceLatestMessageAt: null,
    situationState: null,
    analysedAt: "",
    classification: {
      intent: "price_or_offer",
      purchaseIntent: "clear",
      carStatus: "unknown",
      alternativeOffered: "not_applicable",
      behaviours: {
        answered_questions: { status: "done", reason: "" },
        next_step: { status: agreed ? "done" : "missing", reason: "" },
        needs_questions: { status: "not_relevant", reason: "" },
        visit_or_test_drive: { status: "not_relevant", reason: "" },
        follow_up: { status: "not_relevant", reason: "" },
      },
      observations: [],
      evidence: "sufficient",
      assessment: {
        goal: "",
        questions: [],
        signals: [],
        timeframe: "",
        budget: "",
        objections: [],
        infoNeeded: [],
        progress: "unclear",
        progressReason: "",
        missedOpportunity: "no",
        missedReason: "",
        continuation: "visible",
        agreedNextStep: agreed,
        opportunities: [],
        strengths: [],
      },
    },
  };
}

/** 40 leads: 36 purchase dialogues (24 trade-in, 12 of them also private leasing), 2 after sales, 2 not analysed. */
function dataset() {
  const rows: LeadRow[] = [];
  const needs = new Map<string, StoredNeeds>();
  const analyses = new Map<string, StoredAnalysis>();
  for (let i = 1; i <= 40; i++) {
    const id = String(5000 + i);
    rows.push(row({ threadId: id, source: i % 2 ? "Blocket" : "Hemsida", regnrKind: i % 4 === 0 ? "virtual" : "plate", arrivedAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T08:00:00.000Z` }));
    if (i > 38) continue;
    if (i > 36) {
      needs.set(id, labels({ purpose: "after_sales" }));
      continue;
    }
    const list = [...(i <= 24 ? [need("trade_in", `Vill byta in sin bil (${i})`)] : []), ...(i <= 12 ? [need("private_leasing", "Frågar om privatleasing")] : []), ...(i > 30 ? [need("business", "Företagsleasing")] : [])];
    needs.set(
      id,
      labels({
        needs: list,
        signals: i <= 6 ? [{ code: "wants_to_buy", source: "customer_message", message: 1, note: "Vill köpa bilen" }] : [],
        requests: i % 3 === 0 ? [{ code: "send_offer", source: "customer_message", message: 1, note: "Ber om offert" }] : [],
        unavailable: i >= 33 ? { situation: "sold", carried: i >= 35 ? "proposed_alternative" : "not_visible", note: "Bilen var såld" } : { situation: "none", carried: "not_applicable", note: "" },
        sellerTopics: i === 25 ? ["financing"] : [],
      }),
    );
    if (i <= 6) analyses.set(id, analysis(i <= 2));
  }
  return { rows, needs, analyses };
}

const fullCoverage: CoverageInfo = { inboxes: 1, completeInboxes: 1, coveredDays: 30, totalDays: 30, complete: true, oldestSyncAt: null, newestSyncAt: null, missing: [] };

function briefInput(p: Partial<BriefInput>): BriefInput {
  const period = resolvePeriod("30d", TODAY);
  return {
    state: { regionId: R_A, inboxId: "100", sellerId: null, preset: period.preset, from: period.from, to: period.to, intents: ["needs"], comparison: false, focus: [] },
    intents: ["needs"],
    examples: null,
    selection: "Alingsås Volkswagen PB",
    scopeType: "inbox",
    inboxes: [{ id: "100", name: "Alingsås Volkswagen PB" }],
    seller: null,
    period,
    previous: null,
    rows: [],
    prevRows: null,
    coverage: fullCoverage,
    prevCoverage: null,
    analyses: null,
    analysisVersion: "lead-ai-3.1",
    runFindings: null,
    pseudonyms: pseudonymsFor(entities.sellers),
    threadUrlTemplate: "https://app.hubspot.com/live-messages/1/inbox/{threadId}",
    now: new Date("2026-10-03T10:00:00Z"),
    ...p,
  };
}

describe("needs brief", () => {
  it("counts every need among purchase dialogues with its population, from the stored labels only", () => {
    const { rows, needs, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, needs, analyses }));
    expect(brief.modules).toContain("needs");
    expect(brief.text).toContain("Leads med behovsanalys: 38 av 40");
    expect(brief.text).toContain("Köpdialoger (köp eller leasing av bil) – populationen för kundbehoven: 36 av 38");
    expect(brief.text).toMatch(/- Inbyte: 24 av 36 \(population: köpdialoger med behovsanalys i urvalet/);
    expect(brief.text).toMatch(/- Privatleasing: 12 av 36/);
    // The seller's topic is listed apart and never as a customer need.
    expect(brief.text).toMatch(/Ämnen som säljaren tog upp[^\n]*\n- Finansiering eller billån 1/);
    expect(brief.text).not.toMatch(/- Finansiering eller billån: \d+ av/);
    // Every figure is in the registry: the model can quote but never has to count.
    expect(brief.metrics.map((m) => m.label)).toEqual(expect.arrayContaining(["Inbyte", "Privatleasing", "Köpdialoger med tydlig köpsignal"]));
    expect(() => assertNoIdentifiers(brief.text)).not.toThrow();
    for (const id of rows.map((r) => r.threadId)) expect(brief.text).not.toContain(id);
  });

  it("shows only combinations that pass the thresholds, with the leads behind them", () => {
    const { rows, needs } = dataset();
    const brief = buildBrief(briefInput({ rows, needs }));
    expect(brief.text).toMatch(/- Privatleasing \+ inbyte: 12 av 36/);
    const set = brief.sets.find((s) => s.id === "combo:private_leasing+trade_in" || s.id === "combo:trade_in+private_leasing");
    expect(set?.count).toBe(12);
    // 6 business + trade-in dialogues: below 8, not shown.
    expect(brief.text).not.toMatch(/Inbyte \+ företag/);
  });

  it("answers 'what goes with trade-in' among the dialogues that have it", () => {
    const { rows, needs } = dataset();
    const state = { ...briefInput({}).state, needsFocus: ["need:trade_in"] };
    const brief = buildBrief(briefInput({ rows, needs, state }));
    expect(brief.text).toMatch(/Tillsammans med "Inbyte" \(bland de 24 köpdialoger som har det\)/);
    expect(brief.text).toMatch(/- Privatleasing: 12 av 24/);
  });

  it("crosses with HubSpot facts per source and Virtuell, marking small groups", () => {
    const { rows, needs } = dataset();
    const brief = buildBrief(briefInput({ rows, needs }));
    expect(brief.text).toMatch(/- Blocket \(18 köpdialoger, litet underlag\): /);
    expect(brief.text).toMatch(/- "Virtuell" \(9 köpdialoger, litet underlag\)/);
  });

  it("the unavailable car: why, and what HubSpot shows afterwards – in groups, never as a verdict", () => {
    const { rows, needs } = dataset();
    const brief = buildBrief(briefInput({ rows, needs }));
    expect(brief.text).toContain("Köpdialoger där bilen inte gick att få: 4 av 36");
    expect(brief.text).toContain("Därefter: behovet fördes synligt vidare: 2 av 4");
    expect(brief.text).toContain("Därefter: inget sådant syns i hubspot: 2 av 4");
    expect(brief.text).toMatch(/ingen bedömning av säljaren/);
    expect(brief.sets.find((s) => s.id === "carried:forward")?.count).toBe(2);
  });

  it("a clear signal without a visible next step uses the lead analysis, and gives examples from that set", () => {
    const { rows, needs, analyses } = dataset();
    const state = { ...briefInput({}).state, needsFocus: ["strong_signal", "soon", "next_step"] };
    const brief = buildBrief(briefInput({ rows, needs, analyses, state, intents: ["needs", "examples"], examples: { polarity: "both", count: 3 } }));
    expect(brief.text).toMatch(/Tydlig köpsignal eller köp inom kort utan synligt nästa steg i HubSpot: 4 av 6/);
    expect(brief.text).toMatch(/### Exempel på dialoger som passar frågan \(3 av 4\)/);
    expect(brief.text).toContain('nästa steg="syns inte i HubSpot"');
    expect(brief.leads).toHaveLength(3);
    expect(brief.leads.every((l) => l.origin === "classification")).toBe(true);
    // The generic strengths/opportunities examples are not mixed in.
    expect(brief.text).not.toContain("## Exempel (AI-klassificering");
  });

  it("says when the material is small and when needs could not be read", () => {
    const { rows, needs } = dataset();
    const small = new Map([...needs].slice(0, 5));
    expect(buildBrief(briefInput({ rows, needs: small })).text).toMatch(/Litet underlag: färre än 10 köpdialoger/);
    expect(buildBrief(briefInput({ rows, needs: null })).text).toMatch(/Kundbehoven kunde inte läsas/);
  });
});

describe("needs gaps", () => {
  const period = resolvePeriod("30d", TODAY);
  const base = {
    selection: "Alingsås Volkswagen PB",
    scopeInboxes: [{ id: "100", name: "Alingsås Volkswagen PB" }],
    coverage: fullCoverage,
    rows: [row({ threadId: "1" }), row({ threadId: "2" })],
    analyses: null as Map<string, StoredAnalysis> | null,
    sellerId: null,
    intents: ["needs"] as LeadChatState["intents"],
    period,
    scope: { regionId: R_A, inboxId: "100" },
    question: "Vad frågar kunderna mest om?",
    canSync: true,
    canAnalyse: true,
    maxDays: 92,
    today: TODAY,
  };

  it("nothing analysed: explains it and offers the analysis (never starts it)", () => {
    const g = findGaps({ ...base, needs: new Map() });
    expect(g.answer).toMatch(/kundbehoven är inte analyserade ännu \(2 leads med meddelande från kunden\)/);
    expect(g.action?.steps).toMatchObject([{ action: "analyse", label: "Analysera dialogerna", inboxIds: ["100"] }]);
    expect(g.action?.steps[0].detail).toMatch(/^Kundbehoven i 2 leads/);
  });

  it("partly analysed: Folke answers and the step is offered under the answer", () => {
    const g = findGaps({ ...base, needs: new Map([["1", labels({})]]) });
    expect(g.answer).toBeNull();
    expect(g.note).toMatch(/Kundbehoven är inte analyserade för 1 av 2 leads/);
  });

  it("AI off: no step, a plain answer", () => {
    expect(findGaps({ ...base, canAnalyse: false, needs: new Map() })).toMatchObject({ action: null, answer: expect.stringMatching(/inte aktiverad/) });
  });
});
