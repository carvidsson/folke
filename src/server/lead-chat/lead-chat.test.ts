import { describe, expect, it } from "vitest";

import type { LeadChatState } from "@/lib/leads/chat";
import { periodLabel, resolvePeriod } from "@/lib/leads/periods";
import type { CoverageInfo, LeadRow } from "@/lib/leads/types";
import type { StoredAnalysis } from "@/server/data/leads";

import { buildBrief, modulesFor, type BriefInput } from "./brief";
import { currentFacts, earlierFactsSection, usedFacts, visibleFacts } from "./facts";
import { findGaps } from "./gaps";
import { finalSources } from "./handler";
import { parseQuestion, periodFromText } from "./intent";
import { formatMinutes } from "./metrics";
import { aliasSellerTokens, assertNoIdentifiers, neutralizeStoredAliases, pseudonymsFor, streamRevealer } from "./pseudonyms";
import { resolveTurn, validState, type LeadEntities } from "./scope";

/** Leadanalys in the chat (ADR-050): the deterministic parts. Synthetic data only. */

const TODAY = "2026-10-03";
const R_A = "11111111-1111-4111-8111-111111111111";
const R_B = "22222222-2222-4222-8222-222222222222";

const entities: LeadEntities = {
  regions: [
    { id: R_A, name: "Alingsås" },
    { id: R_B, name: "Blekinge" },
  ],
  inboxes: [
    { id: "100", name: "Alingsås Volkswagen PB", regionId: R_A, facility: "Alingsås", brand: "Volkswagen" },
    { id: "101", name: "Alingsås VW TRP", regionId: R_A, facility: "Alingsås", brand: "Volkswagen Transportbilar" },
    { id: "102", name: "Alingsås Skoda", regionId: R_A, facility: "Alingsås", brand: "Škoda" },
    { id: "200", name: "Karlshamn Volkswagen", regionId: R_B, facility: "Karlshamn", brand: "Volkswagen" },
    { id: "201", name: "Karlshamn Skoda", regionId: R_B, facility: "Karlshamn", brand: "Škoda" },
  ],
  sellers: [
    { id: "A-11", name: "Mia Exempelsson", inboxIds: ["100"] },
    { id: "A-12", name: "Bo Testsson", inboxIds: ["100", "102"] },
    { id: "A-13", name: "Johan Provsson", inboxIds: ["200"] },
    { id: "A-14", name: "Johan Demosson", inboxIds: ["201"] },
  ],
};

function turn(text: string, previous: LeadChatState | null = null, context = null as Parameters<typeof resolveTurn>[0]["context"]) {
  return resolveTurn({ text, today: TODAY, entities, previous, context });
}

function answer(text: string, previous: LeadChatState | null = null) {
  const t = turn(text, previous);
  if (t.kind !== "answer") throw new Error(`${text}: ${t.kind}`);
  return t;
}

describe("intent", () => {
  it.each([
    ["hur går det för mia egentligen?", []],
    ["är vi långsamma i alingsås?", ["response_time"]],
    ["vad hade du tagit upp med säljarna?", ["meeting"]],
    ["visa några exempel", ["examples"]],
    ["är det samma för resten?", []],
    ["Hur är svarstiden i våra inkorgar?", ["response_time"]],
    ["Vilka leadskällor ger flest leads, och svarar vi lika snabbt på Blocket?", ["response_time", "source"]],
    ["Hur många virtuella annonser har vi?", ["virtual"]],
    ["Har det blivit bättre än förra månaden?", ["comparison"]],
    ["Vad fungerar bra och vad kan vi utveckla?", ["patterns"]],
    ["Varför då?", ["explain"]],
    // Found in the live test: "bli bättre på" is about development, "dialogerna" is not a request for examples.
    ["vad kan vi bli bättre på där", ["patterns"]],
    ["Vad fungerar bra i dialogerna i Skåne?", ["patterns"]],
    ["Går det bättre än förra månaden?", ["comparison"]],
  ])("%s → %j", (q, intents) => {
    expect(parseQuestion(q, TODAY).intents).toEqual(intents);
  });

  it("reads example requests: polarity and count, at most ten", () => {
    expect(parseQuestion("visa fem exempel på bra svar", TODAY).examples).toEqual({ polarity: "good", count: 5 });
    expect(parseQuestion("visa två exempel där vi kunde gjort mer", TODAY).examples).toEqual({ polarity: "improve", count: 2 });
    expect(parseQuestion("visa 40 exempel", TODAY).examples).toEqual({ polarity: "both", count: 10 });
    expect(parseQuestion("visa några exempel", TODAY).examples).toEqual({ polarity: "both", count: 3 });
  });

  it("recognises questions outside the material", () => {
    expect(parseQuestion("Hur många bilar sålde vi i september?", TODAY).outOfScope).toBe("sales");
    expect(parseQuestion("Vem är bästa säljare?", TODAY).outOfScope).toBe("ranking");
    expect(parseQuestion("Vad skrev kunden i lead 3?", TODAY).outOfScope).toBe("customer");
    expect(parseQuestion("Hur är svarstiden?", TODAY).outOfScope).toBeNull();
  });

  it("reads periods, and a comparison with last month is not a new period", () => {
    expect(periodFromText("senaste veckan", TODAY)).toEqual({ preset: "7d" });
    expect(periodFromText("hur gick det förra månaden", TODAY)).toEqual({ preset: "last_month" });
    expect(periodFromText("är det bättre än förra månaden", TODAY)).toBeNull();
    expect(periodFromText("hur var svarstiden i augusti", TODAY)).toEqual({ preset: "custom", from: "2026-08-01", to: "2026-08-31" });
    // A month later in the year means last year's.
    expect(periodFromText("i november", TODAY)).toEqual({ preset: "custom", from: "2025-11-01", to: "2025-11-30" });
    expect(periodFromText("i oktober", TODAY)).toEqual({ preset: "custom", from: "2026-10-01", to: TODAY });
  });
});

