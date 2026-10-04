import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChatRequest, ChatStreamEvent } from "@/lib/chat/protocol";
import type { Assistant, LeadActionReference, LeadSetReference, LeadSourceReference, MessageSource, VerifiedFact } from "@/lib/domain/types";
import { leadChatStateSchema, type LeadChatState } from "@/lib/leads/chat";
import { getAIProvider } from "@/server/ai";
import { stripCitationMarkers, verifyCitations } from "@/server/ai/citations";
import { userMessageFor } from "@/server/ai/errors";
import { assertExternalAllowed, chooseProviderId, leadAnalysisExternalAllowed } from "@/server/ai/guard";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { resolveChatModel } from "@/server/ai/models";
import { personalInstructions, personalReminder } from "@/server/ai/preferences";
import { limitHistory, titleFromMessage } from "@/server/ai/prompt";
import type { ProviderMessage, UsageReport } from "@/server/ai/types";
import { recordChatUsage } from "@/server/ai/usage";
import { logSecurityEvent } from "@/server/audit";
import type { Session } from "@/server/auth/session";
import { getInstructionsForAuthorizedChat } from "@/server/data/assistants";
import { getMyAIPreferences, getOrganizationInstructionsForChat } from "@/server/data/instructions";
import { myLeadAccess } from "@/server/data/leads";
import { hubSpotConfigured } from "@/server/leads/hubspot";
import { MAX_SYNC_DAYS } from "@/server/leads/service";

import { buildBrief, needsAnalyses, modulesFor, type Brief } from "./brief";
import { usedFacts, visibleFacts } from "./facts";
import { findGaps } from "./gaps";
import { loadEntities, loadSelection, stockholmToday } from "./load";
import { buildLeadSystemPrompt } from "./prompt";
import { assertNoIdentifiers, pseudonymsFor, streamRevealer } from "./pseudonyms";
import { NO_INBOXES, NO_LEAD_ACCESS, outOfScopeAnswer } from "./respond";
import { resolveTurn } from "./scope";

/**
 * POST /api/chat for the Leadanalys assistant (ADR-050). Same protocol, storage and limits as the
 * ordinary chat, but the material is a brief of stored lead data instead of document excerpts:
 *
 * - The user's own client reads everything, so lead access (RLS) decides what may be used; the
 *   conversation's remembered selection and the page's context are re-resolved on every turn.
 * - Never a HubSpot sync or a new dialogue analysis.
 * - OpenAI only when chooseProviderId allows it (FOLKE_LEAD_CHAT_AI), with sellers pseudonymised and
 *   no customer data, thread ids or links. Otherwise the figures are given without AI.
 * - Clarifications, out-of-scope questions and unfetched periods are answered deterministically.
 */

const HISTORY_ROWS = 30;

