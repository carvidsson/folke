import "server-only";

/**
 * Business hours for lead response times: Europe/Stockholm, Monday–Friday
 * 09:00–18:00. Swedish public holidays are NOT excluded (a documented
 * limitation – a lead on a holiday counts as arriving in business hours).
 *
 * All conversions go through the IANA time zone, so daylight saving time is
 * handled by the platform. The DST switches happen at 02:00/03:00 local
 * time, outside the business window, so a day's window is always 9 hours.
 */

export const TIME_ZONE = "Europe/Stockholm";
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 18;

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

export function stockholmTime(date: Date): LocalTime {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** Offset of Stockholm from UTC at an instant, in milliseconds. */
function offsetAt(ms: number): number {
  const t = stockholmTime(new Date(ms));
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant of a Stockholm wall-clock time (valid, non-skipped times). */
export function stockholmInstant(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess);
  // A second pass settles guesses that crossed a DST switch.
  ms = guess - offsetAt(ms);
  return new Date(ms);
}

export function isBusinessDay(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

export type ArrivalWindow = "business_hours" | "weekday_off_hours" | "weekend";

/** When a lead arrived, relative to business hours. */
export function arrivalWindow(date: Date): ArrivalWindow {
  const t = stockholmTime(date);
  if (!isBusinessDay(t.weekday)) return "weekend";
  return t.hour >= OPEN_HOUR && t.hour < CLOSE_HOUR ? "business_hours" : "weekday_off_hours";
}

const DAY_MS = 86_400_000;
/** Guard against runaway loops on bad input (≈ 3 years). */
const MAX_DAYS = 1100;

/**
 * Minutes of business time between two instants (0 if end ≤ start). A lead
 * that arrives on a Saturday and is answered on Monday 09:30 gets 30.
 */
export function businessMinutesBetween(start: Date, end: Date): number {
  const from = start.getTime();
  const to = end.getTime();
  if (!(to > from)) return 0;
  const first = stockholmTime(start);
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date(cursor);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const open = stockholmInstant(y, m, day, OPEN_HOUR).getTime();
    if (open >= to) break;
    if (isBusinessDay(((d.getUTCDay() + 6) % 7) + 1)) {
      const close = stockholmInstant(y, m, day, CLOSE_HOUR).getTime();
      const overlap = Math.min(close, to) - Math.max(open, from);
      if (overlap > 0) total += overlap;
    }
    cursor += DAY_MS;
  }
  return total / 60_000;
}

/** Calendar minutes between two instants (0 if end ≤ start). */
export function calendarMinutesBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

/** Start of a Stockholm calendar date ("YYYY-MM-DD") as an instant. */
export function startOfStockholmDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return stockholmInstant(y, m, d, 0, 0);
}
