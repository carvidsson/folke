import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChatStreamEvent } from "@/lib/chat/protocol";
import type { Assistant, MessageSource, TableResultReference } from "@/lib/domain/types";
import { tableQuerySchema, type TableQuery } from "@/lib/tables/query";
import { getAIProvider } from "@/server/ai";
import { stripCitationMarkers } from "@/server/ai/citations";
import { userMessageFor } from "@/server/ai/errors";
import { assertExternalAllowed, attachmentsExternalAllowed, chooseProviderId, type ConversationDataClass } from "@/server/ai/guard";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { resolveChatModel } from "@/server/ai/models";
import { personalInstructions, personalReminder } from "@/server/ai/preferences";
import { limitHistory, stockholmDate } from "@/server/ai/prompt";
import type { UsageReport } from "@/server/ai/types";
import { recordChatUsage } from "@/server/ai/usage";
import { logSecurityEvent } from "@/server/audit";
import { getInstructionsForAuthorizedChat } from "@/server/data/assistants";
import { getMyAIPreferences, getOrganizationInstructionsForChat } from "@/server/data/instructions";

import { runAnalysis } from "./analyses";
import { buildTableBrief, buildTableSystemPrompt, fallbackAnswer, tableResult } from "./brief";
import type { TableDataset } from "./dataset";
import { planTableTurn, planToQuery, readQuestion, type TableTurn } from "./planner";
import { assertNoTableIdentifiers, tablePseudonyms, tableStreamRevealer } from "./pseudonyms";

/**
 * A chat turn in Analysassistenten over the conversation's structured Excel exports (ADR-055).
 *
 * The server reads the question into one of the fixed analyses (planner or rules), computes it from the
 * original files and stores the table with the answer. The model – only when the data guard allows
 * attachments to go to the external provider – gets a pseudonymised brief of the result: no files, no
 * transactions, no contact persons, no free text, no row references. Without it, the server's own text
 * is the answer. Returns null when the question is not about the files: the ordinary chat then handles
 * it, unchanged.
 */

const HISTORY_ROWS = 30;

/** The assistant with structured Excel analysis (V1: Analysassistenten only). */
export const TABLE_ASSISTANT_SLUG = "analys";

type HistoryRow = { role: "user" | "assistant"; content: string; sources: MessageSource[] | null };

