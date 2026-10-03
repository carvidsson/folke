import "server-only";

import {
  SMALL_SAMPLE_LEADS,
  SMALL_SAMPLE_SELLER,
  type ArrivalWindow,
  type Distribution,
  type LeadFacts,
  type LeadRow,
  type ResponseStats,
  type SellerFacts,
} from "@/lib/leads/types";

import { stockholmTime } from "./business-hours";

/** Deterministic statistics over normalized leads. No AI is involved here. */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function responseStats(rows: LeadRow[]): ResponseStats {
  const answered = rows.filter((r) => r.status === "registered_reply" && r.businessMinutes !== null && r.calendarMinutes !== null);
  const business = answered.map((r) => r.businessMinutes!);
  // Counts, not shares: the page shows "X av N" so the population is explicit.
  const within = (limit: number) => business.filter((m) => m <= limit).length;
  return {
    n: answered.length,
    medianCalendarMinutes: median(answered.map((r) => r.calendarMinutes!)),
    medianBusinessMinutes: median(business),
    withinOneBusinessHour: within(60),
    withinFourBusinessHours: within(240),
  };
}

function distribution(values: (string | null)[], unknown: string): Distribution[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? unknown, (counts.get(v ?? unknown) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "sv"));
}

const WINDOWS: ArrivalWindow[] = ["business_hours", "weekday_off_hours", "weekend"];

export function leadFacts(rows: LeadRow[]): LeadFacts {
  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const r of rows) {
    const t = stockholmTime(new Date(r.arrivedAt));
    byHour[t.hour]++;
    byWeekday[t.weekday - 1]++;
  }
  const count = (f: (r: LeadRow) => boolean) => rows.filter(f).length;
  const answered = rows.filter((r) => r.status === "registered_reply");
  return {
    leads: rows.length,
    bySource: distribution(rows.map((r) => r.source), "Okänd källa"),
    byChannel: distribution(
      rows.map((r) => ({ form: "Formulär", email: "E-post", other: "Annan kanal" })[r.channel]),
      "Annan kanal",
    ),
    byArrivalWindow: Object.fromEntries(WINDOWS.map((w) => [w, count((r) => r.arrivalWindow === w)])) as Record<ArrivalWindow, number>,
    byHour,
    byWeekday,
    status: {
      registered_reply: answered.length,
      no_registered_reply: count((r) => r.status === "no_registered_reply"),
      uncertain: count((r) => r.status === "uncertain"),
    },
    noReplyOpen: count((r) => r.status === "no_registered_reply" && r.threadOpen),
    noReplyClosed: count((r) => r.status === "no_registered_reply" && !r.threadOpen),
    response: responseStats(rows),
    responseByArrivalWindow: Object.fromEntries(
      WINDOWS.map((w) => [w, responseStats(rows.filter((r) => r.arrivalWindow === w))]),
    ) as Record<ArrivalWindow, ResponseStats>,
    customerWroteLast: {
      total: answered.filter((r) => r.customerWroteLast).length,
      open: answered.filter((r) => r.customerWroteLast && r.threadOpen).length,
      closed: answered.filter((r) => r.customerWroteLast && !r.threadOpen).length,
    },
    owner: {
      same: answered.filter((r) => r.ownerId && r.ownerId === r.responderId).length,
      different: answered.filter((r) => r.ownerId && r.responderId && r.ownerId !== r.responderId).length,
      noOwner: answered.filter((r) => !r.ownerId).length,
    },
    movedIntoInbox: count((r) => r.movedIntoInbox),
    smallSample: rows.length < SMALL_SAMPLE_LEADS,
  };
}

/** Per seller: who owns leads, who answers first, and how fast. Ordered by name – never by performance. */
export function sellerFacts(rows: LeadRow[], names: Map<string, string>): SellerFacts[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.ownerId) ids.add(r.ownerId);
    if (r.responderId) ids.add(r.responderId);
  }
  return [...ids]
    .map((id) => {
      const responses = rows.filter((r) => r.responderId === id);
      return {
        id,
        name: names.get(id) ?? "Okänd användare",
        ownedLeads: rows.filter((r) => r.ownerId === id).length,
        firstResponses: responses.length,
        response: responseStats(responses),
        smallSample: responses.length < SMALL_SAMPLE_SELLER,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}
