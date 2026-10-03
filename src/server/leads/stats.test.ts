import { describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";

import { leadFacts, median, responseStats, sellerFacts } from "./stats";

function row(partial: Partial<LeadRow>): LeadRow {
  return {
    threadId: "1",
    arrivedAt: "2026-09-02T08:00:00.000Z",
    arrivalWindow: "business_hours",
    channel: "form",
    source: "Blocket",
    formName: null,
    vehicle: null,
    status: "registered_reply",
    firstResponseAt: null,
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
    inboxId: "900001",
    latestMessageAt: null,
    lastCustomerMessageAt: null,
    firstSellerAfterCustomerAt: null,
    followedUp: false,
    vehicleBrand: null,
    vehicleModel: null,
    vehicleSource: null,
    regnrKind: null,
    ...partial,
  };
}

describe("lead statistics", () => {
  it("computes medians for odd, even and empty samples", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("uses only leads with a registered reply for response times", () => {
    const stats = responseStats([
      row({ businessMinutes: 30, calendarMinutes: 30 }),
      row({ businessMinutes: 90, calendarMinutes: 900 }),
      row({ businessMinutes: 300, calendarMinutes: 300 }),
      row({ status: "no_registered_reply", businessMinutes: null, calendarMinutes: null }),
      row({ status: "uncertain", businessMinutes: null, calendarMinutes: null }),
    ]);
    expect(stats).toEqual({
      n: 3,
      medianCalendarMinutes: 300,
      medianBusinessMinutes: 90,
      withinOneBusinessHour: 1,
      withinFourBusinessHours: 2,
    });
    expect(responseStats([])).toMatchObject({ n: 0, medianBusinessMinutes: null, withinOneBusinessHour: 0 });
  });

  it("summarises sources, arrival, status and owners", () => {
    const rows = [
      row({ arrivedAt: "2026-09-02T08:00:00.000Z" }), // Wed 10
      row({ arrivedAt: "2026-09-05T10:00:00.000Z", arrivalWindow: "weekend", source: "Wayke", responderId: "A-2" }), // Sat 12
      row({ arrivedAt: "2026-09-02T18:00:00.000Z", arrivalWindow: "weekday_off_hours", source: null, channel: "email", status: "no_registered_reply", responderId: null, threadOpen: true, calendarMinutes: null, businessMinutes: null }),
    ];
    const facts = leadFacts(rows);
    expect(facts.leads).toBe(3);
    expect(facts.bySource).toEqual([
      { label: "Blocket", count: 1 },
      { label: "Okänd källa", count: 1 },
      { label: "Wayke", count: 1 },
    ]);
    expect(facts.byArrivalWindow).toEqual({ business_hours: 1, weekday_off_hours: 1, weekend: 1 });
    expect(facts.byHour[10]).toBe(1);
    expect(facts.byHour[12]).toBe(1);
    expect(facts.byHour[20]).toBe(1);
    expect(facts.byWeekday).toEqual([0, 0, 2, 0, 0, 1, 0]);
    expect(facts.status).toEqual({ registered_reply: 2, no_registered_reply: 1, uncertain: 0 });
    expect(facts.noReplyOpen).toBe(1);
    expect(facts.owner).toEqual({ same: 1, different: 1, noOwner: 0 });
    expect(facts.smallSample).toBe(true);
  });

  it("lists sellers by name, never by performance, and flags small samples", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row({ responderId: "A-2", ownerId: "A-2", businessMinutes: 500 })),
      row({ responderId: "A-1", businessMinutes: 5 }),
    ];
    const sellers = sellerFacts(rows, new Map([["A-1", "Örjan Test"], ["A-2", "Anna Test"]]));
    expect(sellers.map((s) => s.name)).toEqual(["Anna Test", "Örjan Test"]);
    expect(sellers[0]).toMatchObject({ firstResponses: 6, ownedLeads: 6, smallSample: false });
    expect(sellers[1]).toMatchObject({ firstResponses: 1, smallSample: true });
    expect(sellerFacts([row({ responderId: "A-9", ownerId: null })], new Map())[0].name).toBe("Okänd användare");
  });
});
