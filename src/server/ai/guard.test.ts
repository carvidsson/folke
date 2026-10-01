import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvForTests } from "@/server/env";

import { verifyCitations } from "./citations";
import {
  DataGuardError,
  approvedDocumentsEnabled,
  assertEmbeddable,
  assertExternalAllowed,
  chooseProviderId,
  externalProviderConfigured,
  historyAllowedClasses,
  retrievalDataClass,
} from "./guard";
import { allowedChatModels, isAllowedChatModel, resolveChatModel } from "./models";
import { chatCostUsd, embeddingCostUsd } from "./pricing";
import { limitHistory } from "./prompt";

const saved = { ...process.env };

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetServerEnvForTests();
}

beforeEach(() => resetServerEnvForTests());
afterEach(() => {
  process.env = { ...saved };
  resetServerEnvForTests();
});

const openAIOn = { FOLKE_AI_PROVIDER: "openai", OPENAI_API_KEY: "test-placeholder-not-a-key" };

describe("provider routing (data guard)", () => {
  it("uses mock by default, whatever the conversation", () => {
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: true })).toBe("mock");
  });

  it("with synthetic-only, uses OpenAI only for synthetic conversations of test users", () => {
    setEnv(openAIOn);
    expect(approvedDocumentsEnabled()).toBe(false);
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: true })).toBe("openai");
    expect(chooseProviderId({ conversationClass: "internal", userHasTestAccess: true })).toBe("mock");
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: false })).toBe("mock");
  });

  it("with approved-documents, ordinary conversations use OpenAI for everyone", () => {
    setEnv({ ...openAIOn, FOLKE_AI_EXTERNAL_DATA: "approved-documents" });
    expect(chooseProviderId({ conversationClass: "internal", userHasTestAccess: false })).toBe("openai");
    // Synthetic test conversations still require test access.
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: false })).toBe("mock");
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: true })).toBe("openai");
  });

  it("approved-documents has no effect without the OpenAI provider", () => {
    setEnv({ FOLKE_AI_EXTERNAL_DATA: "approved-documents", OPENAI_API_KEY: "test-placeholder-not-a-key" });
    expect(chooseProviderId({ conversationClass: "internal", userHasTestAccess: true })).toBe("mock");
  });

  it("needs a key to be considered configured", () => {
    setEnv({ FOLKE_AI_PROVIDER: "openai", OPENAI_API_KEY: "" });
    expect(externalProviderConfigured()).toBe(false);
    expect(chooseProviderId({ conversationClass: "synthetic", userHasTestAccess: true })).toBe("mock");
  });

  it("rejects unknown external data policies", () => {
    setEnv({ ...openAIOn, FOLKE_AI_EXTERNAL_DATA: "all" });
    expect(() => externalProviderConfigured()).toThrow(/FOLKE_AI_EXTERNAL_DATA/);
  });

  it("rejects unknown endpoints (only OpenAI global or EU)", () => {
    setEnv({ ...openAIOn, OPENAI_BASE_URL: "https://proxy.example.com/v1" });
    expect(() => externalProviderConfigured()).toThrow(/OPENAI_BASE_URL/);
    setEnv({ ...openAIOn, OPENAI_BASE_URL: "https://eu.api.openai.com/v1" });
    expect(externalProviderConfigured()).toBe(true);
  });

  it("does not reveal configuration values in errors", () => {
    setEnv({ ...openAIOn, OPENAI_BASE_URL: "https://secret-proxy.example.com/v1?key=sk-abc" });
    let message = "";
    try {
      externalProviderConfigured();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("OPENAI_BASE_URL");
    expect(message).not.toContain("sk-abc");
    expect(message).not.toContain("secret-proxy");
  });

  it("retrieves only the allowed class for external calls", () => {
    expect(retrievalDataClass("synthetic", true)).toBe("synthetic");
    expect(retrievalDataClass("synthetic", false)).toBe("synthetic");
    expect(retrievalDataClass("internal", true)).toBe("approved");
    expect(retrievalDataClass("internal", false)).toBeNull();
    expect(historyAllowedClasses("internal", true)).toEqual(["approved"]);
    expect(historyAllowedClasses("internal", false)).toBeNull();
  });
});

