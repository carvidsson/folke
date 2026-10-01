import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyCitations } from "@/server/ai/citations";
import { assertExternalAllowed } from "@/server/ai/guard";
import { embeddingModel, resolveChatModel } from "@/server/ai/models";
import { chatCostUsd, embeddingCostUsd } from "@/server/ai/pricing";
import { buildSystemPrompt } from "@/server/ai/prompt";
import { createEmbeddings, openAIProvider } from "@/server/ai/providers/openai";
import { SYNTHETIC_CORPUS, type SyntheticAssistant } from "@/server/ai/synthetic-corpus";
import type { ContextChunk, UsageReport } from "@/server/ai/types";
import { chunkSections } from "@/server/documents/chunk";

import { EVAL_CASES, NO_ANSWER_MARKERS, type EvalCase } from "./cases";

/**
 * Swedish quality evaluation with REAL OpenAI calls – synthetic data only.
 *
 *   npm run test:ai-eval
 *
 * Uses the real prompt builder, provider, data guard and citation check.
 * Retrieval mirrors the database (approved, valid, linked to the assistant;
 * vector + keyword ranking merged with RRF) but runs in memory, so no
 * database is involved. Costs a few cents per run; see the printed summary.
 *
 * FOLKE_EVAL_MODELS (default "gpt-6-luna,gpt-6.1-sol") selects models.
 * FOLKE_EVAL_OUT may name a JSON file for the full results (answers are
 * synthetic, but keep the file out of Git).
 */

const MODELS = (process.env.FOLKE_EVAL_MODELS ?? "gpt-6-luna,gpt-6.1-sol").split(",").map((s) => s.trim());
const TODAY = new Date().toISOString().slice(0, 10);
const CONTEXT_LIMIT = 6;

/** Assistant instructions from the base-data migration (same text as in the database). */
function loadInstructions(): Record<SyntheticAssistant, string> {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261001090400_base_data.sql"), "utf8");
  const result: Partial<Record<SyntheticAssistant, string>> = {};
  for (const slug of ["salj", "analys", "mote", "garanti"] as const) {
    const start = sql.indexOf(`('${slug}', `);
    const match = /'((?:[^']|'')*)',\s*array\[/.exec(sql.slice(start));
    if (start < 0 || !match) throw new Error(`instructions for ${slug} not found`);
    result[slug] = match[1].replace(/''/g, "'");
  }
  return result as Record<SyntheticAssistant, string>;
}

interface IndexedChunk {
  title: string;
  content: string;
  location: string | null;
  assistants: SyntheticAssistant[];
  eligible: boolean;
  vector: number[];
}

const usage = { embeddingTokens: 0 };

async function buildIndex(): Promise<IndexedChunk[]> {
  const chunks = SYNTHETIC_CORPUS.flatMap((doc) =>
    chunkSections(doc.sections).map((c) => ({
      title: doc.title,
      content: c.content,
      location: c.location,
      assistants: doc.assistants,
      // Same rules as the database: approved and currently valid.
      eligible: doc.review === "approved" && (!doc.validUntil || doc.validUntil >= TODAY),
    })),
  );
  const model = embeddingModel();
  const { vectors, tokens } = await createEmbeddings(model.id, model.dimensions, chunks.map((c) => c.content));
  usage.embeddingTokens += tokens;
  return chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-zåäö0-9]{3,}/g) ?? []);

async function retrieve(index: IndexedChunk[], assistant: SyntheticAssistant, question: string): Promise<ContextChunk[]> {
  const model = embeddingModel();
  const { vectors, tokens } = await createEmbeddings(model.id, model.dimensions, [question]);
  usage.embeddingTokens += tokens;
  const candidates = index.filter((c) => c.eligible && c.assistants.includes(assistant));
  const q = words(question);
  const byVector = [...candidates].sort((a, b) => cosine(b.vector, vectors[0]) - cosine(a.vector, vectors[0]));
  const keywordScore = (c: IndexedChunk) => [...words(c.content)].filter((w) => q.has(w)).length;
  const byKeyword = candidates.filter((c) => keywordScore(c) > 0).sort((a, b) => keywordScore(b) - keywordScore(a));
  const score = new Map<IndexedChunk, number>();
  byVector.slice(0, 40).forEach((c, r) => score.set(c, (score.get(c) ?? 0) + 1 / (61 + r)));
  byKeyword.slice(0, 40).forEach((c, r) => score.set(c, (score.get(c) ?? 0) + 1 / (61 + r)));
  return [...score]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONTEXT_LIMIT)
    .map(([c], i) => ({
      index: i + 1,
      documentId: c.title,
      title: c.title,
      content: c.content,
      location: c.location,
      dataClass: "synthetic" as const,
    }));
}

interface Result {
  model: string;
  case: string;
  assistant: string;
  category: string;
  passed: boolean;
  failures: string[];
  answer: string;
  removedCitations: number;
  latencyMs: number;
  usage: UsageReport | null;
  costUsd: number;
}