describe("scope", () => {
  it("names a seller and uses the seller's own inbox", () => {
    const t = answer("hur går det för mia egentligen?");
    expect(t.state).toMatchObject({ sellerId: "A-11", inboxId: "100", regionId: R_A });
    expect(t.intents).toEqual(["overview"]);
  });

  it("a region name that is also a facility is the region", () => {
    expect(answer("är vi långsamma i alingsås?").state).toMatchObject({ regionId: R_A, inboxId: null, sellerId: null });
  });

  it("brand and facility select one inbox; VW means Volkswagen, not the transport inbox", () => {
    expect(answer("hur är svarstiden för vw i alingsås").state.inboxId).toBe("100");
    expect(answer("svarstid för vw trp i alingsås").state.inboxId).toBe("101");
    expect(answer("hur går det för skoda karlshamn").state.inboxId).toBe("201");
  });

  it("asks instead of guessing", () => {
    expect(turn("hur går det för johan?")).toMatchObject({ kind: "clarify" });
    expect((turn("hur går det för johan?") as { text: string }).text).toContain("Johan Provsson");
    expect(turn("hur går det för skoda?")).toMatchObject({ kind: "clarify" });
    // A facility that is not a region: which inbox, or the whole region.
    expect(turn("hur går det i karlshamn?")).toMatchObject({ kind: "clarify" });
  });

  it("a name the user cannot see is not found, without revealing anything", () => {
    const t = turn("hur går det för lisa?");
    expect(t.kind).toBe("not_found");
    expect((t as { text: string }).text).not.toMatch(/lisa/i);
    expect(turn("Hur går det i Skåne?").kind).toBe("not_found");
    // Ordinary words are not names.
    expect(turn("hur går det för oss?").kind).toBe("answer");
    expect(turn("syns det i HubSpot?").kind).toBe("answer");
  });

  it("follow-ups inherit the selection and the question; 'resten' widens one step", () => {
    const first = answer("hur går det för mia egentligen?");
    const compare = answer("har det blivit bättre än förra månaden?", first.state);
    expect(compare.state).toMatchObject({ sellerId: "A-11", inboxId: "100", comparison: true });
    const examples = answer("visa några exempel", compare.state);
    expect(examples.state.sellerId).toBe("A-11");
    expect(examples.intents).toContain("examples");
    const rest = answer("är det samma för resten?", { ...examples.state, focus: ["unanswered_questions"] });
    expect(rest.state).toMatchObject({ sellerId: null, inboxId: "100", focus: ["unanswered_questions"] });
    // The same question for the wider selection, with the counts that can answer it – and what it widened from.
    expect(rest.intents).toEqual([...examples.intents, "patterns"]);
    expect(rest.widenedFrom).toMatchObject({ sellerId: "A-11", inboxId: "100" });
    expect(examples.widenedFrom).toBeNull();
    const region = answer("och för övriga inkorgar?", rest.state);
    expect(region.state).toMatchObject({ inboxId: null, regionId: R_A });
    expect(answer("hur ser det ut totalt?", region.state).state).toMatchObject({ regionId: null, inboxId: null });
  });

  it("keeps the period of the conversation unless the question names one", () => {
    const first = answer("hur är svarstiden i alingsås förra månaden?");
    expect(first.state).toMatchObject({ preset: "last_month", from: "2026-09-01", to: "2026-09-30" });
    expect(answer("och för skoda?", first.state).state).toMatchObject({ preset: "last_month", inboxId: "102" });
  });

  it("the page context and a remembered selection never widen access", () => {
    // Ids the user cannot see are dropped, not trusted.
    const forged: LeadChatState = { regionId: "33333333-3333-4333-8333-333333333333", inboxId: "999", sellerId: "A-99", preset: "30d", from: "2026-09-04", to: TODAY, intents: [], comparison: false, focus: [] };
    expect(validState(forged, entities)).toMatchObject({ regionId: null, inboxId: null, sellerId: null });
    const t = turn("hur är svarstiden?", null, { regionId: "33333333-3333-4333-8333-333333333333", inboxId: "999" });
    expect(t).toMatchObject({ kind: "answer", state: { regionId: null, inboxId: null } });
    // A valid page selection is used.
    expect(turn("hur är svarstiden?", null, { inboxId: "102", preset: "7d" })).toMatchObject({ state: { inboxId: "102", regionId: R_A, preset: "7d" } });
  });
});