type LeadConversation = { id: string; title: string; data_class: string; lead_context: unknown };

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function handleLeadChat({
  request,
  session,
  assistant,
  parsed,
  supabase,
}: {
  request: Request;
  session: Session;
  assistant: Assistant;
  parsed: ChatRequest;
  supabase: SupabaseClient;
}): Promise<Response> {
  const started = Date.now();
  const userId = session.user.id;
  const { conversationId, message } = parsed;

  // Lead access is checked before anything is stored – the assistant grant alone is not enough.
  const access = await myLeadAccess(supabase);
  if (!access.hasAccess) {
    await logSecurityEvent("access.denied", { actorId: userId, targetType: "assistant", targetId: assistant.id, metadata: { route: "/api/chat", area: "leads" } });
    return jsonError(NO_LEAD_ACCESS, 403);
  }
  if (message.attachmentIds?.length) return jsonError("Leadanalys tar inte emot bilagor.", 400);

  // --- Conversation (existing and owned, or new) ---------------------------
  let conversation: LeadConversation;
  let created = false;
  if (conversationId) {
    const { data } = await supabase
      .from("conversations")
      .select("id, title, assistant_id, data_class, lead_context")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle<LeadConversation & { assistant_id: string }>();
    if (!data || data.assistant_id !== assistant.id || data.data_class !== "lead") return jsonError("Konversationen hittades inte", 404);
    conversation = data;
  } else {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ assistant_id: assistant.id, title: titleFromMessage(message.content), data_class: "lead" })
      .select("id, title, data_class, lead_context")
      .single<LeadConversation>();
    if (error || !data) return jsonError("Konversationen kunde inte skapas", 500);
    conversation = data;
    created = true;
  }

  const today = stockholmToday();
  const now = new Date();
  const entities = await loadEntities(supabase, today);
  const previous = leadChatStateSchema.safeParse(conversation.lead_context);
  const turn = resolveTurn({
    text: message.content,
    today,
    entities,
    previous: previous.success ? previous.data : null,
    context: created ? (parsed.leadContext ?? null) : null,
  });

  const { data: storedMessage, error: insertError } = await supabase
    .from("messages")
    .insert({ conversation_id: conversation.id, role: "user", content: message.content, attachments: [] })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !storedMessage) return jsonError("Meddelandet kunde inte sparas", 500);

  const providerId = chooseProviderId({ conversationClass: "lead", userHasTestAccess: false });
  const conversationEvent = (provider: "mock" | "openai", model: string | null): ChatStreamEvent => ({
    type: "conversation",
    conversationId: conversation.id,
    title: conversation.title,
    created,
    dataClass: "standard",
    provider,
    model,
  });

  // --- Answers without AI ----------------------------------------------------
  const fixedAnswer = async (content: string, state: LeadChatState | null, sources: MessageSource[] = [], log: Record<string, unknown> = {}) => {
    const { error } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content, sources });
    if (error) console.error("[api/chat/lead] could not store answer", error.message);
    if (state) await saveState(supabase, conversation.id, state);
    console.info("[chat/lead]", JSON.stringify({ conversation: conversation.id, provider: "none", ms: Date.now() - started, ...log }));
    return ndjson([conversationEvent("mock", null), { type: "text", delta: content }, { type: "done", content, sources }]);
  };

  if (!entities.inboxes.length) return fixedAnswer(NO_INBOXES, null, [], { kind: "no_inboxes" });
  if (turn.kind === "clarify" || turn.kind === "not_found") return fixedAnswer(turn.text, turn.state, [], { kind: turn.kind });
  if (turn.kind === "out_of_scope") return fixedAnswer(outOfScopeAnswer(turn.topic), turn.state, [], { kind: "out_of_scope", topic: turn.topic });

  const loaded = await loadSelection(supabase, { state: turn.state, intents: turn.intents, examples: turn.examples, entities, today });
  const pseudonyms = pseudonymsFor(entities.sellers, entities.knownNames);
  const state = loaded.input.state;

  // Missing material: why, and the steps the user can choose (never started by Folke).
  const gaps = findGaps({
    selection: loaded.input.selection,
    scopeInboxes: loaded.input.inboxes,
    coverage: loaded.input.coverage,
    rows: loaded.input.rows,
    analyses: needsAnalyses(modulesFor(turn.intents, !!loaded.input.seller)) && !(turn.intents.includes("response_time") && turn.intents.includes("examples")) ? loaded.input.analyses : null,
    sellerId: loaded.input.seller?.id ?? null,
    intents: turn.intents,
    period: loaded.input.period,
    scope: { regionId: state.regionId, inboxId: state.inboxId },
    question: message.content,
    canSync: hubSpotConfigured(),
    canAnalyse: leadAnalysisExternalAllowed(),
    maxDays: MAX_SYNC_DAYS,
    today,
    createdAt: now.toISOString(),
  });
  const actionSources: MessageSource[] = gaps.action ? [gaps.action] : [];

  // Earlier verified facts: from the answers the history keeps, still visible to the user.
  const history = await loadHistory(supabase, conversation.id);
  const earlierFacts = visibleFacts(history.facts, entities);
  const brief = buildBrief({
    ...loaded.input,
    widenedFrom: widenedLabel(turn.widenedFrom, entities, pseudonyms),
    earlierFacts,
    actionNote: gaps.note,
    pseudonyms,
    now,
  });
  const logBase = { modules: brief.modules, intents: turn.intents, scope: loaded.input.scopeType, seller: !!loaded.input.seller, ...brief.stats, ...loaded.timings, earlierFacts: earlierFacts.length, gap: gaps.action?.steps.map((s) => s.action).join("+") ?? null };

  if (loaded.notFetched || gaps.answer) {
    const text = gaps.answer ?? `Perioden är inte hämtad från HubSpot för ${loaded.input.selection}, så det finns inget underlag att svara utifrån.`;
    return fixedAnswer(text, state, [brief.basis, ...actionSources], { kind: loaded.notFetched ? "not_fetched" : "not_analysed", ...logBase });
  }

  const provider = getAIProvider(providerId);
  if (!provider.external) return fixedAnswer(brief.fallback, state, [{ ...brief.basis, facts: usedFacts(brief.facts, brief.fallback).slice(0, 40) }, ...actionSources], { kind: "fallback", ...logBase });

  // --- AI answer -------------------------------------------------------------------
  const { data: assistantRow } = await supabase.from("assistants").select("ai_model").eq("id", assistant.id).single<{ ai_model: string | null }>();
  const model = resolveChatModel(assistantRow?.ai_model);
  const limit = await beginAIRequest(userId, "chat");
  if (!limit.ok) {
    await supabase.from("messages").delete().eq("id", storedMessage.id);
    return jsonError(limit.message, 429);
  }
  const requestId = limit.requestId;

  const [organizationInstructions, assistantInstructions, preferences] = await Promise.all([
    getOrganizationInstructionsForChat(),
    getInstructionsForAuthorizedChat(assistant.id),
    getMyAIPreferences(userId),
  ]);
  const messages = limitHistory(history.messages).map((m) => ({ role: m.role, content: pseudonyms.hide(m.content) }));
  const system = buildLeadSystemPrompt(
    { organization: organizationInstructions, assistant: assistantInstructions, personal: personalInstructions(preferences), personalReminder: personalReminder(preferences) },
    brief.text,
    { today },
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
      send(conversationEvent("openai", model.id));
      send({ type: "sources", sources: [brief.basis, ...brief.leads.map(stripTypes)] });

      const revealer = streamRevealer(pseudonyms);
      let answer = "";
      let usage: UsageReport | null = null;
      let failed = false;
      let firstTokenMs: number | null = null;
      try {
        assertExternalAllowed({ external: true, conversationClass: "lead", userHasTestAccess: false, context: [] });
        // The material Folke wrote (brief and earlier answers) – the user's own questions are theirs.
        assertNoIdentifiers([system, ...messages.filter((m) => m.role === "assistant").map((m) => m.content)].join("\n"));
        for await (const event of provider.streamChat({ system, messages, context: [], model: model.id, signal: request.signal, onUsage: (u) => (usage = u) })) {
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
          console.error("[api/chat/lead] provider error", error instanceof Error ? `${error.name}: ${(error as { code?: string }).code ?? ""}` : "unknown");
          await logSecurityEvent("chat.provider_error", { actorId: userId, targetType: "assistant", targetId: assistant.id, metadata: { provider: provider.id, code: (error as { code?: string }).code ?? null } });
          send({ type: "error", message: userMessageFor(error) });
        }
      }

      let cited = 0;
      if (failed) {
        await supabase.from("messages").delete().eq("id", storedMessage.id);
      } else if (answer.trim()) {
        const verified = verifyCitations(answer, brief.leads.length);
        const sources = finalSources(brief, verified.cited, verified.content, gaps.action);
        cited = verified.cited.length;
        const { error } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: verified.content, sources });
        if (error) console.error("[api/chat/lead] could not store answer", error.message);
        await saveState(supabase, conversation.id, { ...state, focus: focusOf(brief, verified.cited) });
        send({ type: "done", content: verified.content, sources });
      } else {
        send({ type: "done", content: "", sources: [] });
      }

      const finalUsage = usage as UsageReport | null;
      if (finalUsage) {
        await recordChatUsage({ userId, assistantId: assistant.id, conversationId: conversation.id, provider: provider.id, dataClass: "lead", usage: finalUsage, purpose: "lead_chat" });
      }
      await finishAIRequest(requestId, failed ? "failed" : request.signal.aborted ? "aborted" : "completed");
      // Counts and timings only – never question, brief or answer content.
      console.info(
        "[chat/lead]",
        JSON.stringify({
          conversation: conversation.id,
          provider: provider.id,
          kind: "ai",
          ...logBase,
          history: messages.length,
          firstTokenMs,
          totalMs: Date.now() - started,
          cited,
          inputTokens: finalUsage?.inputTokens ?? null,
          outputTokens: finalUsage?.outputTokens ?? null,
        }),
      );
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

