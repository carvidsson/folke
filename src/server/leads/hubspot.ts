import "server-only";

import { z } from "zod";

import { serverEnv } from "@/server/env";

/**
 * Read-only client for HubSpot Conversations v3 (ADR-046).
 *
 * - GET requests only, to the conversations endpoints the conversations.read
 *   scope covers. There is no code path that writes to HubSpot.
 * - The service key is read from the server environment and sent only in
 *   the Authorization header to api.hubapi.com. It is never logged, put in
 *   an error, returned to the browser or passed to an AI provider.
 * - Requests are spaced (≈ 8 per second, well below the 19/s and 190/10 s
 *   the API reports) and 429/5xx responses are retried with back-off.
 * - Responses are validated: only the fields we verified against the real
 *   API are used, and an unexpected shape is an error – never a guess.
 */

const BASE = "https://api.hubapi.com/conversations/v3/conversations";
const MIN_INTERVAL_MS = 125;
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 100;
/** Safety stop: 100 pages of threads = 10 000 threads in one selection. */
const MAX_THREAD_PAGES = 100;
const MAX_MESSAGE_PAGES = 20;

export type HubSpotErrorCode =
  | "not_configured"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "network"
  | "bad_response"
  | "unknown";

export class HubSpotError extends Error {
  constructor(
    readonly code: HubSpotErrorCode,
    readonly status?: number,
  ) {
    super(`HubSpot: ${code}${status ? ` (${status})` : ""}`);
    this.name = "HubSpotError";
  }
}

export function hubSpotConfigured(): boolean {
  return Boolean(serverEnv().HUBSPOT_SERVICE_KEY);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
let sleepImpl = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tests inject a fake fetch (and instant sleep); never the real network. */
export function setHubSpotFetchForTests(fake: Fetch | null, sleep?: (ms: number) => Promise<void>) {
  fetchImpl = fake;
  if (sleep) sleepImpl = sleep;
  nextSlot = 0;
}

// Shared spacing between requests in this server process.
let nextSlot = 0;
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await sleepImpl(at - now);
}

const id = z.union([z.string(), z.number()]).transform(String);
const optionalId = id.nullish().transform((v) => v ?? null);

async function get<T>(path: string, params: Record<string, string | number | undefined>, schema: z.ZodType<T>): Promise<T> {
  const key = serverEnv().HUBSPOT_SERVICE_KEY;
  if (!key) throw new HubSpotError("not_configured");
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    let res: Response;
    try {
      res = await (fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleepImpl(500 * 2 ** attempt);
        continue;
      }
      throw new HubSpotError("network");
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new HubSpotError(res.status === 429 ? "rate_limited" : "unknown", res.status);
    }
    if (res.status === 401) throw new HubSpotError("auth", 401);
    if (res.status === 403) throw new HubSpotError("forbidden", 403);
    if (res.status === 404) throw new HubSpotError("not_found", 404);
    if (!res.ok) throw new HubSpotError("unknown", res.status);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new HubSpotError("bad_response");
    return parsed.data;
  }
}

const paging = z
  .object({ next: z.object({ after: z.string() }).nullish() })
  .nullish()
  .transform((p) => p?.next?.after ?? null);

function page<T extends z.ZodType>(item: T) {
  return z.object({ results: z.array(item), paging });
}

// ---------------------------------------------------------------------------
// Inboxes, channel accounts, actors
// ---------------------------------------------------------------------------

const inbox = z.object({ id, name: z.string(), archived: z.boolean().nullish() });
export type HubSpotInbox = { id: string; name: string };