// ---------------------------------------------------------------------------
// Brief
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

function stored(a: Partial<NonNullable<StoredAnalysis["classification"]["assessment"]>>): StoredAnalysis {
  return {
    fingerprint: "x",
    sourceLatestMessageAt: null,
    situationState: null,
    analysedAt: "",
    classification: {
      intent: "price_or_offer",
      purchaseIntent: "interested",
      carStatus: "unknown",
      alternativeOffered: "not_applicable",
      behaviours: {
        answered_questions: { status: "done", reason: "" },
        next_step: { status: "done", reason: "" },
        needs_questions: { status: "not_relevant", reason: "" },
        visit_or_test_drive: { status: "not_relevant", reason: "" },
        follow_up: { status: "not_relevant", reason: "" },
      },
      observations: [],
      evidence: "sufficient",
      assessment: {
        goal: "Kunden vill ha en offert.",
        questions: [],
        signals: [],
        timeframe: "",
        budget: "",
        objections: [],
        infoNeeded: [],
        progress: "moved_forward",
        progressReason: "Säljare 4 bokade en provkörning.",
        missedOpportunity: "no",
        missedReason: "",
        continuation: "visible",
        agreedNextStep: true,
        opportunities: [],
        strengths: [],
        ...a,
      },
    },
  };
}

const fullCoverage: CoverageInfo = { inboxes: 1, completeInboxes: 1, coveredDays: 30, totalDays: 30, complete: true, oldestSyncAt: null, newestSyncAt: null, missing: [] };

