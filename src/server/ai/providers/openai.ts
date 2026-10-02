import "server-only";

import OpenAI from "openai";

import { serverEnv } from "@/server/env";

import { AIProviderError } from "../errors";
import { resolveChatModel } from "../models";
import type { AIProvider, ChatCompletionInput, ProviderEvent, UsageReport } from "../types";

/**
 * OpenAI provider (Responses API, streaming).
 *
 * - The API key is read from the server environment only and is never
 *   logged or returned to clients.
 * - store: false – responses are not stored for later retrieval. This is
 *   NOT the same as Zero Data Retention (abuse monitoring logs may still be
 *   kept by OpenAI, see docs/SECURITY.md).
 * - No tools, no file uploads, no vector stores: only text in, text out.
 * - No user identifiers, names or e-mail addresses are sent (no
 *   safety_identifier, no metadata).
 * - No automatic retries (maxRetries 0) to keep cost and duplicates under
 *   control; the user retries explicitly.
 * - This module never decides WHAT may be sent. The caller must run the
 *   data guard (src/server/ai/guard.ts) first.
 */

type ResponsesClient = Pick<OpenAI, "responses" | "embeddings" | "models">;

/**
 * Reasoning effort for a chat call: the catalog level, unless
 * FOLKE_AI_REASONING_EFFORT overrides it for all assistants. Models without
 * reasoning ("none") never get the parameter.
 */
export function reasoningFor(
  catalog: "none" | "low" | "medium",
  override: "low" | "medium" | undefined,
): { effort: "low" | "medium" } | undefined {
  if (catalog === "none") return undefined;
  return { effort: override ?? catalog };
}

/**
 * Responses API input. Without files: plain text messages, exactly as
 * before. With files (ADR-045): images (`detail: auto` – `low` loses small
 * text) and image-only PDFs are added inline to the last user message.
 */
export function toInput(messages: ChatCompletionInput["messages"], files: NonNullable<ChatCompletionInput["files"]>) {
  const last = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) => {
    if (i !== last || files.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "input_text" as const, text: m.content },
        ...files.map((f) =>
          f.kind === "image"
            ? { type: "input_image" as const, image_url: f.dataUrl, detail: "auto" as const }
            : { type: "input_file" as const, filename: f.name, file_data: f.dataUrl },
        ),
      ],
    };
  });
}

/** Appended when the output-token limit cut the answer (the partial answer is kept). */
export const TRUNCATED_NOTE =
  "\n\n_(Svaret blev för långt och avbröts här. Be mig gärna fortsätta, eller fråga om en del i taget.)_";

let client: ResponsesClient | null = null;

/** Tests may inject a fake client. */
export function setOpenAIClientForTests(fake: ResponsesClient | null) {
  client = fake;
}

export function openAIClient(): ResponsesClient {
  if (client) return client;
  const env = serverEnv();
  if (!env.OPENAI_API_KEY) throw new AIProviderError("auth", "OPENAI_API_KEY is not set");
  client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    project: env.OPENAI_PROJECT ?? null,
    organization: env.OPENAI_ORGANIZATION ?? null,
    baseURL: env.OPENAI_BASE_URL ?? undefined,
    maxRetries: 0,
    timeout: env.FOLKE_AI_TIMEOUT_MS,
  });
  return client;
}

/** Maps SDK errors to provider-neutral codes (detail for server logs only). */
export function mapOpenAIError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new AIProviderError("timeout");
  if (error instanceof OpenAI.APIConnectionError) return new AIProviderError("network");
  if (error instanceof OpenAI.APIError) {
    const detail = `${error.status ?? ""} ${error.code ?? ""} ${error.type ?? ""}`.trim();
    if (error.status === 429) {
      return new AIProviderError(error.code === "insufficient_quota" ? "quota" : "rate_limited", detail);
    }
    if (error.status === 401 || error.status === 403) return new AIProviderError("auth", detail);
    if (error.status === 404 || error.code === "model_not_found") {
      return new AIProviderError("model_unavailable", detail);
    }
    if (error.status === 400) return new AIProviderError("bad_request", detail);
    return new AIProviderError("unknown", detail);
  }
  return new AIProviderError("unknown", error instanceof Error ? error.name : undefined);
}