function grade(c: EvalCase, answer: string, cited: number[]): string[] {
  const lower = answer.toLowerCase();
  const failures: string[] = [];
  for (const group of c.include ?? []) {
    if (!group.some((v) => lower.includes(v.toLowerCase()))) failures.push(`saknar ${group.join("/")}`);
  }
  for (const bad of c.exclude ?? []) {
    if (lower.includes(bad.toLowerCase())) failures.push(`innehåller "${bad}"`);
  }
  if (c.cite && cited.length === 0) failures.push("saknar källhänvisning");
  if (c.noAnswer && !NO_ANSWER_MARKERS.some((m) => lower.includes(m))) failures.push("säger inte att uppgiften saknas");
  return failures;
}

describe("Swedish quality evaluation (real OpenAI, synthetic data)", () => {
  it("answers the synthetic test cases", async () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY saknas (.env.local).");
    const instructions = loadInstructions();
    const index = await buildIndex();
    const results: Result[] = [];

    for (const c of EVAL_CASES) {
      const context = await retrieve(index, c.assistant, c.question);
      // Same final check as the chat route.
      assertExternalAllowed({ external: true, conversationClass: "synthetic", userHasTestAccess: true, context });
      // No ineligible document may ever be part of the context.
      for (const chunk of context) {
        const doc = SYNTHETIC_CORPUS.find((d) => d.title === chunk.title)!;
        expect(doc.review).toBe("approved");
        expect(doc.assistants).toContain(c.assistant);
      }

      for (const modelId of MODELS) {
        const model = resolveChatModel(modelId);
        expect(model.id, `model ${modelId} is not in the allowlist`).toBe(modelId);
        let answer = "";
        let report: UsageReport | null = null;
        const started = Date.now();
        let error = "";
        try {
          for await (const e of openAIProvider.streamChat({
            system: buildSystemPrompt(instructions[c.assistant], context),
            messages: [{ role: "user", content: c.question }],
            context,
            model: model.id,
            onUsage: (u) => (report = u),
          })) {
            answer += e.delta;
          }
        } catch (e) {
          error = (e as { code?: string }).code ?? "error";
        }
        const verified = verifyCitations(answer, context.length);
        const failures = error ? [`fel: ${error}`] : grade(c, verified.content, verified.cited);
        const finalUsage = report as UsageReport | null;
        results.push({
          model: model.id,
          case: c.id,
          assistant: c.assistant,
          category: c.category,
          passed: failures.length === 0,
          failures,
          answer: verified.content,
          removedCitations: verified.removed,
          latencyMs: Date.now() - started,
          usage: finalUsage,
          costUsd: finalUsage ? chatCostUsd(model.id, finalUsage) : 0,
        });
      }
    }

    // --- Summary -------------------------------------------------------------
    const embeddingUsd = embeddingCostUsd(embeddingModel().id, usage.embeddingTokens);
    console.log("\n=== Kvalitetsutvärdering (syntetiska data) ===");
    for (const model of MODELS) {
      const rows = results.filter((r) => r.model === model);
      const cost = rows.reduce((s, r) => s + r.costUsd, 0);
      const tokensIn = rows.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0);
      const tokensOut = rows.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
      const latency = Math.round(rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length);
      console.log(
        `\n${model}: ${rows.filter((r) => r.passed).length}/${rows.length} godkända, ` +
          `${tokensIn} tokens in, ${tokensOut} ut, ${cost.toFixed(5)} USD, snitt ${latency} ms`,
      );
      for (const assistant of ["salj", "analys", "mote", "garanti"]) {
        const a = rows.filter((r) => r.assistant === assistant);
        console.log(`  ${assistant.padEnd(8)} ${a.filter((r) => r.passed).length}/${a.length}`);
      }
      for (const r of rows.filter((x) => !x.passed)) {
        console.log(`  ✗ ${r.case}: ${r.failures.join("; ")}`);
      }
      const invalid = rows.reduce((s, r) => s + r.removedCitations, 0);
      if (invalid) console.log(`  Ogiltiga källnummer borttagna: ${invalid}`);
    }
    const total = results.reduce((s, r) => s + r.costUsd, 0) + embeddingUsd;
    console.log(`\nEmbeddings: ${usage.embeddingTokens} tokens, ${embeddingUsd.toFixed(6)} USD`);
    console.log(`Total uppskattad kostnad: ${total.toFixed(5)} USD\n`);

    if (process.env.FOLKE_EVAL_OUT) {
      writeFileSync(process.env.FOLKE_EVAL_OUT, JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
    }

    // Security cases must pass for every model; quality is reported above.
    const securityFailures = results.filter(
      (r) => (r.category === "injektion" || r.category === "behörighet" || r.category === "giltighet") && !r.passed,
    );
    expect(securityFailures.map((r) => `${r.model}/${r.case}: ${r.failures.join("; ")}`)).toEqual([]);
  }, 600_000);
});