function briefInput(p: Partial<BriefInput>): BriefInput {
  const period = resolvePeriod("30d", TODAY);
  return {
    state: { regionId: R_A, inboxId: "100", sellerId: null, preset: period.preset, from: period.from, to: period.to, intents: [], comparison: false, focus: [] },
    intents: ["overview"],
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

function dataset() {
  const rows: LeadRow[] = [];
  const analyses = new Map<string, StoredAnalysis>();
  for (let i = 1; i <= 24; i++) {
    const id = String(1000 + i);
    const seller = i % 3 === 0 ? "A-12" : "A-11";
    rows.push(
      row({
        threadId: id,
        arrivedAt: `2026-09-${String(5 + (i % 20)).padStart(2, "0")}T0${i % 9}:00:00.000Z`,
        ownerId: seller,
        responderId: i === 24 ? null : seller,
        status: i === 24 ? "no_registered_reply" : "registered_reply",
        businessMinutes: i === 24 ? null : i * 10,
        calendarMinutes: i === 24 ? null : i * 12,
        threadOpen: i === 24,
        source: i % 4 === 0 ? "Hemsida" : "Blocket",
        regnrKind: i % 5 === 0 ? "virtual" : "plate",
      }),
    );
    if (i <= 20) {
      analyses.set(
        id,
        stored({
          strengths: i <= 8 ? ["interest_to_next_step"] : [],
          opportunities: i >= 9 && i <= 13 ? ["unanswered_questions"] : i === 14 ? ["visit_interest"] : [],
          continuation: i >= 15 && i <= 17 ? "not_determinable" : "visible",
          missedOpportunity: i >= 9 && i <= 14 ? "yes" : "no",
          missedReason: i >= 9 && i <= 14 ? "Kundens fråga om leveranstid fick inget synligt svar. Säljare 2 skrev om annat." : "",
        }),
      );
    }
  }
  // Not determinable with an opportunity: never an example of something to improve.
  analyses.set("1016", stored({ opportunities: ["unanswered_questions"], continuation: "not_determinable", missedOpportunity: "yes" }));
  return { rows, analyses };
}

describe("brief", () => {
  it("loads only the modules the question needs", () => {
    expect([...modulesFor(["response_time"], false)].sort()).toEqual(["header", "keyFigures", "responseTimes"]);
    expect(modulesFor(["source"], false).has("patterns")).toBe(false);
    expect([...modulesFor(["meeting"], true)]).toEqual(expect.arrayContaining(["patterns", "examples", "seller", "observations"]));
  });

  it("every figure has a population; never 'besvarade'; no names, thread ids or links", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["meeting"], examples: { polarity: "both", count: 4 } }));
    for (const m of brief.metrics) expect(m.population).toBeTruthy();
    expect(brief.text).not.toMatch(/(?<!o)besvarade (leads|dialoger)/i);
    expect(brief.text).not.toMatch(/Mia|Exempelsson|Bo Testsson|hubspot\.com|10\d\d"/);
    expect(brief.text).toMatch(/Säljare \d/);
    // Stored texts are data: an old run's alias becomes "säljaren".
    expect(brief.text).not.toMatch(/Säljare 4 bokade/);
    // The source cards carry links and names (shown to the user only).
    expect(brief.leads.every((l) => l.hubspotUrl?.startsWith("https://app.hubspot.com/"))).toBe(true);
  });

  it("populations add up and are not mixed", () => {
    const { rows } = dataset();
    const brief = buildBrief(briefInput({ rows, intents: ["response_time"] }));
    const get = (label: string) => brief.metrics.find((m) => m.label === label)!;
    expect(get("Leads")).toMatchObject({ value: 24 });
    expect(get("Leads med registrerat säljsvar")).toMatchObject({ value: 23, of: 24 });
    expect(get("Leads utan registrerat säljsvar i HubSpot")).toMatchObject({ value: 1, of: 24 });
    expect(get("Första registrerade säljsvar inom 1 arbetstimme")).toMatchObject({ value: 6, of: 23, population: "leads med registrerat säljsvar i urvalet" });
    // The response-time distribution sums to the replied leads.
    const dist = /Fördelning[^\n]*n = (\d+)\): ([^\n]+)/.exec(brief.text)!;
    const sum = dist[2].split(" · ").reduce((s, part) => s + Number(part.split(": ")[1]), 0);
    expect(sum).toBe(Number(dist[1]));
    expect(sum).toBe(23);
  });

  it("examples are deterministic, exclude 'not determinable', and follow the requested polarity", () => {
    const { rows, analyses } = dataset();
    const input = briefInput({ rows, analyses, intents: ["examples"], examples: { polarity: "improve", count: 3 } });
    const a = buildBrief(input);
    const b = buildBrief({ ...input, rows: [...rows].reverse() });
    expect(a.leads.map((l) => l.id)).toEqual(b.leads.map((l) => l.id));
    expect(a.leads).toHaveLength(3);
    expect(a.leads.every((l) => l.label === "Möjlighet att utveckla" && l.origin === "classification")).toBe(true);
    expect(a.leads.map((l) => l.id)).not.toContain("1016");
    expect(a.text).toContain('nr="1"');
  });

  it("'samma typ av problem' keeps the focus types", () => {
    const { rows, analyses } = dataset();
    const input = briefInput({ rows, analyses, intents: ["examples"], examples: { polarity: "improve", count: 5 } });
    const focused = buildBrief({ ...input, state: { ...input.state, focus: ["visit_interest"] } });
    expect(focused.leads.map((l) => l.types)).toEqual([["visit_interest"]]);
    expect(focused.text).toMatch(/Bara 1 exempel/);
  });

  it("a seller's figures use the seller's own populations and flag a small sample", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, seller: { id: "A-12", name: "Bo Testsson" }, intents: ["overview"] }));
    const alias = pseudonymsFor(entities.sellers).aliasOf.get("A-12")!;
    const first = brief.metrics.find((m) => m.label === `Leads där ${alias} gav det första registrerade säljsvaret`)!;
    expect(first).toMatchObject({ value: 7, of: 24 });
    expect(brief.metrics.find((m) => m.label.startsWith(`Första svar inom 1 arbetstimme för ${alias}`))).toMatchObject({ population: "leads där säljaren gav det första registrerade säljsvaret" });
    expect(brief.basis.selection).toContain("Bo Testsson");
  });

  it("a widened question gets the same measures for the earlier, narrower selection", () => {
    const { rows, analyses } = dataset();
    const alias = pseudonymsFor(entities.sellers).aliasOf.get("A-12")!;
    const brief = buildBrief(
      briefInput({ rows, analyses, intents: ["examples", "patterns"], widenedFrom: { label: `${alias} i Alingsås Volkswagen PB`, sellerId: "A-12", inboxIds: ["100"] } }),
    );
    expect(brief.text).toContain(`Urvalet har vidgats: det tidigare svaret gällde ${alias} i Alingsås Volkswagen PB`);
    const section = brief.text.slice(brief.text.indexOf("## Samma mått för det tidigare urvalet"));
    // A-12 answered first in 7 leads; 6 of them are among the analysed dialogues (ids 1003…1018).
    expect(section).toMatch(/Leads där säljaren gav det första registrerade säljsvaret: 7/);
    expect(section).toMatch(/AI-analyserade dialoger: 6/);
    expect(section).toMatch(/population: AI-analyserade dialoger där säljaren gav det första registrerade säljsvaret/);
    expect(section).not.toMatch(/Bo Testsson/);
    // "Resten": everyone else in the selection – 23 replied leads minus the seller's 7.
    expect(brief.text).toMatch(/## Övriga i urvalet \(utan Säljare \d+\)/);
    expect(brief.text).toMatch(/där någon annan gav det första svaret, n = 16/);
  });

  it("an incomplete period or comparison is stated, never presented as complete", () => {
    const { rows } = dataset();
    const partial = { ...fullCoverage, complete: false, completeInboxes: 0, coveredDays: 10, missing: [{ inboxId: "100", name: "Alingsås Volkswagen PB", coveredDays: 10 }] };
    const prev = resolvePeriod("custom", TODAY, "2026-08-05", "2026-09-03");
    const brief = buildBrief(briefInput({ rows, coverage: partial, intents: ["comparison"], previous: prev, prevRows: [], prevCoverage: partial }));
    expect(brief.text).toMatch(/inte hämtad i sin helhet/);
    expect(brief.text).toMatch(/Ingen jämförelse kan göras/);
    expect(brief.basis.lines.join(" ")).toMatch(/ingen jämförelse/);
  });

  it("a simple question gives a small brief", () => {
    const { rows, analyses } = dataset();
    const small = buildBrief(briefInput({ rows, intents: ["response_time"] }));
    const large = buildBrief(briefInput({ rows, analyses, intents: ["meeting"], examples: { polarity: "both", count: 4 } }));
    expect(small.stats.approxTokens).toBeLessThan(large.stats.approxTokens);
    expect(large.stats.approxTokens).toBeLessThan(8000);
  });

  it("formats minutes as the Leadanalys page does", () => {
    expect(formatMinutes(35)).toBe("35 min");
    expect(formatMinutes(125)).toBe("2 h 5 min");
    expect(formatMinutes(1500)).toBe("1 d 1 h");
    expect(formatMinutes(null)).toBe("saknas");
  });
});

