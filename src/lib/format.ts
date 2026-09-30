/** Formatting helpers. All output is Swedish (sv-SE). */

const LOCALE = "sv-SE";
const TIME_ZONE = "Europe/Stockholm";

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: TIME_ZONE,
});

const shortDateFmt = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  timeZone: TIME_ZONE,
});

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const relativeFmt = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

export function formatDate(value: string | Date): string {
  return dateFmt.format(new Date(value));
}

/** Formats a calendar date (YYYY-MM-DD) without timezone drift. */
export function formatCalendarDate(value: string): string {
  return dateFmt.format(new Date(`${value}T12:00:00`));
}

export function formatShortDate(value: string | Date): string {
  return shortDateFmt.format(new Date(value));
}

export function formatTime(value: string | Date): string {
  return timeFmt.format(new Date(value));
}

/** "för 5 minuter sedan", "igår", "12 sep." */
export function formatRelative(value: string | Date, now: Date): string {
  const date = new Date(value);
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return "just nu";
  if (abs < 3600) return relativeFmt.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return relativeFmt.format(Math.round(diffSec / 3600), "hour");
  if (abs < 7 * 86400) return relativeFmt.format(Math.round(diffSec / 86400), "day");
  return formatShortDate(date);
}

export type DateBucket = "today" | "yesterday" | "week" | "month" | "older";

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Idag",
  yesterday: "Igår",
  week: "Senaste 7 dagarna",
  month: "Senaste 30 dagarna",
  older: "Äldre",
};

function startOfDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

export function dateBucket(value: string | Date, now: Date): DateBucket {
  const days = Math.round(
    (startOfDay(now) - startOfDay(new Date(value))) / 86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  if (days < 30) return "month";
  return "older";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} MB`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