/** "Säljare 3 i Alingsås Volkswagen PB", "Region Alingsås" – the selection before a widening, with the seller as alias. */
function widenedLabel(from: LeadChatState | null, entities: Parameters<typeof resolveTurn>[0]["entities"], pseudonyms: ReturnType<typeof pseudonymsFor>) {
  if (!from) return null;
  const inbox = from.inboxId ? entities.inboxes.find((i) => i.id === from.inboxId)?.name : null;
  const region = !inbox && from.regionId ? entities.regions.find((r) => r.id === from.regionId)?.name : null;
  const place = inbox ?? (region ? `Region ${region}` : "alla leads du har tillgång till");
  const seller = from.sellerId ? pseudonyms.aliasOf.get(from.sellerId) : null;
  const inboxIds = from.inboxId
    ? [from.inboxId]
    : from.regionId
      ? entities.inboxes.filter((i) => i.regionId === from.regionId).map((i) => i.id)
      : entities.inboxes.map((i) => i.id);
  return { label: seller ? `${seller} i ${place}` : place, sellerId: from.sellerId, inboxIds };
}

function ndjson(events: ChatStreamEvent[]) {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function stripTypes<T extends { types: string[] }>({ types, ...rest }: T): Omit<T, "types"> {
  void types;
  return rest;
}

const MAX_STORED_FACTS = 40;

/**
 * What is stored and shown with an answer, decided on the server – not by the model's citations:
 * - the basis, with the server-computed facts the answer used (verified facts for later turns),
 * - the cited leads, in citation order,
 * - the lead sets behind what the answer says: a pattern or observation whose figure ("13 av 82") or
 *   wording the answer uses, and the example sets of cited examples. So the user reaches the leads
 *   behind a pattern even when the answer cites none,
 * - the steps the user can choose to fill a gap.
 */
export function finalSources(brief: Brief, cited: number[], answer = "", action: LeadActionReference | null = null): MessageSource[] {
  const leads = cited.flatMap((n) => (brief.leads[n - 1] ? [brief.leads[n - 1]] : []));
  const ids = new Set(leads.map((l) => l.id));
  const text = answer.replace(/\s+/g, " ");
  type Set_ = Brief["sets"][number];
  const named = (s: Set_) => !!s.mention && s.mention.test(text);
  // A figure several sets share ("12 av 77") only counts together with the set's own wording.
  const shared = (q: string) => brief.sets.filter((x) => x.quote === q).length > 1;
  const quoted = (s: Set_) => !!s.quote && new RegExp(`(?<!\\d)${s.quote}(?!\\d)`).test(text) && (!shared(s.quote) || named(s));
  const example = (s: Set_) => s.id.startsWith("examples:") && s.threadIds.some((id) => ids.has(id));
  const rank = (s: Set_) => (quoted(s) ? 0 : example(s) ? 1 : named(s) ? 2 : 3);
  const sets = brief.sets.filter((s) => rank(s) < 3).sort((a, b) => rank(a) - rank(b));
  return [
    { ...brief.basis, facts: usedFacts(brief.facts, answer).slice(0, MAX_STORED_FACTS) },
    ...leads.map((l) => stripTypes(l) as LeadSourceReference),
    ...sets.map(({ quote, mention, ...s }) => (void quote, void mention, stripTypes(s) as LeadSetReference)),
    ...(action ? [action] : []),
  ];
}

/** "Samma typ av problem" in the next turn means the types of the leads this answer cited. */
function focusOf(brief: Brief, cited: number[]): string[] {
  const types = cited.flatMap((n) => brief.leads[n - 1]?.types ?? []);
  return [...new Set(types)].filter((t) => /^[a-z_]{2,40}$/.test(t)).slice(0, 8);
}

async function saveState(supabase: SupabaseClient, conversationId: string, state: LeadChatState) {
  const valid = leadChatStateSchema.safeParse(state);
  if (!valid.success) return;
  const { error } = await supabase.from("conversations").update({ lead_context: valid.data }).eq("id", conversationId);
  if (error) console.error("[api/chat/lead] could not store the selection", error.code);
}

/**
 * Earlier turns, sent again only while every lead an answer cited is still readable (RLS): a lead the
 * user can no longer see never reaches the model through an old answer. Citations are removed –
 * their numbers belonged to that turn's brief.
 */
async function loadHistory(supabase: SupabaseClient, conversationId: string): Promise<{ messages: ProviderMessage[]; facts: VerifiedFact[] }> {
  const { data } = await supabase
    .from("messages")
    .select("role, content, sources")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_ROWS)
    .returns<{ role: "user" | "assistant"; content: string; sources: MessageSource[] | null }[]>();
  const rows = (data ?? []).reverse();
  const referenced = [...new Set(rows.flatMap((m) => (m.sources ?? []).flatMap((s) => (s.kind === "lead" ? [s.id] : []))))];
  const readable = new Set<string>();
  for (let i = 0; i < referenced.length; i += 100) {
    const { data: found } = await supabase.from("lead_threads").select("hubspot_thread_id").in("hubspot_thread_id", referenced.slice(i, i + 100)).returns<{ hubspot_thread_id: string }[]>();
    for (const r of found ?? []) readable.add(r.hubspot_thread_id);
  }
  const kept = rows.filter((m) => m.role !== "assistant" || (m.sources ?? []).every((s) => s.kind !== "lead" || readable.has(s.id)));
  return {
    messages: kept.map(({ role, content }) => ({ role, content: role === "assistant" ? stripCitationMarkers(content) : content })),
    // Oldest first: the brief lists the newest of each measure.
    facts: kept.flatMap((m) => (m.role === "assistant" ? (m.sources ?? []).flatMap((s) => (s.kind === "lead_basis" ? (s.facts ?? []) : [])) : [])),
  };
}
