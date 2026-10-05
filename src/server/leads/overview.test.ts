import { describe, expect, it } from "vitest";

import { previousPeriod, resolvePeriod } from "@/lib/leads/periods";
import type { LeadRow } from "@/lib/leads/types";
import type { StoredAnalysis } from "@/server/data/leads";

import { coverage, coveredDays } from "./coverage";
import { deriveThreadTemplate } from "./hubspot-link";
import type { ParsedLead } from "./lead-fields";
import { regnrKind } from "./lead-fields";
import { brandRows, buildInsights, leadMetrics, loadPattern, responseBucket, responseDistribution, sourceRows, trendMonths, virtualStats } from "./overview";
import { identifyVehicle } from "./vehicle";

/** Deterministic parts of the overview (ADR-048). Synthetic data only. */

function row(p: Partial<LeadRow>): LeadRow {
  return {
    threadId: "1",
    inboxId: "900001",
    arrivedAt: "2026-09-02T08:00:00.000Z",
    arrivalWindow: "business_hours",
    channel: "form",
    source: "Blocket",
    formName: null,
    vehicle: null,
    status: "registered_reply",
    firstResponseAt: "2026-09-02T08:30:00.000Z",
    calendarMinutes: 30,
    businessMinutes: 30,
    ownerId: "A-1",
    responderId: "A-1",
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
    vehicleBrand: null,
    vehicleModel: null,
    vehicleSource: null,
    regnrKind: null,
    ...p,
  };
}