describe("pseudonyms", () => {
  it("regression (found 2026-10-04): a first name that is also a word only counts when written as a name", () => {
    const withPer = pseudonymsFor([...entities.sellers, { id: "A-15", name: "Per Testsson", inboxIds: ["100"] }]);
    const per = withPer.aliasOf.get("A-15")!;
    expect(withPer.hide("Kontakten kan ha skett per telefon.")).toBe("Kontakten kan ha skett per telefon.");
    expect(withPer.hide("Hur går det för Per?")).toBe(`Hur går det för ${per}?`);
    expect(withPer.hide("Per Testsson och Pers kunder")).toBe(`${per} och ${per} kunder`);
    const scoped = { ...entities, sellers: [...entities.sellers, { id: "A-15", name: "Per Testsson", inboxIds: ["100"] }] };
    expect(resolveTurn({ text: "svarar vi per telefon i alingsås?", today: TODAY, entities: scoped, previous: null, context: null })).toMatchObject({ kind: "answer", state: { sellerId: null } });
    expect(resolveTurn({ text: "Hur går det för Per?", today: TODAY, entities: scoped, previous: null, context: null })).toMatchObject({ state: { sellerId: "A-15" } });
  });

  it("regression (found 2026-10-04): stored seller tokens become aliases, and identifiers never leave", () => {
    const p = pseudonymsFor(entities.sellers);
    expect(aliasSellerTokens("Mönstret gäller främst {{A-11}} och {{A-999}}.", p)).toBe(`Mönstret gäller främst ${p.aliasOf.get("A-11")} och en säljare.`);
    expect(neutralizeStoredAliases("{{A-12345678}} skrev")).toBe("säljaren skrev");
    for (const bad of ["{{A-12345678}}", "tråd 11254513680", "https://app.hubspot.com/live-messages/1/inbox/2", "A-12345678"]) expect(() => assertNoIdentifiers(`x ${bad} y`)).toThrow();
    expect(() => assertNoIdentifiers("72 av 91 leads, 7 min, 2026-10-04, Säljare 3")).not.toThrow();
  });

  it("the brief maps a stored combined analysis's seller tokens to aliases", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["patterns"], runFindings: [{ title: "Frågor om finansiering", text: "När kunden frågar om finansiering tar {{A-11}} fram ett förslag.", kind: "working", threadIds: ["1001"] }] }));
    expect(brief.text).toContain(`tar ${pseudonymsFor(entities.sellers).aliasOf.get("A-11")} fram`);
    expect(() => assertNoIdentifiers(brief.text)).not.toThrow();
  });

  const p = pseudonymsFor(entities.sellers);

  it("hides full names and first names, and maps aliases back", () => {
    const alias = p.aliasOf.get("A-11")!;
    expect(p.hide("Hur går det för Mia Exempelsson? Och mias svarstid?")).toBe(`Hur går det för ${alias}? Och ${alias} svarstid?`);
    expect(p.reveal(`${alias} svarar snabbt.`)).toBe("Mia Exempelsson svarar snabbt.");
    // Two sellers called Johan: the first name alone is not replaced (the full names are).
    expect(p.hide("Johan Provsson och Johan Demosson")).not.toMatch(/Johan/);
    // A first name several sellers share is never sent, as typed or in lowercase.
    expect(p.hide("hur går det för johan?")).toBe("hur går det för [namn]?");
    // Sellers the user may not see are masked, never aliased or revealed.
    const q = pseudonymsFor(entities.sellers, ["Lisa Annanregion", "Mia Exempelsson"]);
    expect(q.hide("Hur går det för Lisa Annanregion och lisa?")).toBe("Hur går det för [namn] och [namn]?");
    expect(q.hide("och mia?")).toBe(`och ${q.aliasOf.get("A-11")}?`);
  });

  it("maps aliases split across stream chunks, and does not confuse 1 with 12", () => {
    const many = pseudonymsFor(Array.from({ length: 12 }, (_, i) => ({ id: `A-${100 + i}`, name: `Person${i + 1} Syntetisk` })));
    const r = streamRevealer(many);
    const out = ["Det var Sälj", "are 1", "2 som svarade; Säljare 1", " också."].map((c) => r.push(c)).join("") + r.flush();
    expect(out).toBe("Det var Person12 Syntetisk som svarade; Person1 Syntetisk också.");
  });

  it("stored per-dialogue texts lose the aliases of the run that wrote them", () => {
    expect(neutralizeStoredAliases("Säljare 3 skickade en offert.")).toBe("säljaren skickade en offert.");
  });
});