describe("final check before external calls", () => {
  const ok = { external: true, conversationClass: "synthetic" as const, userHasTestAccess: true };
  beforeEach(() => setEnv(openAIOn));

  it("allows synthetic context in synthetic conversations", () => {
    expect(() => assertExternalAllowed({ ...ok, context: [{ dataClass: "synthetic" }] })).not.toThrow();
    expect(() => assertExternalAllowed({ ...ok, context: [] })).not.toThrow();
  });

  it.each([
    ["internal document in context", { ...ok, context: [{ dataClass: "synthetic" }, { dataClass: "internal" }] }],
    ["document without class", { ...ok, context: [{}] }],
    ["approved document in a synthetic conversation", { ...ok, context: [{ dataClass: "approved" }] }],
    ["internal conversation under synthetic-only", { ...ok, conversationClass: "internal" as const, context: [] }],
    ["user without test access", { ...ok, userHasTestAccess: false, context: [] }],
  ])("blocks %s", (_label, input) => {
    expect(() => assertExternalAllowed(input as Parameters<typeof assertExternalAllowed>[0])).toThrow(DataGuardError);
  });

  it("allows ordinary conversations with approved documents only (approved-documents)", () => {
    setEnv({ ...openAIOn, FOLKE_AI_EXTERNAL_DATA: "approved-documents" });
    const base = { external: true, conversationClass: "internal" as const, userHasTestAccess: false };
    expect(() => assertExternalAllowed({ ...base, context: [{ dataClass: "approved" }, { dataClass: "approved" }] })).not.toThrow();
    expect(() => assertExternalAllowed({ ...base, context: [] })).not.toThrow();
    for (const bad of ["internal", "synthetic", undefined] as const) {
      expect(() => assertExternalAllowed({ ...base, context: [{ dataClass: "approved" }, { dataClass: bad }] })).toThrow(
        DataGuardError,
      );
    }
  });

  it("blocks everything when OpenAI is not configured", () => {
    setEnv({ FOLKE_AI_PROVIDER: "mock" });
    expect(() => assertExternalAllowed({ ...ok, context: [] })).toThrow(DataGuardError);
  });

  it("does not restrict the mock provider", () => {
    expect(() =>
      assertExternalAllowed({ external: false, conversationClass: "internal", userHasTestAccess: false, context: [{ dataClass: "internal" }] }),
    ).not.toThrow();
  });

  it("only embeds synthetic or approved documents", () => {
    expect(() => assertEmbeddable([{ ai_data_class: "synthetic" }, { ai_data_class: "approved" }])).not.toThrow();
    expect(() => assertEmbeddable([{ ai_data_class: "synthetic" }, { ai_data_class: "internal" }])).toThrow(DataGuardError);
  });
});

describe("model catalog", () => {
  it("defaults to the cheapest model", () => {
    expect(resolveChatModel(null).id).toBe("gpt-6-luna");
    expect(resolveChatModel(undefined).costLevel).toBe("low");
  });

  it("never resolves to a model outside the allowlist", () => {
    expect(resolveChatModel("gpt-6-astra").id).toBe("gpt-6-luna");
    expect(resolveChatModel("text-embedding-3-small").id).toBe("gpt-6-luna");
    expect(isAllowedChatModel("gpt-6-astra")).toBe(false);
  });

  it("can be narrowed by configuration but not widened", () => {
    setEnv({ FOLKE_CHAT_MODELS: "gpt-6-luna,gpt-6-astra" });
    expect(allowedChatModels().map((m) => m.id)).toEqual(["gpt-6-luna"]);
    expect(resolveChatModel("gpt-6.1-sol").id).toBe("gpt-6-luna");
  });

  it("allows the advanced model when enabled", () => {
    expect(resolveChatModel("gpt-6.1-sol").id).toBe("gpt-6.1-sol");
  });
});

describe("cost estimates", () => {
  it("prices cached input separately", () => {
    // gpt-6-luna: 0.10 in, 0.01 cached, 0.50 out per 1M tokens
    expect(chatCostUsd("gpt-6-luna", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(0.1);
    expect(chatCostUsd("gpt-6-luna", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.01);
    expect(chatCostUsd("gpt-6.1-sol", { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(10);
  });

  it("is zero for mock and unknown models", () => {
    expect(chatCostUsd("mock", { inputTokens: 5000, outputTokens: 5000 })).toBe(0);
    expect(chatCostUsd("unknown-model", { inputTokens: 5000, outputTokens: 5000 })).toBe(0);
  });

  it("prices embeddings separately", () => {
    expect(embeddingCostUsd("text-embedding-3-small", 1_000_000)).toBeCloseTo(0.02);
  });
});

describe("citation verification", () => {
  it("keeps valid citations and lists them in order", () => {
    const r = verifyCitations("Garantin är 3 år [2]. Laddkabeln 24 månader [1, 2].", 3);
    expect(r.cited).toEqual([2, 1]);
    expect(r.removed).toBe(0);
    expect(r.content).toBe("Garantin är 3 år [2]. Laddkabeln 24 månader [1, 2].");
  });

  it("removes invented source numbers", () => {
    const r = verifyCitations("Garantin är 99 år [42]. Rost 12 år [1][7].", 2);
    expect(r.content).toBe("Garantin är 99 år. Rost 12 år [1].");
    expect(r.cited).toEqual([1]);
    expect(r.removed).toBe(2);
  });

  it("accepts citations with a location note", () => {
    const r = verifyCitations('Bromsbelägg omfattas inte [1, s. 4]. Kabeln 24 månader [2; avsnittet "Garanti"]. Fel [9, s. 1].', 2);
    expect(r.cited).toEqual([1, 2]);
    expect(r.content).toBe('Bromsbelägg omfattas inte [1, s. 4]. Kabeln 24 månader [2; avsnittet "Garanti"]. Fel.');
  });

  it("removes all citations when nothing was retrieved", () => {
    expect(verifyCitations("Svar [1].", 0)).toMatchObject({ content: "Svar.", cited: [] });
  });
});

describe("history limits", () => {
  const m = (role: "user" | "assistant", n: number) => ({ role, content: "x".repeat(n) });

  it("keeps the most recent messages within the limits, starting with a user message", () => {
    const history = [m("user", 10), m("assistant", 10), m("user", 10), m("assistant", 10), m("user", 10)];
    expect(limitHistory(history, { maxMessages: 4 })).toEqual(history.slice(2));
    expect(limitHistory(history, { maxChars: 25 }).length).toBe(1);
  });

  it("always keeps the latest message even if it is long", () => {
    expect(limitHistory([m("user", 50_000)])).toHaveLength(1);
  });
});