describe("periods", () => {
  const today = "2026-10-03";
  it("resolves presets and rejects bad custom input", () => {
    expect(resolvePeriod("7d", today)).toMatchObject({ from: "2026-09-27", to: "2026-10-03" });
    // The default is the last 7 days; the last 30 days is a preset of its own.
    expect(resolvePeriod(undefined, today)).toMatchObject({ preset: "7d", from: "2026-09-27", to: "2026-10-03" });
    expect(resolvePeriod("30d", today)).toMatchObject({ preset: "30d", from: "2026-09-04", to: "2026-10-03" });
    expect(resolvePeriod("this_month", today)).toMatchObject({ from: "2026-10-01", to: "2026-10-03" });
    expect(resolvePeriod("last_month", today)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolvePeriod("custom", today, "2026-09-10", "2026-09-20")).toMatchObject({ preset: "custom", from: "2026-09-10", to: "2026-09-20" });
    // Future, reversed and invalid dates fall back to the default, the last 7 days.
    for (const [f, t] of [["2026-09-10", "2026-11-01"], ["2026-09-20", "2026-09-10"], ["2026-02-31", "2026-03-01"]]) {
      expect(resolvePeriod("custom", today, f, t).preset).toBe("7d");
    }
  });

  it("compares with the previous corresponding period", () => {
    expect(previousPeriod(resolvePeriod("30d", "2026-10-03"))).toMatchObject({ from: "2026-08-05", to: "2026-09-03" });
    expect(previousPeriod(resolvePeriod("7d", "2026-10-03"))).toMatchObject({ from: "2026-09-20", to: "2026-09-26" });
    // This month (1–3 Oct) vs 1–3 Sep; last month vs the whole month before.
    expect(previousPeriod(resolvePeriod("this_month", "2026-10-03"))).toMatchObject({ from: "2026-09-01", to: "2026-09-03" });
    expect(previousPeriod(resolvePeriod("last_month", "2026-10-03"))).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    // 31 March: 1–31 Mar vs 1–28 Feb (never into March).
    expect(previousPeriod(resolvePeriod("this_month", "2026-03-31"))).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("coverage", () => {
  const inboxes = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  it("counts only days a complete sync covered, up to the day it ran", () => {
    const syncs = [
      { inboxId: "a", from: "2026-09-01", to: "2026-09-30", syncedAt: "2026-09-20T08:00:00Z", complete: true },
      { inboxId: "a", from: "2026-09-21", to: "2026-09-30", syncedAt: "2026-10-01T08:00:00Z", complete: false },
    ];
    // Synced 20 Sep: 1–20 covered; the later, incomplete sync adds nothing.
    expect(coveredDays(syncs, "2026-09-01", "2026-09-30")).toBe(20);
  });

  it("requires every inbox for the scope, and never calls a partial period complete", () => {
    const syncs = [
      { inboxId: "a", from: "2026-09-01", to: "2026-09-30", syncedAt: "2026-10-01T08:00:00Z", complete: true },
      { inboxId: "b", from: "2026-09-15", to: "2026-09-30", syncedAt: "2026-10-01T09:00:00Z", complete: true },
    ];
    const c = coverage(inboxes, syncs, "2026-09-01", "2026-09-30");
    expect(c).toMatchObject({ inboxes: 2, completeInboxes: 1, coveredDays: 16, totalDays: 30, complete: false });
    expect(c.missing).toEqual([{ inboxId: "b", name: "B", coveredDays: 16 }]);
    expect(c.oldestSyncAt).toBe("2026-10-01T08:00:00.000Z");
    expect(coverage(inboxes, [], "2026-09-01", "2026-09-30")).toMatchObject({ complete: false, newestSyncAt: null, oldestSyncAt: null });
  });
});

describe("metrics, cars, load and trend", () => {
  const rows = [
    row({ threadId: "1", vehicleBrand: "Volkswagen", vehicleModel: "ID.4", vehicleSource: "fields" }),
    row({ threadId: "2", vehicleBrand: "Volkswagen", vehicleModel: null, vehicleSource: "page", businessMinutes: 90, calendarMinutes: 90 }),
    row({ threadId: "3", status: "no_registered_reply", firstResponseAt: null, businessMinutes: null, calendarMinutes: null, arrivalWindow: "weekend", arrivedAt: "2026-09-05T10:00:00.000Z" }),
    row({ threadId: "4", customerWroteLast: true, arrivalWindow: "weekday_off_hours", arrivedAt: "2026-09-02T18:00:00.000Z" }),
  ];

  it("computes the headline figures with explicit populations", () => {
    expect(leadMetrics(rows)).toEqual({
      leads: 4,
      registeredReply: 3,
      noRegisteredReply: 1,
      uncertain: 0,
      medianBusinessMinutes: 30,
      medianCalendarMinutes: 30,
      withinOneBusinessHour: 2,
      customerWroteLast: 1,
      outsideBusinessHours: 2,
    });
  });

  it("groups cars by identified brand and model and reports what could not be identified", () => {
    const { brands, quality } = brandRows(rows);
    expect(brands.map((b) => [b.name, b.leads])).toEqual([
      ["Volkswagen", 2],
      ["Ej identifierat märke", 2],
    ]);
    expect(brands[0].models.map((m) => [m.name, m.leads])).toEqual([
      ["ID.4", 1],
      ["Ej identifierad modell", 1],
    ]);
    expect(quality).toEqual({ leads: 4, brandIdentified: 2, modelIdentified: 1, bySource: [{ source: "fields", count: 1 }, { source: "page", count: 1 }] });
  });

  it("counts arrivals per weekday and time band", () => {
    const load = loadPattern(rows, () => "Region");
    // Wednesday 10:00 (×2), Wednesday 20:00, Saturday 12:00 Stockholm time.
    expect(load.grid[2][load.bands.indexOf("09–12")]).toBe(2);
    expect(load.grid[2][load.bands.indexOf("18–21")]).toBe(1);
    expect(load.grid[5][load.bands.indexOf("12–15")]).toBe(1);
    expect(load.byGroup).toEqual([{ name: "Region", leads: 4, businessHours: 2, weekdayOffHours: 1, weekend: 1 }]);
  });

  it("marks months that are only partly fetched", () => {
    const syncs = [{ inboxId: "900001", from: "2026-09-15", to: "2026-10-03", syncedAt: "2026-10-03T07:00:00Z", complete: true }];
    const trend = trendMonths(rows, [{ id: "900001", name: "A" }], syncs, "2026-10-03", 3);
    expect(trend.map((t) => [t.month, t.coveredDays, t.totalDays])).toEqual([
      ["2026-08", 0, 31],
      ["2026-09", 16, 30],
      ["2026-10", 3, 3],
    ]);
  });
});

describe("observations", () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const stored = (assessment: Partial<NonNullable<StoredAnalysis["classification"]["assessment"]>>, purchaseIntent: "clear" | "interested" = "interested"): StoredAnalysis => ({
    fingerprint: "x",
    sourceLatestMessageAt: null,
    situationState: null,
    analysedAt: "",
    classification: {
      intent: "price_or_offer",
      purchaseIntent,
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
        goal: "Få en offert.",
        questions: [],
        signals: [],
        timeframe: "",
        budget: "",
        objections: [],
        infoNeeded: [],
        progress: "moved_forward",
        progressReason: "",
        missedOpportunity: "no",
        missedReason: "",
        continuation: "visible",
        agreedNextStep: false,
        opportunities: [],
        strengths: [],
        ...assessment,
      },
    },
  });

  it("shows only what passes a threshold, with its basis and drill-down", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ threadId: String(i + 1) }));
    const analyses = new Map<string, StoredAnalysis>();
    rows.forEach((r, i) =>
      analyses.set(
        r.threadId,
        stored({
          strengths: i < 5 ? ["interest_to_next_step"] : [],
          opportunities: i >= 5 && i <= 7 ? ["competitor_offer"] : i === 9 ? ["visit_interest"] : [],
          continuation: i >= 8 ? "not_determinable" : "visible",
        }),
      ),
    );
    const insights = buildInsights(rows, analyses, now);
    expect(insights.map((i) => i.id)).toEqual(["strength:interest_to_next_step", "opportunity:competitor_offer", "undetermined"]);
    // Two of a kind is too thin (threshold 3): the single visit_interest gives no observation.
    expect(insights.find((i) => i.id === "undetermined")).toMatchObject({ tone: "observation", kind: "classification", basis: "4 av 12 AI-analyserade dialoger", filter: "undetermined" });
    const undetermined = insights.find((i) => i.id === "undetermined")!.body;
    expect(undetermined).toMatch(/går inte att avgöra|Folke kan inte avgöra/);
    // Never a failure, never an assumed handover.
    for (const i of insights) expect(`${i.title} ${i.body}`).not.toMatch(/offert saknas|följde inte upp|tappade fart|ingen fortsättning|fortsätter utanför HubSpot/i);
  });

  it("needs at least ten analysed dialogues before classification-based observations", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ threadId: String(i + 1) }));
    const analyses = new Map(rows.map((r) => [r.threadId, stored({ strengths: ["interest_to_next_step"] })]));
    expect(buildInsights(rows, analyses, now)).toEqual([]);
  });

  it("a customer who wrote last after an agreed next step is not waiting; one with an open question is", () => {
    const old = "2026-09-03T08:00:00Z";
    const rows = [
      row({ threadId: "1", customerWroteLast: true, lastCustomerMessageAt: old }),
      row({ threadId: "2", customerWroteLast: true, lastCustomerMessageAt: old }),
      row({ threadId: "3", customerWroteLast: true, lastCustomerMessageAt: old }),
    ];
    const analyses = new Map([
      ["1", stored({ agreedNextStep: true }, "clear")],
      ["2", stored({ questions: [{ text: "Finns bilen kvar?", answered: "not_due" }] })],
      ["3", stored({}, "clear")],
    ]);
    const w = buildInsights(rows, analyses, now).find((i) => i.id === "waiting_customer");
    expect(w?.body).toMatch(/^I 2 leads skrev kunden sist/);
  });
});

