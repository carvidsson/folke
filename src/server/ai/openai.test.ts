import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";

import { AIProviderError } from "./errors";
import { TRUNCATED_NOTE, mapOpenAIError, openAIProvider, setOpenAIClientForTests } from "./providers/openai";
import type { UsageReport } from "./types";

/**
 * OpenAI provider against a fake client: no network, no key. Verifies the
 * request parameters (store:false, limits, no unsupported parameters),
 * streaming, usage reporting and error mapping.
 */

type Event = Record<string, unknown> & { type: string };

function fakeClient(events: Event[] | (() => never), capture: { params?: Record<string, unknown> } = {}) {
  return {
    responses: {
      create: async (params: Record<string, unknown>) => {
        capture.params = params;
        if (typeof events === "function") events();
        return (async function* () {
          for (const e of events as Event[]) {
            if (e.type === "throw") throw e.error;
            yield e;
          }
        })();
      },
    },
    embeddings: {},
    models: {},
  } as unknown as Parameters<typeof setOpenAIClientForTests>[0];
}

const usage = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
  output_tokens: 80,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 1280,
};

async function run(input: Partial<Parameters<typeof openAIProvider.streamChat>[0]> = {}) {
  const reports: UsageReport[] = [];
  let text = "";
  let error: unknown = null;
  try {
    for await (const e of openAIProvider.streamChat({
      system: "Systemprompt med syntetiska källor",
      messages: [{ role: "user", content: "Hur lång är garantin på laddkabeln?" }],
      context: [],
      model: "gpt-6-luna",
      onUsage: (u) => reports.push(u),
      ...input,
    })) {
      text += e.delta;
    }
  } catch (e) {
    error = e;
  }
  return { text, reports, error };
}

afterEach(() => setOpenAIClientForTests(null));

describe("OpenAI provider request", () => {
  it("streams with store:false, an output limit and no unsupported parameters", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    setOpenAIClientForTests(
      fakeClient(
        [
          { type: "response.output_text.delta", delta: "Laddkabeln omfattas i 24 månader [1]." },
          { type: "response.completed", response: { usage } },
        ],
        capture,
      ),
    );
    const { text } = await run();
    expect(text).toBe("Laddkabeln omfattas i 24 månader [1].");
    expect(capture.params).toMatchObject({
      model: "gpt-6-luna",
      stream: true,
      store: false,
      max_output_tokens: 2000,
      instructions: "Systemprompt med syntetiska källor",
      input: [{ role: "user", content: "Hur lång är garantin på laddkabeln?" }],
    });
    expect(capture.params).not.toHaveProperty("temperature");
    expect(capture.params).not.toHaveProperty("tools");
    expect(capture.params).not.toHaveProperty("safety_identifier");
    expect(capture.params).not.toHaveProperty("user");
    expect(capture.params).not.toHaveProperty("metadata");
    expect(capture.params).not.toHaveProperty("previous_response_id");
  });

  it("falls back to the default model for unknown model ids", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    setOpenAIClientForTests(fakeClient([{ type: "response.completed", response: { usage } }], capture));
    await run({ model: "gpt-9-ultra-unapproved" });
    expect(capture.params?.model).toBe("gpt-6-luna");
  });
});

describe("OpenAI provider usage", () => {
  it("reports exact usage once, including cached and reasoning tokens", async () => {
    setOpenAIClientForTests(fakeClient([{ type: "response.completed", response: { usage } }]));
    const { reports } = await run();
    expect(reports).toEqual([
      {
        model: "gpt-6-luna",
        inputTokens: 1200,
        cachedInputTokens: 200,
        outputTokens: 80,
        reasoningTokens: 10,
        estimated: false,
      },
    ]);
  });

  it("estimates usage when the stream breaks after partial output", async () => {
    setOpenAIClientForTests(
      fakeClient([
        { type: "response.output_text.delta", delta: "Början av ett svar" },
        { type: "throw", error: new OpenAI.APIConnectionError({ message: "reset" }) },
      ]),
    );
    const { reports, error } = await run();
    expect((error as AIProviderError).code).toBe("network");
    expect(reports).toHaveLength(1);
    expect(reports[0].estimated).toBe(true);
    expect(reports[0].outputTokens).toBeGreaterThan(0);
  });

  it("reports nothing when the request was rejected before it was accepted", async () => {
    setOpenAIClientForTests(
      fakeClient(() => {
        throw new OpenAI.AuthenticationError(401, { message: "bad key" }, "bad key", new Headers());
      }),
    );
    const { reports, error } = await run();
    expect((error as AIProviderError).code).toBe("auth");
    expect(reports).toEqual([]);
  });

  it("keeps a truncated answer and says so", async () => {
    setOpenAIClientForTests(
      fakeClient([
        { type: "response.output_text.delta", delta: "Ett långt svar" },
        { type: "response.incomplete", response: { usage, incomplete_details: { reason: "max_output_tokens" } } },
      ]),
    );
    const { text, error, reports } = await run();
    expect(error).toBeNull();
    expect(text).toBe(`Ett långt svar${TRUNCATED_NOTE}`);
    expect(TRUNCATED_NOTE).toContain("Be mig gärna fortsätta, eller fråga om en del i taget.");
    expect(reports).toHaveLength(1);
  });

  it("fails on a failed response and still reports usage", async () => {
    setOpenAIClientForTests(
      fakeClient([{ type: "response.failed", response: { usage, error: { code: "server_error" } } }]),
    );
    const { error, reports } = await run();
    expect(error).toBeInstanceOf(AIProviderError);
    expect(reports).toHaveLength(1);
  });

  it("fails when the stream ends without completion", async () => {
    setOpenAIClientForTests(fakeClient([{ type: "response.output_text.delta", delta: "x" }]));
    const { error } = await run();
    expect((error as AIProviderError).code).toBe("incomplete");
  });
});

describe("OpenAI error mapping", () => {
  const headers = new Headers();
  it.each([
    [new OpenAI.APIConnectionTimeoutError({ message: "t" }), "timeout"],
    [new OpenAI.APIConnectionError({ message: "n" }), "network"],
    [new OpenAI.RateLimitError(429, { code: "rate_limit_exceeded" }, "r", headers), "rate_limited"],
    [new OpenAI.RateLimitError(429, { code: "insufficient_quota" }, "q", headers), "quota"],
    [new OpenAI.AuthenticationError(401, {}, "a", headers), "auth"],
    [new OpenAI.PermissionDeniedError(403, {}, "p", headers), "auth"],
    [new OpenAI.NotFoundError(404, { code: "model_not_found" }, "m", headers), "model_unavailable"],
    [new OpenAI.BadRequestError(400, {}, "b", headers), "bad_request"],
    [new OpenAI.InternalServerError(500, {}, "i", headers), "unknown"],
    [new Error("x"), "unknown"],
  ])("maps %s", (error, code) => {
    expect(mapOpenAIError(error).code).toBe(code);
  });

  it("never exposes vendor messages or keys to users", () => {
    const error = mapOpenAIError(
      new OpenAI.AuthenticationError(401, { message: "Incorrect API key provided: sk-proj-abc" }, "x", headers),
    );
    expect(error.userMessage).not.toMatch(/sk-|key provided/i);
    expect(error.userMessage).toMatch(/administratör/);
  });
});