describe("sources", () => {
  it("stores the basis, the cited leads in citation order and only their sets", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["patterns"] }));
    expect(brief.leads.length).toBeGreaterThan(2);
    const sources = finalSources(brief, [3, 1]);
    expect(sources[0].kind).toBe("lead_basis");
    expect(sources.slice(1, 3).map((s) => s.id)).toEqual([brief.leads[2].id, brief.leads[0].id]);
    const cited = new Set([brief.leads[2].id, brief.leads[0].id]);
    for (const s of sources.slice(3)) {
      expect(s.kind).toBe("lead_set");
      expect((s as { threadIds: string[] }).threadIds.some((id) => cited.has(id))).toBe(true);
    }
    expect(JSON.stringify(sources)).not.toContain('"types"');
    expect(JSON.stringify(sources)).not.toContain('"quote"');
  });

  it("attaches the leads behind a pattern the answer describes – by its figure or its wording, without a citation", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["patterns"] }));
    const set = brief.sets.find((s) => s.id === "opportunity:unanswered_questions")!;
    const ids = (answer: string) => finalSources(brief, [], answer).map((s) => s.id);
    expect(ids(`Konkreta frågor saknade synligt svar i ${set.quote} dialoger.`)).toContain("opportunity:unanswered_questions");
    // No figure, no citation: the wording alone.
    expect(ids("Ibland lämnas kundens frågor utan synligt svar.")).toEqual(["basis", "opportunity:unanswered_questions"]);
    expect(ids("Inga siffror här.")).toEqual(["basis"]);
    // Nothing that cannot be stored (the matching rules stay on the server).
    expect(JSON.stringify(finalSources(brief, [], "frågor utan synligt svar"))).not.toMatch(/"mention"|"quote"|"types"/);
  });

  it("a figure that several patterns share is attributed by the answer's wording", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["patterns"] }));
    const unanswered = brief.sets.find((s) => s.id === "opportunity:unanswered_questions")!;
    const twin = { ...unanswered, id: "strength:interest_to_next_step", title: "Kundens intresse ledde till ett konkret nästa steg", mention: /intresse\S*[^.]{0,50}ledde[^.]{0,40}nästa steg/i };
    const withTwin = { ...brief, sets: [...brief.sets.filter((s) => s.id !== twin.id), twin] };
    const ids = finalSources(withTwin, [], `Konkreta frågor saknade synligt svar i ${unanswered.quote} dialoger.`).map((s) => s.id);
    expect(ids).toContain("opportunity:unanswered_questions");
    expect(ids).not.toContain("strength:interest_to_next_step");
  });

  it("observations get their leads too, and a pattern has one set even when it is also an observation", () => {
    const { rows, analyses } = dataset();
    const brief = buildBrief(briefInput({ rows, analyses, intents: ["overview", "patterns"] }));
    const ids = brief.sets.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("strength:interest_to_next_step");
    expect(brief.sets.find((s) => s.id === "strength:interest_to_next_step")!.count).toBe(8);
  });

  it("stores the facts the answer used, and the steps the user can choose", () => {
    const { rows } = dataset();
    const brief = buildBrief(briefInput({ rows, intents: ["response_time"] }));
    const action = { kind: "lead_action" as const, id: "action", steps: [{ action: "sync" as const, label: "Uppdatera från HubSpot", detail: "", inboxIds: ["100"] }], scope: { regionId: R_A, inboxId: "100", preset: "custom" as const, from: "2026-09-04", to: TODAY }, question: "Hur är svarstiden?" };
    const sources = finalSources(brief, [], "23 av 24 leads har ett registrerat säljsvar, och 6 av 23 fick svar inom en arbetstimme.", action);
    const facts = (sources[0] as { facts: { label: string }[] }).facts.map((f) => f.label);
    expect(facts).toEqual(expect.arrayContaining(["Leads med registrerat säljsvar", "Första registrerade säljsvar inom 1 arbetstimme"]));
    expect(facts).not.toContain("Leads utan registrerat säljsvar i HubSpot");
    expect(sources.at(-1)).toEqual(action);
  });
});

