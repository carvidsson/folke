import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChatRequest, ChatStreamEvent } from "@/lib/chat/protocol";
import type { Assistant, LeadActionReference, LeadPromptsReference, LeadSetReference, LeadSourceReference, MessageSource, VerifiedFact } from "@/lib/domain/types";
import { periodLabel } from "@/lib/leads/periods";
import { leadChatStateSchema, type LeadChatState, type LeadPending, type LeadTurn } from "@/lib/leads/chat";
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

import { buildBrief, type Brief } from "./brief";
import { usedFacts, visibleFacts } from "./facts";
import { findGaps, genitive, nextStepText } from "./gaps";
import { loadEntities, loadSelection, stockholmToday } from "./load";
import { buildLeadSystemPrompt } from "./prompt";
import { assertNoIdentifiers, pseudonymsFor, streamRevealer } from "./pseudonyms";
import { NO_INBOXES, NO_LEAD_ACCESS, outOfScopeAnswer } from "./respond";
import { fromContext, validState, type resolveTurn } from "./scope";
import { interpretTurn, reuse, sameSelection } from "./turn";

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
  const pseudonyms = pseudonymsFor(entities.sellers, entities.knownNames);
  const stored = leadChatStateSchema.safeParse(conversation.lead_context);
  const previousState = stored.success ? stored.data : null;
  const context = created ? (parsed.leadContext ?? null) : null;
  // The selection the turn starts from: the conversation's (as far as the user can still see it), or the page's.
  const base = validState(previousState, entities) ?? fromContext(context, entities, today);

  // --- What the message means ---------------------------------------------------------
  // A structured click needs no interpretation; free text goes to the planner (validated here), and to
  // the rule-based reading if the planner is off, slow or wrong.
  const interpretation = await interpretTurn({ parsed, base, previousState, context, entities, pseudonyms, today, now, userId, assistantId: assistant.id, conversationId: conversation.id, supabase });
  const turn = interpretation.turn;

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
  const turnLog = { via: interpretation.via, ...(interpretation.planner ?? {}) };

  // --- Answers without AI ----------------------------------------------------
  const fixedAnswer = async (content: string, state: LeadChatState | null, sources: MessageSource[] = [], log: Record<string, unknown> = {}) => {
    const { error } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content, sources });
    if (error) console.error("[api/chat/lead] could not store answer", error.message);
    if (state) await saveState(supabase, conversation.id, state);
    console.info("[chat/lead]", JSON.stringify({ conversation: conversation.id, provider: "none", ms: Date.now() - started, ...turnLog, ...log }));
    return ndjson([conversationEvent("mock", null), { type: "text", delta: content }, { type: "done", content, sources }]);
  };

  if (!entities.inboxes.length) return fixedAnswer(NO_INBOXES, null, [], { kind: "no_inboxes" });
  if (turn.kind === "clarify" || turn.kind === "not_found") return fixedAnswer(turn.text, turn.state, [], { kind: turn.kind });
  if (turn.kind === "out_of_scope") return fixedAnswer(outOfScopeAnswer(turn.topic), turn.state, [], { kind: "out_of_scope", topic: turn.topic });
  if (turn.request === "decline") {
    return fixedAnswer("Okej, jag varken hämtar eller analyserar något. Fråga gärna något annat om urvalet.", { ...turn.state, pending: null }, [], { kind: "decline" });
  }

  const loaded =
    interpretation.prefetch && sameSelection(interpretation.prefetch.input.state, turn.state)
      ? reuse(interpretation.prefetch, turn)
      : await loadSelection(supabase, { state: turn.state, intents: turn.intents, examples: turn.examples, entities, today, now });
  const seller = loaded.input.seller;

  // "Jag vill veta mer om en säljare" (Fråga Folke): choose a seller, then what to ask – without AI.
  if (turn.request === "seller_intro") {
    const intro = sellerIntro(loaded.input, entities.sellers);
    return fixedAnswer(intro.text, { ...loaded.input.state, intents: [], goal: null, pending: null }, intro.prompts ? [intro.prompts] : [], { kind: "seller_intro", seller: !!seller });
  }

  // Missing material: the status of the selection (one definition, status.ts) and the next step.
  const goal = loaded.input.state.goal ?? null;
  const gaps = findGaps({
    selection: loaded.input.selection,
    scopeInboxes: loaded.input.inboxes,
    coverage: loaded.input.coverage,
    rows: loaded.input.rows,
    analyses: loaded.input.analyses,
    needs: loaded.input.needs ?? null,
    sellerId: seller?.id ?? null,
    sellerName: seller?.name ?? null,
    intents: turn.intents,
    period: loaded.input.period,
    scope: { regionId: loaded.input.state.regionId, inboxId: loaded.input.state.inboxId },
    question: goal?.question ?? message.content,
    canSync: hubSpotConfigured(),
    canAnalyse: leadAnalysisExternalAllowed(),
    maxDays: MAX_SYNC_DAYS,
    today,
    createdAt: now.toISOString(),
  });
  // PENDING: the step offered now, kept with the selection it was offered for; none when nothing is missing.
  const step = gaps.action?.steps[0] ?? null;
  const pending: LeadPending | null =
    gaps.action && step
      ? {
          id: crypto.randomUUID(),
          kind: step.action === "sync" ? "fetch" : "analyse",
          regionId: loaded.input.state.regionId,
          inboxId: loaded.input.state.inboxId,
          sellerId: loaded.input.state.sellerId,
          from: loaded.input.period.from,
          to: loaded.input.period.to,
          inboxIds: step.inboxIds.slice(0, 60),
          createdAt: now.toISOString(),
        }
      : null;
  const action: LeadActionReference | null = gaps.action && pending ? { ...gaps.action, pendingId: pending.id, ...(goal ? { goal: goal.question } : {}) } : null;
  const actionSources: MessageSource[] = action ? [action] : [];
  const state: LeadChatState = { ...loaded.input.state, pending };

  // "Hämta det", "Ja, gör det", or a step that just finished with more to do: the next step, with the counts.
  if ((turn.request === "action" || turn.request === "continue") && action && step) {
    const text = nextStepText(gaps.status, step, { seller: seller?.name ?? null, selection: loaded.input.selection, period: loaded.input.period, afterStep: turn.request === "continue" ? (turn.state.pending?.kind ?? "fetch") : null });
    return fixedAnswer(text, state, [...actionSources], { kind: turn.request === "continue" ? "continue_step" : "action_request", gap: step.action, seller: !!seller });
  }

  // Earlier verified facts: from the answers the history keeps, still visible to the user.
  const history = await loadHistory(supabase, conversation.id);
  const earlierFacts = visibleFacts(history.facts, entities);
  const brief = buildBrief({
    ...loaded.input,
    state,
    widenedFrom: widenedLabel(turn.widenedFrom, entities, pseudonyms),
    earlierFacts,
    actionNote:
      turn.request === "action" && !action
        ? "Användaren bad om hämtning eller analys, men underlaget för urvalet är redan komplett. Säg det kort och besvara sedan användarens mål utifrån underlaget."
        : turn.request === "continue"
          ? "Användaren har just hämtat eller analyserat underlaget med Folkes knapp, och det är nu komplett. Besvara användarens mål – frågan i det senaste meddelandet – utifrån underlaget."
          : gaps.note,
    status: gaps.status,
    nextStep: step ? { label: step.label, detail: step.detail } : null,
    pseudonyms,
    now,
  });
  const logBase = { modules: brief.modules, intents: turn.intents, scope: loaded.input.scopeType, seller: !!loaded.input.seller, ...brief.stats, ...loaded.timings, earlierFacts: earlierFacts.length, gap: step?.action ?? null, ...turnLog };

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
        const sources = finalSources(brief, verified.cited, verified.content, action);
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

