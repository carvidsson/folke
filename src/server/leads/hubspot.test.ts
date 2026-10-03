import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvForTests } from "@/server/env";

import { getAgentName, HubSpotError, listInboxes, listMessages, listThreads, setHubSpotFetchForTests } from "./hubspot";

const KEY = "pat-test-placeholder-not-a-real-key";

type Call = { url: URL; init: RequestInit };
let calls: Call[];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fake(handler: (url: URL, n: number) => Response) {
  setHubSpotFetchForTests(
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return handler(url, calls.length);
    }) as typeof fetch,
    async () => {},
  );
}

beforeEach(() => {
  calls = [];
  process.env.HUBSPOT_SERVICE_KEY = KEY;
  resetServerEnvForTests();
});

afterEach(() => {
  setHubSpotFetchForTests(null);
  delete process.env.HUBSPOT_SERVICE_KEY;
  resetServerEnvForTests();
});

describe("HubSpot client", () => {
  it("only sends GET requests with the key in the Authorization header", async () => {
    fake(() => json({ results: [{ id: "1", name: "Testinkorg", archived: false }] }));
    await listInboxes();
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].url.href).not.toContain(KEY);
    expect(calls[0].url.origin).toBe("https://api.hubapi.com");
  });

  it("follows paging.next.after until the last page", async () => {
    fake((url) => {
      const after = url.searchParams.get("after");
      if (!after) return json({ results: [{ id: 1, createdAt: "2026-09-01T08:00:00Z", inboxId: 9 }], paging: { next: { after: "p2" } } });
      if (after === "p2") return json({ results: [{ id: 2, createdAt: "2026-09-02T08:00:00Z", inboxId: 9 }], paging: { next: { after: "p3" } } });
      return json({ results: [{ id: 3, createdAt: "2026-09-03T08:00:00Z", inboxId: 9 }] });
    });
    const { threads, complete } = await listThreads("9", new Date("2026-09-01T00:00:00Z"));
    expect(complete).toBe(true);
    expect(threads.map((t) => t.id)).toEqual(["1", "2", "3"]);
    const params = calls[0].url.searchParams;
    expect(params.get("inboxId")).toBe("9");
    expect(params.get("latestMessageTimestampAfter")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("sort")).toBe("latestMessageTimestamp");
    expect(params.get("limit")).toBe("100");
  });

  it("drops threads from other inboxes if the API returns them", async () => {
    fake(() => json({ results: [{ id: 1, createdAt: "2026-09-01T08:00:00Z", inboxId: "9" }, { id: 2, createdAt: "2026-09-01T08:00:00Z", inboxId: "8" }] }));
    const { threads } = await listThreads("9", new Date("2026-09-01T00:00:00Z"));
    expect(threads.map((t) => t.id)).toEqual(["1"]);
  });

  it("reads every page of a thread's messages", async () => {
    fake((url) =>
      url.searchParams.get("after")
        ? json({ results: [{ id: "b", type: "MESSAGE", createdAt: "2026-09-01T08:00:00Z" }] })
        : json({ results: [{ id: "a", type: "ASSIGNMENT", createdAt: "2026-09-01T09:00:00Z" }], paging: { next: { after: "x" } } }),
    );
    const messages = await listMessages("123");
    expect(messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls[0].url.pathname).toBe("/conversations/v3/conversations/threads/123/messages");
    await expect(listMessages("../inboxes")).rejects.toThrow(HubSpotError);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    fake((_, n) => (n === 1 ? json({}, 429, { "retry-after": "1" }) : n === 2 ? json({}, 502) : json({ results: [] })));
    await expect(listInboxes()).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("maps errors without exposing the key", async () => {
    for (const [status, code] of [
      [401, "auth"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
    ] as const) {
      calls = [];
      fake(() => json({ message: `bad key ${KEY}` }, status));
      const error = await listInboxes().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HubSpotError);
      expect((error as HubSpotError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
    }
  });

  it("rejects unexpected response shapes instead of guessing", async () => {
    fake(() => json({ items: [] }));
    await expect(listInboxes()).rejects.toMatchObject({ code: "bad_response" });
    fake(() => json({ results: [{ id: "1", createdAt: 5 }] }));
    await expect(listThreads("9", new Date())).rejects.toMatchObject({ code: "bad_response" });
  });

  it("is unavailable without a key and never calls HubSpot then", async () => {
    delete process.env.HUBSPOT_SERVICE_KEY;
    resetServerEnvForTests();
    fake(() => json({ results: [] }));
    await expect(listInboxes()).rejects.toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("reads names only for agent actors", async () => {
    fake(() => json({ id: "A-1", type: "AGENT", name: "Sälja Säljarsson", email: "salja@folke.example" }));
    await expect(getAgentName("A-1")).resolves.toBe("Sälja Säljarsson");
    await expect(getAgentName("V-1")).resolves.toBeNull();
    await expect(getAgentName("A-1/../x")).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});
