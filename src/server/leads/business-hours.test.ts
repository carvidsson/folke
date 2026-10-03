import { describe, expect, it } from "vitest";

import {
  arrivalWindow,
  businessMinutesBetween,
  calendarMinutesBetween,
  startOfStockholmDate,
  stockholmInstant,
  stockholmTime,
} from "./business-hours";

const d = (iso: string) => new Date(iso);

describe("Stockholm time", () => {
  it("converts wall-clock times in winter (UTC+1) and summer (UTC+2)", () => {
    expect(stockholmInstant(2026, 1, 15, 9).toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(stockholmInstant(2026, 7, 1, 9).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(stockholmTime(d("2026-07-01T07:00:00Z"))).toMatchObject({ hour: 9, weekday: 3 });
  });

  it("finds the start of a calendar date across the DST switches", () => {
    expect(startOfStockholmDate("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfStockholmDate("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(startOfStockholmDate("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfStockholmDate("2026-10-26").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("arrival window", () => {
  it("separates business hours, weekday evenings and weekends at the edges", () => {
    // Wednesday 2026-09-02 (UTC+2)
    expect(arrivalWindow(d("2026-09-02T06:59:59Z"))).toBe("weekday_off_hours"); // 08:59:59
    expect(arrivalWindow(d("2026-09-02T07:00:00Z"))).toBe("business_hours"); // 09:00
    expect(arrivalWindow(d("2026-09-02T15:59:59Z"))).toBe("business_hours"); // 17:59:59
    expect(arrivalWindow(d("2026-09-02T16:00:00Z"))).toBe("weekday_off_hours"); // 18:00
    expect(arrivalWindow(d("2026-09-05T10:00:00Z"))).toBe("weekend"); // Saturday
    // Sunday 23:30 local is Sunday, although it is Monday nowhere yet in UTC terms.
    expect(arrivalWindow(d("2026-09-06T21:30:00Z"))).toBe("weekend");
    // Monday 00:30 local is Sunday 22:30 UTC.
    expect(arrivalWindow(d("2026-09-06T22:30:00Z"))).toBe("weekday_off_hours");
  });
});

describe("business minutes", () => {
  it("counts only Monday–Friday 09–18 Stockholm time", () => {
    // Same day, inside.
    expect(businessMinutesBetween(d("2026-09-02T08:00:00Z"), d("2026-09-02T08:45:00Z"))).toBe(45);
    // Evening lead answered next morning 09:30: 30 minutes.
    expect(businessMinutesBetween(d("2026-09-02T18:00:00Z"), d("2026-09-03T07:30:00Z"))).toBe(30);
    // Friday 17:30 → Monday 09:30: 30 + 30.
    expect(businessMinutesBetween(d("2026-09-04T15:30:00Z"), d("2026-09-07T07:30:00Z"))).toBe(60);
    // Saturday → Monday 09:30.
    expect(businessMinutesBetween(d("2026-09-05T10:00:00Z"), d("2026-09-07T07:30:00Z"))).toBe(30);
    // Answered during the weekend, before business hours resume: 0.
    expect(businessMinutesBetween(d("2026-09-05T10:00:00Z"), d("2026-09-05T12:00:00Z"))).toBe(0);
    // A full working week is 5 × 9 hours.
    expect(businessMinutesBetween(d("2026-09-06T22:00:00Z"), d("2026-09-13T22:00:00Z"))).toBe(5 * 9 * 60);
  });

  it("is correct across the spring and autumn DST switches", () => {
    // Friday 27 March 17:00 (UTC+1) → Monday 30 March 10:00 (UTC+2): 60 + 60.
    expect(businessMinutesBetween(d("2026-03-27T16:00:00Z"), d("2026-03-30T08:00:00Z"))).toBe(120);
    // Friday 23 October 17:00 (UTC+2) → Monday 26 October 10:00 (UTC+1): 60 + 60.
    expect(businessMinutesBetween(d("2026-10-23T15:00:00Z"), d("2026-10-26T09:00:00Z"))).toBe(120);
    // Calendar minutes over the autumn weekend include the extra hour.
    expect(calendarMinutesBetween(d("2026-10-23T15:00:00Z"), d("2026-10-26T09:00:00Z"))).toBe(66 * 60);
  });

  it("gives 0 for reversed or equal times and handles long gaps", () => {
    expect(businessMinutesBetween(d("2026-09-02T09:00:00Z"), d("2026-09-02T08:00:00Z"))).toBe(0);
    expect(calendarMinutesBetween(d("2026-09-02T09:00:00Z"), d("2026-09-02T08:00:00Z"))).toBe(0);
    expect(businessMinutesBetween(d("2026-01-05T08:00:00Z"), d("2026-01-05T08:00:00Z"))).toBe(0);
    // Two years still terminates (bounded loop).
    expect(businessMinutesBetween(d("2025-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z"))).toBeGreaterThan(200_000);
  });
});
