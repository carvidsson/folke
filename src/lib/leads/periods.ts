import type { Period, PeriodPreset } from "./types";

/**
 * Periods for the lead analysis (Stockholm calendar dates, inclusive) and the
 * previous corresponding period used for comparison. Pure: used on the
 * server and in the browser.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

function parse(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}
export function addDays(d: string, n: number) {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
}
export function daysBetween(from: string, to: string) {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000) + 1;
}
function short(d: string) {
  const x = parse(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
}
export function periodLabel(from: string, to: string) {
  return from === to ? short(from) : `${short(from)} – ${short(to)}`;
}

export const PRESET_LABELS: Record<Exclude<PeriodPreset, "custom">, string> = {
  "7d": "Senaste 7 dagarna",
  "30d": "Senaste 30 dagarna",
  this_month: "Denna månad",
  last_month: "Föregående månad",
};

/** `today` is the Stockholm date "YYYY-MM-DD". No preset, or invalid custom input, gives the default: the last 7 days. */
export function resolvePeriod(preset: string | undefined, today: string, from?: string, to?: string): Period {
  const valid = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && iso(parse(d)) === d;
  switch (preset) {
    case "30d":
      return { preset, from: addDays(today, -29), to: today, label: PRESET_LABELS["30d"] };
    case "this_month":
      return { preset, from: `${today.slice(0, 7)}-01`, to: today, label: PRESET_LABELS.this_month };
    case "last_month": {
      const first = parse(`${today.slice(0, 7)}-01`);
      first.setUTCMonth(first.getUTCMonth() - 1);
      return { preset, from: iso(first), to: addDays(`${today.slice(0, 7)}-01`, -1), label: PRESET_LABELS.last_month };
    }
    case "custom":
      if (valid(from) && valid(to) && from! <= to! && to! <= today && daysBetween(from!, to!) <= 366) {
        return { preset, from: from!, to: to!, label: periodLabel(from!, to!) };
      }
      break;
  }
  return { preset: "7d", from: addDays(today, -6), to: today, label: PRESET_LABELS["7d"] };
}

/**
 * The previous corresponding period: the same number of days directly
 * before. "This month" (1–3 Oct) compares with 1–3 Sep; "last month" with
 * the whole month before it.
 */
export function previousPeriod(p: Period): Period {
  if (p.preset === "this_month" || p.preset === "last_month") {
    const first = parse(p.from);
    first.setUTCMonth(first.getUTCMonth() - 1);
    const from = iso(first);
    const lastOfPrevious = addDays(p.from, -1);
    const to = p.preset === "last_month" ? lastOfPrevious : [addDays(from, daysBetween(p.from, p.to) - 1), lastOfPrevious].sort()[0];
    return { preset: "custom", from, to, label: periodLabel(from, to) };
  }
  const to = addDays(p.from, -1);
  const from = addDays(to, -(daysBetween(p.from, p.to) - 1));
  return { preset: "custom", from, to, label: periodLabel(from, to) };
}