function toUsage(model: string, usage: OpenAI.Responses.ResponseUsage | null | undefined): UsageReport | null {
  if (!usage) return null;
  return {
    model,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    estimated: false,
  };
}

export const openAIProvider: AIProvider = {
  id: "openai",
  external: true,

  async *streamChat({ system, messages, files = [], model: requested, signal, onUsage }: ChatCompletionInput) {
    const model = resolveChatModel(requested);
    const env = serverEnv();
    let usage: UsageReport | null = null;
    let outputChars = 0;
    let finished = false;
    let sent = false;

    try {
      const stream = await openAIClient().responses.create(
        {
          model: model.id,
          instructions: system,
          input: toInput(messages, files),
          stream: true,
          store: false,
          max_output_tokens: env.FOLKE_AI_MAX_OUTPUT_TOKENS,
          reasoning: reasoningFor(model.reasoningEffort, env.FOLKE_AI_REASONING_EFFORT),
        },
        { signal },
      );
      sent = true; // accepted by the API: tokens may be billed from here on

      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            outputChars += event.delta.length;
            yield { type: "text", delta: event.delta } satisfies ProviderEvent;
            break;
          case "response.completed":
            usage = toUsage(model.id, event.response.usage);
            finished = true;
            break;
          case "response.incomplete":
            usage = toUsage(model.id, event.response.usage);
            finished = true;
            // Output-token limit reached: keep the partial answer, but say so.
            if (event.response.incomplete_details?.reason !== "max_output_tokens") {
              throw new AIProviderError("incomplete", event.response.incomplete_details?.reason ?? undefined);
            }
            yield { type: "text", delta: TRUNCATED_NOTE };
            break;
          case "response.failed":
            usage = toUsage(model.id, event.response.usage);
            throw new AIProviderError("unknown", event.response.error?.code ?? "response.failed");
          case "error":
            throw new AIProviderError(
              event.code === "rate_limit_exceeded" ? "rate_limited" : "unknown",
              event.code ?? "stream error",
            );
        }
      }
      if (!finished) throw new AIProviderError("incomplete", "stream ended without completion");
    } catch (error) {
      if (signal?.aborted) throw error;
      throw mapOpenAIError(error);
    } finally {
      // Always report usage – also after errors and aborts, when tokens were
      // already consumed. Without final usage the count is estimated
      // (conservatively: input may be billed even if no output arrived).
      usage ??= sent
        ? {
            model: model.id,
            inputTokens: Math.ceil((system.length + messages.reduce((n, m) => n + m.content.length, 0)) / 4),
            cachedInputTokens: 0,
            outputTokens: Math.ceil(outputChars / 4),
            reasoningTokens: 0,
            estimated: true,
          }
        : null;
      if (usage) onUsage?.(usage);
    }
  },
};

/** Embeddings for synthetic content (caller must run the data guard first). */
export async function createEmbeddings(
  model: string,
  dimensions: number,
  inputs: string[],
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; tokens: number }> {
  try {
    const result = await openAIClient().embeddings.create(
      { model, input: inputs, dimensions, encoding_format: "float" },
      { signal },
    );
    const vectors = [...result.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.some((v) => v.length !== dimensions)) {
      throw new AIProviderError("bad_request", "unexpected embedding dimensions");
    }
    return { vectors, tokens: result.usage.total_tokens };
  } catch (error) {
    throw mapOpenAIError(error);
  }
}

/** Model ids available to the configured project. */
export async function listAvailableModels(): Promise<string[]> {
  try {
    const ids: string[] = [];
    for await (const model of openAIClient().models.list()) ids.push(model.id);
    return ids.sort();
  } catch (error) {
    throw mapOpenAIError(error);
  }
}