export async function listInboxes(): Promise<HubSpotInbox[]> {
  const all: HubSpotInbox[] = [];
  let after: string | null = null;
  do {
    const r: { results: z.infer<typeof inbox>[]; paging: string | null } = await get(
      "/inboxes",
      { limit: PAGE_SIZE, after: after ?? undefined },
      page(inbox),
    );
    for (const i of r.results) if (!i.archived) all.push({ id: i.id, name: i.name });
    after = r.paging;
  } while (after);
  return all.sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

const channelAccount = z.object({ id, name: z.string().nullish(), channelId: optionalId, inboxId: optionalId });

/** Channel account id → name (for forms: the form's name, e.g. "Kontakta oss (generell)"). */
export async function listChannelAccountNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let after: string | null = null;
  do {
    const r: { results: z.infer<typeof channelAccount>[]; paging: string | null } = await get(
      "/channel-accounts",
      { limit: PAGE_SIZE, after: after ?? undefined },
      page(channelAccount),
    );
    // E-mail accounts are named after the address: not useful, and not shown.
    for (const a of r.results) if (a.name && a.channelId === FORMS_CHANNEL) names.set(a.id, a.name);
    after = r.paging;
  } while (after);
  return names;
}

const actor = z.object({ id: z.string(), type: z.string().nullish(), name: z.string().nullish() });

/** Display name of a HubSpot user (agent actor "A-…"). Null if unknown. */
export async function getAgentName(actorId: string): Promise<string | null> {
  if (!/^A-\d+$/.test(actorId)) return null;
  const a = await get(`/actors/${encodeURIComponent(actorId)}`, {}, actor);
  return a.name?.trim() || null;
}

// ---------------------------------------------------------------------------
// Threads and messages
// ---------------------------------------------------------------------------

/** HubSpot's channel ids (GET /channels). */
export const FORMS_CHANNEL = "1003";
export const EMAIL_CHANNEL = "1002";

const thread = z.object({
  id,
  createdAt: z.string(),
  status: z.string().nullish(),
  inboxId: optionalId,
  assignedTo: z.string().nullish(),
  spam: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  latestMessageTimestamp: z.string().nullish(),
  originalChannelId: optionalId,
  originalChannelAccountId: optionalId,
});
export type HubSpotThread = z.infer<typeof thread>;

/**
 * All threads in an inbox with a message after `since`. The API filters on
 * the latest message only (there is no createdAt filter), so the caller
 * selects the threads created in its period from this superset.
 */
export async function listThreads(inboxId: string, since: Date): Promise<{ threads: HubSpotThread[]; complete: boolean }> {
  const threads: HubSpotThread[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < MAX_THREAD_PAGES; pages++) {
    const r: { results: HubSpotThread[]; paging: string | null } = await get(
      "/threads",
      {
        inboxId,
        sort: "latestMessageTimestamp",
        latestMessageTimestampAfter: since.toISOString(),
        limit: PAGE_SIZE,
        after: after ?? undefined,
      },
      page(thread),
    );
    threads.push(...r.results.filter((t) => t.inboxId === null || t.inboxId === inboxId));
    after = r.paging;
    if (!after) return { threads, complete: true };
  }
  return { threads, complete: false };
}

const sender = z.object({ actorId: z.string().nullish(), name: z.string().nullish() });

const message = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullish(),
  direction: z.string().nullish(),
  channelId: optionalId,
  channelAccountId: optionalId,
  senders: z.array(sender).nullish(),
  text: z.string().nullish(),
  // HTML version; used only when `text` is empty (seen for some outgoing e-mails).
  richText: z.string().nullish(),
  client: z.object({ clientType: z.string().nullish() }).nullish(),
  status: z.object({ statusType: z.string().nullish() }).nullish(),
  assignedTo: z.string().nullish(),
  toInboxId: optionalId,
  fromInboxId: optionalId,
});
export type HubSpotMessage = z.infer<typeof message>;

/** The full history of a thread: messages, comments and system events. */
export async function listMessages(threadId: string): Promise<HubSpotMessage[]> {
  if (!/^\d+$/.test(threadId)) throw new HubSpotError("bad_response");
  const all: HubSpotMessage[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < MAX_MESSAGE_PAGES; pages++) {
    const r: { results: HubSpotMessage[]; paging: string | null } = await get(
      `/threads/${threadId}/messages`,
      { limit: PAGE_SIZE, after: after ?? undefined },
      page(message),
    );
    all.push(...r.results);
    after = r.paging;
    if (!after) return all;
  }
  // A thread with more than 2 000 events is not a lead conversation we can judge.
  throw new HubSpotError("bad_response");
}