/** Most sellers listed as choices; the user can always type a name. */
const SELLER_CHOICES = 12;

/**
 * "Jag vill veta mer om en säljare": without a seller, the sellers who gave the first reply in the
 * selection and period (from the leads the user may see) as choices; with one, questions Leadanalys can
 * answer about that seller. Fixed text, no AI; the names are the user's own view and never sent to a model.
 */
export function sellerIntro(
  input: Awaited<ReturnType<typeof loadSelection>>["input"],
  sellers: { id: string; name: string }[],
): { text: string; prompts: LeadPromptsReference | null } {
  const period = periodLabel(input.period.from, input.period.to);
  const prompts = (list: [string, LeadTurn][]): LeadPromptsReference => ({ kind: "lead_prompts", id: "prompts", prompts: list.map(([p]) => p), turns: list.map(([, t]) => t) });
  if (!input.seller) {
    const first = new Map<string, number>();
    for (const r of input.rows) if (r.responderId) first.set(r.responderId, (first.get(r.responderId) ?? 0) + 1);
    const known = sellers.filter((s) => first.has(s.id)).sort((a, b) => first.get(b.id)! - first.get(a.id)! || a.name.localeCompare(b.name, "sv"));
    if (!known.length) {
      return { text: `Vilken säljare vill du veta mer om? Jag hittar inga registrerade säljsvar i ${input.selection} under ${period}, så skriv gärna säljarens namn.`, prompts: null };
    }
    return {
      text: `Vilken säljare vill du veta mer om? Här är säljarna som gav första svaret på leads i ${input.selection} under ${period}${known.length > SELLER_CHOICES ? ` (de ${SELLER_CHOICES} med flest)` : ""}. Välj en, eller skriv namnet.`,
      prompts: prompts(known.slice(0, SELLER_CHOICES).map((s) => [`Jag vill veta mer om ${s.name}`, { kind: "choose_seller", sellerId: s.id }])),
    };
  }
  const name = input.seller.name;
  const firstRows = input.rows.filter((r) => r.responderId === input.seller!.id);
  const eligible = firstRows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
  const analysed = input.analyses ? eligible.filter((r) => input.analyses!.has(r.threadId)).length : 0;
  const status = eligible.length
    ? analysed === eligible.length
      ? ` Alla ${eligible.length} dialoger med säljsvar är AI-analyserade.`
      : ` ${analysed} av ${eligible.length} dialoger med säljsvar är AI-analyserade – frågor om kommunikation och arbetssätt kan kräva att resten analyseras först, och då erbjuder jag det.`
    : "";
  return {
    text: `Vad vill du veta om ${name}? Under ${period} gav ${name} första svaret på ${firstRows.length} ${firstRows.length === 1 ? "lead" : "leads"} i ${input.selection}.${status} Välj en fråga nedan eller skriv en egen.`,
    // Each suggestion carries its topics: a click sets the goal without interpretation.
    prompts: prompts([
      [`Hur kommunicerar ${name} med kunderna?`, { kind: "ask", topics: ["seller_work"] }],
      [`Vad gör ${name} bra, och vad kan utvecklas?`, { kind: "ask", topics: ["strengths_improvements"] }],
      [`Hur väl driver ${name} dialogerna mot nästa steg?`, { kind: "ask", topics: ["follow_up_next_steps"] }],
      [`Hur hanterar ${name} kunder när bilen inte finns kvar?`, { kind: "ask", topics: ["unavailable_car", "seller_work"] }],
      [`Vilka behov och frågor har ${genitive(name)} kunder?`, { kind: "ask", topics: ["customer_needs"] }],
      [`Hur snabbt svarar ${name} kunderna?`, { kind: "ask", topics: ["response_times"] }],
      [`Vad kan vara bra att ta upp i nästa coaching med ${name}?`, { kind: "ask", topics: ["coaching"] }],
    ]),
  };
}
