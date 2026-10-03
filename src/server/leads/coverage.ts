import "server-only";

import { addDays, daysBetween } from "@/lib/leads/periods";
import type { CoverageInfo } from "@/lib/leads/types";

import { stockholmTime } from "./business-hours";

/**
 * Which days of a period Folke has fetched from HubSpot (ADR-048).
 *
 * A day counts as covered for an inbox when a complete sync included it and
 * was made on or after that day (a sync at 07:45 covers today up to 07:45 –
 * the freshness is shown separately). Partial coverage is never presented
 * as complete: figures for such periods are marked or withheld.
 */

export interface SyncRecord {
  inboxId: string;
  from: string;
  to: string;
  syncedAt: string;
  complete: boolean;
}

function stockholmDate(instant: string) {
  const t = stockholmTime(new Date(instant));
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function coveredSet(syncs: SyncRecord[], from: string, to: string): Set<string> {
  const usable = syncs.filter((s) => s.complete).map((s) => ({ from: s.from, to: [s.to, stockholmDate(s.syncedAt)].sort()[0] }));
  const days = new Set<string>();
  for (let d = from; d <= to; d = addDays(d, 1)) if (usable.some((s) => s.from <= d && d <= s.to)) days.add(d);
  return days;
}

export function coveredDays(syncs: SyncRecord[], from: string, to: string): number {
  return coveredSet(syncs, from, to).size;
}

export function coverage(inboxes: { id: string; name: string }[], syncs: SyncRecord[], from: string, to: string): CoverageInfo {
  const totalDays = daysBetween(from, to);
  let completeInboxes = 0;
  let common: Set<string> | null = null;
  const lastSync: number[] = [];
  const missing: CoverageInfo["missing"] = [];
  for (const inbox of inboxes) {
    const own = syncs.filter((s) => s.inboxId === inbox.id);
    const days = coveredSet(own, from, to);
    const before: Set<string> | null = common;
    common = before ? new Set([...before].filter((d: string) => days.has(d))) : days;
    if (days.size === totalDays) completeInboxes++;
    else missing.push({ inboxId: inbox.id, name: inbox.name, coveredDays: days.size });
    const overlapping = own.filter((s) => s.complete && s.from <= to && s.to >= from).map((s) => Date.parse(s.syncedAt));
    if (overlapping.length) lastSync.push(Math.max(...overlapping));
  }
  const all = inboxes.length;
  return {
    inboxes: all,
    completeInboxes,
    // Days covered for every inbox in the scope.
    coveredDays: common?.size ?? 0,
    totalDays,
    complete: all > 0 && completeInboxes === all,
    oldestSyncAt: lastSync.length === all && all ? new Date(Math.min(...lastSync)).toISOString() : null,
    newestSyncAt: lastSync.length ? new Date(Math.max(...lastSync)).toISOString() : null,
    missing,
  };
}