export async function handleTableChat(input: {
  request: Request;
  userId: string;
  assistant: Assistant;
  conversation: { id: string; title: string; data_class: Exclude<ConversationDataClass, "lead"> };
  created: boolean;
  userHasTestAccess: boolean;
  assistantModel: string | null;
  message: string;
  storedAttachments: unknown[];
  dataset: TableDataset;
  supabase: SupabaseClient;
}): Promise<Response | null> {
  const { request, userId, assistant, conversation, created, supabase, dataset } = input;
  const started = Date.now();

  const { data: historyData } = await supabase
    .from("messages")
    .select("role, content, sources")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_ROWS)
    .returns<HistoryRow[]>();
  const historyRows = (historyData ?? []).reverse();
  const previous = previousQuery(historyRows);

  const pseudonyms = tablePseudonyms(dataset);
  const providerId = chooseProviderId({ conversationClass: conversation.data_class, userHasTestAccess: input.userHasTestAccess });
  const provider = getAIProvider(providerId);
  // The brief is derived from attachments: external only where attachments may go to the provider.
  let external = provider.external && attachmentsExternalAllowed();
  const usages: UsageReport[] = [];

  // --- What the question asks for -------------------------------------------------------------
  const hidden = pseudonyms.hide(input.message);
  let turn: TableTurn | null = null;
  let via: "planner" | "rules" = "rules";
  let plannerLog: Record<string, unknown> = {};
  if (external) {
    const groups = groupCatalogue(dataset);
    const context = { today: stockholmDate(), previous, vehicles: dataset.vehicles.map((_, i) => `Fordon ${i + 1}`), groups };
    let allowed = true;
    try {
      assertExternalAllowed({ external: true, conversationClass: conversation.data_class, userHasTestAccess: input.userHasTestAccess, context: [], attachments: dataset.files.length });
      assertNoTableIdentifiers(`${hidden}\n${JSON.stringify(context)}`, pseudonyms);
    } catch {
      // Not allowed, or an identifier the pseudonyms could not hide: no AI in this turn.
      allowed = false;
      external = false;
    }
    if (allowed) {
      const planned = await planTableTurn(hidden, context, (u) => usages.push(u));
      plannerLog = { plannerMs: planned.ms, plannerOk: planned.ok, ...(planned.ok ? {} : { plannerReason: planned.reason }) };
      if (planned.ok) {
        turn = planToQuery(planned.plan, previous, { vehicleNumber: pseudonyms.vehicleNumber, groups: new Set(groups.map((g) => g.code)) });
        via = "planner";
      }
    }
  }
  turn ??= readQuestion(hidden, previous, { vehicleNumber: pseudonyms.vehicleNumber });
  if (turn.kind === "other") {
    await recordUsages(usages, input, providerId);
    return null;
  }

  const { data: storedMessage, error: insertError } = await supabase
    .from("messages")
    .insert({ conversation_id: conversation.id, role: "user", content: input.message, attachments: input.storedAttachments })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !storedMessage) {
    await recordUsages(usages, input, providerId);
    return Response.json({ error: "Meddelandet kunde inte sparas" }, { status: 500 });
  }

  const conversationEvent = (p: "mock" | "openai", model: string | null): ChatStreamEvent => ({
    type: "conversation",
    conversationId: conversation.id,
    title: conversation.title,
    created,
    dataClass: conversation.data_class === "synthetic" ? "synthetic" : "standard",
    provider: p,
    model,
  });
  const logBase = { conversation: conversation.id, files: dataset.files.length, rows: dataset.transactions.length, via, ...plannerLog };

  const fixedAnswer = async (content: string, sources: MessageSource[], log: Record<string, unknown>) => {
    const { error } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content, sources });
    if (error) console.error("[api/chat/tables] could not store answer", error.message);
    await recordUsages(usages, input, providerId);
    console.info("[chat/tables]", JSON.stringify({ ...logBase, provider: "none", ms: Date.now() - started, ...log }));
    return ndjson([conversationEvent("mock", null), { type: "text", delta: content }, { type: "done", content, sources }]);
  };

  if (turn.kind === "clarify") return fixedAnswer(turn.text, [], { kind: "clarify" });

  const query = turn.query;
  const result = tableResult(runAnalysis(dataset, query), query);
  const resultLog = { kind: query.analysis, total: result.total, window: query.windowMonths, by: query.by };
  // "Vilka reservdelar …" has one answer, and it is the server's.
  if (query.analysis === "parts" || !external) return fixedAnswer(fallbackAnswer(result), [result], resultLog);

  // --- AI answer from the pseudonymised brief ---------------------------------------------------
  const brief = buildTableBrief(dataset, result, pseudonyms);
  // Earlier turns, with identifiers as aliases. Answers built on knowledge-base documents are left
  // out: their material follows the document rules, not these.
  const history = limitHistory(
    historyRows
      .filter((m) => m.role === "user" || !(m.sources ?? []).some((s) => s.kind === undefined || s.kind === "document"))
      .map((m) => ({ role: m.role, content: pseudonyms.hide(m.content) })),
  );
  const messages = [...history, { role: "user" as const, content: hidden }];
  try {
    assertNoTableIdentifiers([brief, ...messages.map((m) => m.content)].join("\n"), pseudonyms);
  } catch {
    return fixedAnswer(fallbackAnswer(result), [result], { ...resultLog, guard: "identifier" });
  }
  const assistantModel = resolveChatModel(input.assistantModel);
  const limit = await beginAIRequest(userId, "chat");
  if (!limit.ok) {
    await supabase.from("messages").delete().eq("id", storedMessage.id);
    await recordUsages(usages, input, providerId);
    return Response.json({ error: limit.message }, { status: 429 });
  }
  const requestId = limit.requestId;
  const [organizationInstructions, assistantInstructions, preferences] = await Promise.all([
    getOrganizationInstructionsForChat(),
    getInstructionsForAuthorizedChat(assistant.id),
    getMyAIPreferences(userId),
  ]);
  const system = buildTableSystemPrompt(
    { organization: organizationInstructions, assistant: assistantInstructions, personal: personalInstructions(preferences), personalReminder: personalReminder(preferences) },
    brief,
  );
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client went away; keep going so the answer is still stored.
        }
      };
      send(conversationEvent("openai", assistantModel.id));
      send({ type: "sources", sources: [result] });
      const revealer = tableStreamRevealer(pseudonyms);
      let answer = "";
      let failed = false;
      let firstTokenMs: number | null = null;
      try {
        assertExternalAllowed({ external: true, conversationClass: conversation.data_class, userHasTestAccess: input.userHasTestAccess, context: [], attachments: dataset.files.length });
        assertNoTableIdentifiers([system, ...messages.map((m) => m.content)].join("\n"), pseudonyms);
        for await (const event of provider.streamChat({ system, messages, context: [], model: assistantModel.id, signal: request.signal, onUsage: (u) => usages.push(u) })) {
          firstTokenMs ??= Date.now() - started;
          const delta = revealer.push(event.delta);
          answer += delta;
          if (delta) send({ type: "text", delta });
        }
        const rest = revealer.flush();
        answer += rest;
        if (rest) send({ type: "text", delta: rest });
      } catch (error) {
        if (!request.signal.aborted) {
          failed = true;
          console.error("[api/chat/tables] provider error", error instanceof Error ? `${error.name}: ${(error as { code?: string }).code ?? ""}` : "unknown");
          await logSecurityEvent("chat.provider_error", { actorId: userId, targetType: "assistant", targetId: assistant.id, metadata: { provider: provider.id, code: (error as { code?: string }).code ?? null } });
          send({ type: "error", message: userMessageFor(error) });
        }
      }
      if (failed) {
        await supabase.from("messages").delete().eq("id", storedMessage.id);
      } else {
        // No numbered sources here: a stray "[1]" would point at nothing.
        const content = answer.trim() ? stripCitationMarkers(answer) : fallbackAnswer(result);
        const { error } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content, sources: [result] });
        if (error) console.error("[api/chat/tables] could not store answer", error.message);
        send({ type: "done", content, sources: [result] });
      }
      const tokens = usages.reduce((n, u) => n + u.inputTokens, 0);
      await recordUsages(usages, input, provider.id);
      await finishAIRequest(requestId, failed ? "failed" : request.signal.aborted ? "aborted" : "completed");
      // Counts and timings only – never question, brief, identifiers or answer content.
      console.info("[chat/tables]", JSON.stringify({ ...logBase, ...resultLog, provider: provider.id, history: history.length, firstTokenMs, totalMs: Date.now() - started, inputTokens: tokens }));
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

/** The query of the latest table answer: a follow-up changes it. */
export function previousQuery(rows: Pick<HistoryRow, "role" | "sources">[]): TableQuery | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const source = (rows[i].sources ?? []).find((s): s is TableResultReference => s.kind === "table_result");
    if (source) {
      const parsed = tableQuerySchema.safeParse(source.query);
      return parsed.success ? parsed.data : null;
    }
  }
  return null;
}

/** Main groups in the files: codes and the export's own names (no identifiers). */
function groupCatalogue(ds: TableDataset) {
  const groups = new Map<string, string>();
  for (const t of ds.transactions) if (t.group.main && !groups.has(t.group.main)) groups.set(t.group.main, (t.group.name ?? "").replace(/^\d+\s*/, "").slice(0, 60));
  return [...groups].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
}

async function recordUsages(usages: UsageReport[], input: { userId: string; assistant: Assistant; conversation: { id: string; data_class: Exclude<ConversationDataClass, "lead"> } }, provider: string) {
  for (const usage of usages.splice(0)) {
    await recordChatUsage({ userId: input.userId, assistantId: input.assistant.id, conversationId: input.conversation.id, provider, dataClass: input.conversation.data_class, usage });
  }
}

function ndjson(events: ChatStreamEvent[]) {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