describe("statuses, sources, response times and Virtuell sum exactly", () => {
  const rows = [
    row({ threadId: "1", source: "Blocket", regnrKind: "virtual", vehicleBrand: "Volkswagen", vehicleModel: "ID.4" }),
    row({ threadId: "2", source: "Blocket", regnrKind: "plate", vehicleBrand: "Volkswagen", vehicleModel: "Golf", businessMinutes: 0, arrivalWindow: "weekend" }),
    row({ threadId: "3", source: "Hemsida", regnrKind: null, businessMinutes: 0 }),
    row({ threadId: "4", source: null, status: "no_registered_reply", firstResponseAt: null, businessMinutes: null, calendarMinutes: null }),
    // An automated message came before the seller's reply (5 of 1 277 real leads): its own status.
    row({ threadId: "5", source: "Wayke", status: "uncertain", firstResponseAt: null, businessMinutes: null, calendarMinutes: null, regnrKind: "virtual", vehicleBrand: "Audi", vehicleModel: null }),
    row({ threadId: "6", source: "E-post", businessMinutes: 600, regnrKind: "other" }),
  ];

  it("the three reply statuses always sum to the number of leads (regression: 476 + 121 ≠ 598)", () => {
    const m = leadMetrics(rows);
    expect(m.registeredReply + m.noRegisteredReply + m.uncertain).toBe(m.leads);
    expect(m.uncertain).toBe(1);
  });

  it("sources come from the data, unknown last, and sum to the leads", () => {
    const s = sourceRows(rows);
    expect(s).toEqual([
      { name: "Blocket", leads: 2 },
      { name: "E-post", leads: 1 },
      { name: "Hemsida", leads: 1 },
      { name: "Wayke", leads: 1 },
      { name: "Okänd källa", leads: 1 },
    ]);
    expect(s.reduce((n, x) => n + x.leads, 0)).toBe(rows.length);
  });

  it("every lead with a registered reply lands in exactly one response bucket; others in none", () => {
    const d = responseDistribution(rows, null);
    expect(d.replied).toBe(4);
    expect(d.buckets.reduce((n, b) => n + b.count, 0)).toBe(d.replied);
    // 0 business minutes outside business hours is "before open", during business hours it is 0–15.
    expect(d.buckets.find((b) => b.id === "before_open")!.count).toBe(1);
    expect(d.buckets.find((b) => b.id === "0_15")!.count).toBe(1);
    expect(d.buckets.find((b) => b.id === "over_1d")!.count).toBe(1);
    expect(responseBucket({ businessMinutes: 540, arrivalWindow: "business_hours" })).toBe("4h_1d");
    expect(responseBucket({ businessMinutes: 541, arrivalWindow: "business_hours" })).toBe("over_1d");
  });

  it("counts Virtuell per brand and model without interpreting it", () => {
    const v = virtualStats(rows, null, [{ id: "900001", name: "Testinkorg" }]);
    expect(v).toMatchObject({ leads: 6, virtual: 2, plate: 1, other: 1, missing: 2 });
    expect(v.virtual + v.plate + v.other + v.missing).toBe(v.leads);
    expect(v.byInbox).toEqual([{ id: "900001", name: "Testinkorg", leads: 6, virtual: 2 }]);
    expect(v.byBrand).toEqual([
      { name: "Audi", leads: 1, virtual: 1, models: [{ name: "Ej identifierad modell", virtual: 1 }] },
      { name: "Volkswagen", leads: 2, virtual: 1, models: [{ name: "ID.4", virtual: 1 }] },
    ]);
    expect(v.compare.virtual).toMatchObject({ leads: 2, registeredReply: 1 });
  });

  it("parses the registration number field robustly", () => {
    expect(regnrKind("Virtuell")).toBe("virtual");
    expect(regnrKind(" VIRTUELL ")).toBe("virtual");
    expect(regnrKind("virtuell.")).toBe("virtual");
    expect(regnrKind("ABC 12D")).toBe("plate");
    expect(regnrKind("Okänt")).toBe("other");
    expect(regnrKind(null)).toBeNull();
  });
});