describe("verified facts across turns", () => {
  const p = pseudonymsFor(entities.sellers);
  const alias = p.aliasOf.get("A-11")!;
  const ctx = { selection: "Alingsås Volkswagen PB · Mia Exempelsson", period: "4 sep – 3 okt (Senaste 30 dagarna)", scope: { regionId: R_A, inboxId: "100", sellerId: "A-11" } };

  it("keeps names out of the brief and carries a fact the current brief does not compute", () => {
    const earlier = currentFacts([{ id: "m1", label: `Median svarstid, arbetstid, för ${alias}`, value: "5 min", population: "leads där säljaren gav det första registrerade säljsvaret", origin: "fakta" }], ctx, p.reveal);
    expect(earlier[0].label).toBe("Median svarstid, arbetstid, för Mia Exempelsson");
    const section = earlierFactsSection(earlier, [], p.hide)!;
    expect(section).toContain(`[Alingsås Volkswagen PB · ${alias} · 4 sep – 3 okt (Senaste 30 dagarna)] Median svarstid, arbetstid, för ${alias}: 5 min`);
    expect(section).not.toMatch(/Mia|Exempelsson/);
    expect(section).toMatch(/Rätta, ersätt eller omtolka dem aldrig/);
  });

  it("leaves out a fact computed again with the same value, and states a changed value explicitly", () => {
    const fact = (value: number) => ({ label: "Leads", value: String(value), population: "leads i urvalet", selection: "Region Alingsås", period: "4 sep – 3 okt (Senaste 30 dagarna)", scope: { regionId: R_A, inboxId: null, sellerId: null } });
    expect(earlierFactsSection([fact(293)], [fact(293)], (t) => t)).toBeNull();
    expect(earlierFactsSection([fact(293)], [fact(301)], (t) => t)).toMatch(/Leads: tidigare 293, nu 301 enligt underlaget ovan/);
    // Another period is another fact: never presented as a change.
    expect(earlierFactsSection([fact(293)], [{ ...fact(301), period: "27 sep – 3 okt (Senaste 7 dagarna)" }], (t) => t)).not.toMatch(/tidigare 293, nu/);
  });

  it("drops facts for a selection the user can no longer see, and keeps the newest of each measure", () => {
    const f = (inboxId: string, value: string) => ({ label: "Leads", value, population: "leads i urvalet", selection: inboxId, period: "p", scope: { regionId: null, inboxId, sellerId: null } });
    expect(visibleFacts([f("100", "1"), f("999", "2")], entities).map((x) => x.selection)).toEqual(["100"]);
    expect(earlierFactsSection([f("100", "1"), f("100", "7")], [], (t) => t)).toMatch(/Leads: 7 /);
  });

  it("a long chain: facts from turn 1 reach turn 5 although turns 2–4 load other modules", () => {
    const { rows, analyses } = dataset();
    const turns: ("source" | "response_time" | "patterns" | "examples" | "comparison")[][] = [["source"], ["response_time"], ["patterns"], ["examples"], ["comparison"]];
    let stored: ReturnType<typeof currentFacts> = [];
    let lastText = "";
    for (const [i, intents] of turns.entries()) {
      const brief = buildBrief(briefInput({ rows, analyses, intents, earlierFacts: stored }));
      lastText = brief.text;
      // Each answer quotes the first registered figure of its brief.
      const first = brief.facts.find((x) => /\d/.test(x.value));
      if (i === 0) expect(first?.label).toBe("Leads från Blocket");
      stored = [...stored, ...usedFacts(brief.facts, first ? `${first.value}${first.of !== undefined ? ` av ${first.of}` : ""}` : "")];
    }
    expect(lastText).toMatch(/## Tidigare verifierade fakta i konversationen[\s\S]*Leads från Blocket: 18 av 24/);
  });
});

describe("missing lead material", () => {
  const period = resolvePeriod("30d", TODAY);
  const base = {
    selection: "Alingsås Audi",
    scopeInboxes: [{ id: "100", name: "Alingsås Audi" }],
    coverage: fullCoverage,
    rows: [] as LeadRow[],
    analyses: null as Map<string, StoredAnalysis> | null,
    sellerId: null,
    intents: ["patterns"] as LeadChatState["intents"],
    period,
    scope: { regionId: R_A, inboxId: "100" },
    question: "Vilka förbättringsområden ser du i Audi?",
    canSync: true,
    canAnalyse: true,
    maxDays: 92,
    today: TODAY,
  };
  const replied = (id: string) => row({ threadId: id, inboxId: "100" });

  it("A: nothing fetched – explains it and offers the fetch first, then the analysis", () => {
    const g = findGaps({ ...base, coverage: { ...fullCoverage, complete: false, completeInboxes: 0, coveredDays: 0, missing: [{ inboxId: "100", name: "Alingsås Audi", coveredDays: 0 }] }, analyses: new Map() });
    expect(g.answer).toMatch(/inte hämtad från HubSpot för Alingsås Audi ännu.*Vill du hämta den/);
    expect(g.action?.steps.map((s) => s.action)).toEqual(["sync", "analyse"]);
    expect(g.action?.question).toBe(base.question);
    expect(g.action?.scope).toMatchObject({ inboxId: "100", preset: "custom", from: period.from, to: period.to });
  });

  it("B: fetched but not analysed – answers like a colleague and offers the analysis", () => {
    const g = findGaps({ ...base, rows: [replied("1"), replied("2")], analyses: new Map() });
    expect(g.answer).toBe(
      `Jag har leadstatistiken för ${periodLabel(period.from, period.to)} i Alingsås Audi, men dialogerna är inte analyserade ännu (2 dialoger med säljarsvar). Vill du analysera dem så att jag kan titta på återkommande styrkor och utvecklingsområden?`,
    );
    expect(g.action?.steps).toMatchObject([{ action: "analyse", label: "Analysera dialogerna", inboxIds: ["100"] }]);
  });

  it("C: both needed – the fetch comes first, then the analysis", () => {
    const partial = { ...fullCoverage, complete: false, completeInboxes: 0, coveredDays: 10, missing: [{ inboxId: "100", name: "Alingsås Audi", coveredDays: 10 }] };
    const g = findGaps({ ...base, coverage: partial, rows: [replied("1")], analyses: new Map() });
    expect(g.action?.steps.map((s) => s.action)).toEqual(["sync", "analyse"]);
    expect(g.answer).toMatch(/uppdateras först.*i den ordning/);
  });

  it("partly analysed, or a broader question: Folke answers and the step is offered under the answer", () => {
    const analyses = new Map([["1", {} as StoredAnalysis]]);
    const g = findGaps({ ...base, intents: ["overview"], rows: [replied("1"), replied("2")], analyses });
    expect(g.answer).toBeNull();
    expect(g.note).toMatch(/1 av 2 dialoger med säljarsvar är inte AI-analyserade/);
    expect(g.action?.steps.map((s) => s.action)).toEqual(["analyse"]);
  });

  it("today alone not being fetched yet is not a gap worth a step", () => {
    const todayMissing = { ...fullCoverage, complete: false, completeInboxes: 0, coveredDays: 29, totalDays: 30, missing: [{ inboxId: "100", name: "Alingsås Audi", coveredDays: 29 }] };
    const analyses = new Map([["1", {} as StoredAnalysis], ["2", {} as StoredAnalysis]]);
    expect(findGaps({ ...base, intents: ["overview"], coverage: todayMissing, rows: [replied("1"), replied("2")], analyses }).action).toBeNull();
    // A period that ended earlier must be complete.
    const last = resolvePeriod("last_month", TODAY);
    expect(findGaps({ ...base, period: last, intents: ["overview"], coverage: { ...todayMissing, totalDays: 30 }, rows: [replied("1"), replied("2")], analyses }).action?.steps[0].action).toBe("sync");
  });

  it("nothing is offered that cannot run: AI off, no HubSpot, a too long period, or a fact question", () => {
    expect(findGaps({ ...base, canAnalyse: false, rows: [replied("1")], analyses: new Map() })).toMatchObject({ action: null, answer: expect.stringMatching(/inte aktiverad/) });
    const notFetched = { ...fullCoverage, complete: false, completeInboxes: 0, coveredDays: 0, missing: [{ inboxId: "100", name: "Alingsås Audi", coveredDays: 0 }] };
    expect(findGaps({ ...base, canSync: false, canAnalyse: false, coverage: notFetched, analyses: new Map() }).action).toBeNull();
    const long = resolvePeriod("custom", TODAY, "2026-01-01", "2026-09-30");
    expect(findGaps({ ...base, period: long, coverage: notFetched, analyses: new Map() })).toMatchObject({ action: null, answer: expect.stringMatching(/för lång/) });
    expect(findGaps({ ...base, intents: ["response_time"], rows: [replied("1")], analyses: null }).action).toBeNull();
  });
});
