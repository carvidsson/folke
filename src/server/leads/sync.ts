import "server-only";

import { addDays } from "@/lib/leads/periods";
import type { LeadRow } from "@/lib/leads/types";
import type { LeadStore } from "@/server/data/leads";

import { startOfStockholmDate } from "./business-hours";
import { HubSpotError, listMessages, listThreads, type HubSpotThread } from "./hubspot";
import { normalizeThread, type NormalizedLead } from "./normalize";
import { FACTS_VERSION, formNames, histories, pool, sellerNamesFromHubSpot } from "./service";

/**
 * Fetching from HubSpot into Folke (ADR-048). Read-only towards HubSpot.
 *
 * Incremental: a thread whose latest-message time is unchanged since it was
 * stored is not read again (its facts cannot have changed). A sync records
 * the period it covered and whether it was complete, so pages can show how
 * fresh the data is and never present partial periods as complete.
 */

export interface SyncResult {
  inboxId: string;
  leads: number;
  threadsRead: number;
  unchanged: number;
  failed: number;
  complete: boolean;
}

const FETCH_CONCURRENCY = 4;

function iso(t: string | null | undefined) {
  return t ? new Date(t).toISOString() : null;
}

export async function syncInbox(
  inbox: { id: string; name: string },
  period: { from: string; to: string },
  store: LeadStore,
  { deadline = Number.POSITIVE_INFINITY }: { deadline?: number } = {},
): Promise<SyncResult> {
  const start = startOfStockholmDate(period.from);
  const end = startOfStockholmDate(addDays(period.to, 1));
  const [{ threads, complete: allPages }, forms] = await Promise.all([listThreads(inbox.id, start), formNames()]);
  const inPeriod = threads.filter((t) => {
    const created = Date.parse(t.createdAt);
    return created >= start.getTime() && created < end.getTime();
  });

  const states = await store.threadStates(inPeriod.map((t) => t.id));
  let unchanged = 0;
  let failed = 0;
  let outOfTime = false;
  const changed: HubSpotThread[] = [];
  for (const t of inPeriod) {
    const state = states.get(t.id);
    if (state && state.factsVersion === FACTS_VERSION && state.latestMessageAt && state.latestMessageAt === iso(t.latestMessageTimestamp)) unchanged++;
    else changed.push(t);
  }

  const rows: LeadRow[] = [];
  await pool(changed, FETCH_CONCURRENCY, async (thread) => {
    if (Date.now() > deadline) {
      outOfTime = true;
      return;
    }
    const lead = await readThread(thread, inbox.id, forms);
    if (lead === "failed") failed++;
    else if (lead) rows.push(lead.row);
  });

  const sellerIds = new Set<string>();
  for (const r of rows) {
    if (r.ownerId) sellerIds.add(r.ownerId);
    if (r.responderId) sellerIds.add(r.responderId);
  }
  const names = await sellerNamesFromHubSpot([...sellerIds]);
  await store.saveFacts({ sellers: [...sellerIds].map((id) => ({ id, name: names.get(id) ?? null })), rows, factsVersion: FACTS_VERSION });

  const complete = allPages && failed === 0 && !outOfTime;
  await store.recordSync({ inboxId: inbox.id, from: period.from, to: period.to, leads: inPeriod.length, complete });
  return { inboxId: inbox.id, leads: inPeriod.length, threadsRead: rows.length, unchanged, failed, complete };
}

/** One thread's history (cached for 30 minutes) normalised; "failed" when HubSpot could not be read. */
export async function readThread(
  thread: HubSpotThread,
  inboxId: string,
  forms: Map<string, string>,
): Promise<NormalizedLead | null | "failed"> {
  const key = `${thread.id}:${thread.latestMessageTimestamp ?? ""}`;
  let history = histories.get(key);
  if (!history) {
    try {
      history = await listMessages(thread.id);
      histories.set(key, history);
    } catch (error) {
      console.error("[leads] could not read a thread", error instanceof HubSpotError ? error.code : "unknown");
      return "failed";
    }
  }
  const result = normalizeThread(thread, history, { inboxId, formNames: forms });
  return result.ok ? result.lead : null;
}

/** A thread as the sync knows it from the database, for reading its messages again. */
export function threadFromRow(row: LeadRow): HubSpotThread {
  return {
    id: row.threadId,
    createdAt: row.arrivedAt,
    status: row.threadOpen ? "OPEN" : "CLOSED",
    inboxId: row.inboxId,
    assignedTo: row.ownerId,
    spam: false,
    archived: false,
    latestMessageTimestamp: row.latestMessageAt,
    originalChannelId: null,
    originalChannelAccountId: null,
  };
}