describe("car identification", () => {
  const lead = (p: Partial<ParsedLead>) => ({ brand: null, model: null, vehicle: null, page: null, ...p }) as ParsedLead;
  it("uses fields, then the listing title, then a campaign page – and never guesses", () => {
    expect(identifyVehicle(lead({ brand: "Volkswagen", model: "Tiguan", vehicle: "Volkswagen Tiguan Allspace" }))).toEqual({ brand: "Volkswagen", model: "Tiguan", source: "fields" });
    expect(identifyVehicle(lead({ brand: "Skoda", vehicle: "Skoda Kodiaq" }))).toEqual({ brand: "Škoda", model: "Kodiaq", source: "fields" });
    expect(identifyVehicle(lead({ brand: "Audi", model: "Q4 e-tron", vehicle: "Audi Q4" }))).toEqual({ brand: "Audi", model: "Q4 e-tron", source: "fields" });
    // Old SEAT naming: the model names a more specific brand of ours.
    expect(identifyVehicle(lead({ brand: "SEAT", vehicle: "Cupra Tavascan" }))).toEqual({ brand: "CUPRA", model: "Tavascan", source: "fields" });
    expect(identifyVehicle(lead({ vehicle: "Volkswagen ID.4" }))).toEqual({ brand: "Volkswagen", model: "ID.4", source: "subject" });
    expect(identifyVehicle(lead({ page: "https://www.example.com/kampanjer/skoda/skoda-elroq" }))).toEqual({ brand: "Škoda", model: "Elroq", source: "page" });
    expect(identifyVehicle(lead({ page: "https://www.example.com/kampanjer/volkswagen/id-3" }))).toEqual({ brand: "Volkswagen", model: "ID.3", source: "page" });
    // Brand only, ambiguous model, unknown and missing.
    expect(identifyVehicle(lead({ page: "https://www.example.com/varumarken/audi" }))).toEqual({ brand: "Audi", model: null, source: "page" });
    expect(identifyVehicle(lead({ brand: "Audi", model: "e-tron" }))).toEqual({ brand: "Audi", model: null, source: "fields" });
    expect(identifyVehicle(lead({ page: "https://www.example.com/kopa-bil/abc" }))).toEqual({ brand: null, model: null, source: null });
    expect(identifyVehicle(lead({ vehicle: "Fin bil till salu" }))).toEqual({ brand: null, model: null, source: null });
    expect(identifyVehicle(null)).toEqual({ brand: null, model: null, source: null });
  });
});

describe("HubSpot thread links", () => {
  const account = { portalId: "1234567", uiDomain: "app.hubspot.com" };
  const known = async (id: string) => id === "11152155016";
  it("derives a pattern only from a verified conversation URL", async () => {
    await expect(deriveThreadTemplate("https://app.hubspot.com/live-messages/1234567/inbox/11152155016?x=1#y", account, known)).resolves.toEqual({
      ok: true,
      template: "https://app.hubspot.com/live-messages/1234567/inbox/{threadId}",
      threadId: "11152155016",
    });
  });

  it("refuses other domains, other accounts and URLs without a real thread", async () => {
    for (const url of [
      "http://app.hubspot.com/live-messages/1234567/inbox/11152155016",
      "https://evil.example/live-messages/1234567/inbox/11152155016",
      "https://app.hubspot.com/live-messages/7654321/inbox/11152155016",
      "https://app.hubspot.com/live-messages/1234567/inbox/99999999999",
      "inte en adress",
    ]) {
      await expect(deriveThreadTemplate(url, account, known)).resolves.toMatchObject({ ok: false });
    }
  });
});
