import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChatRequest } from "@/lib/chat/protocol";
import type { LeadChatContext, LeadChatState, LeadTurn } from "@/lib/leads/chat";
import { periodLabel, resolvePeriod } from "@/lib/leads/periods";
import { assertExternalAllowed, leadChatExternalAllowed } from "@/server/ai/guard";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { recordChatUsage } from "@/server/ai/usage";

import { modulesFor } from "./brief";
import { parseQuestion } from "./intent";
import { loadSelection, type LoadedSelection } from "./load";
import { applyPlan, NOT_FOUND, nextGoal, placeSeller, topicsToIntents } from "./plan";
import { planTurn, type PlannerContext } from "./planner";
import type { Pseudonyms } from "./pseudonyms";
import { resolveTurn, type LeadEntities, type TurnResolution } from "./scope";

/**
 * How a Leadanalys chat turn is understood (2026-10-06):
 *   1. a structured click (continuation after a step, seller intro, a chosen seller, a suggested
 *      question) – no interpretation at all;
 *   2. otherwise the planner (planner.ts), validated by the server (plan.ts), while the previous
 *      selection is loaded in parallel;
 *   3. the rule-based reading (scope.ts) when the planner is off, slow, fails or gives an invalid plan –
 *      the chat keeps working as before.
 * GOAL is carried by every path the same way (plan.nextGoal); PENDING is cleared when the selection changes.
 */

export interface Interpretation {
  turn: TurnResolution;
  via: "structured" | "planner" | "fallback" | "rules";
  /** For the log only: no text, names or ids. */
  planner?: { plannerMs: number; plannerOutcome: string; plannerProblems?: string[]; plannerCode?: string };
  /** The previous selection, loaded while the planner ran (reused when the selection is unchanged). */
  prefetch?: LoadedSelection | null;
}

/** Everything a prefetch must have loaded to stand in for any question about the same selection. */
const PREFETCH_INTENTS = ["patterns", "comparison", "needs", "overview"] as const;

export function sameSelection(a: Pick<LeadChatState, "regionId" | "inboxId" | "sellerId" | "from" | "to">, b: Pick<LeadChatState, "regionId" | "inboxId" | "sellerId" | "from" | "to">) {
  return a.regionId === b.regionId && a.inboxId === b.inboxId && a.sellerId === b.sellerId && a.from === b.from && a.to === b.to;
}

/** A prefetched selection for this turn: the turn's state, intents and examples; comparison data only when asked. */
export function reuse(prefetch: LoadedSelection, turn: Extract<TurnResolution, { kind: "answer" }>): LoadedSelection {
  const comparison = modulesFor(turn.intents, !!prefetch.input.seller).has("comparison");
  return {
    ...prefetch,
    input: {
      ...prefetch.input,
      state: { ...turn.state, preset: prefetch.input.period.preset, from: prefetch.input.period.from, to: prefetch.input.period.to },
      intents: turn.intents,
      examples: turn.examples,
      ...(comparison ? {} : { previous: null, prevRows: null, prevCoverage: null }),
    },
  };
}

function emptyState(today: string): LeadChatState {
  const period = resolvePeriod("7d", today);
  return { regionId: null, inboxId: null, sellerId: null, preset: period.preset, from: period.from, to: period.to, intents: [], comparison: false, focus: [] };
}

/** A click: validated like everything else (a seller the user may not see is not found). */
function structuredTurn(leadTurn: LeadTurn, base: LeadChatState | null, entities: LeadEntities, text: string, today: string, now: Date): TurnResolution | null {
  const answer = (state: LeadChatState, request: Extract<TurnResolution, { kind: "answer" }>["request"]): TurnResolution => {
    const intents = state.intents.length ? state.intents : ["overview" as const];
    return {
      kind: "answer",
      state: { ...state, intents },
      intents,
      examples: intents.includes("examples") ? { polarity: "both", count: 3 } : null,
      changedScope: false,
      widenedFrom: null,
      request,
    };
  };
  switch (leadTurn.kind) {
    case "continue": {
      if (!base) return null;
      const intents = [...(base.goal?.intents ?? (base.intents.length ? base.intents : ["overview" as const]))];
      if (base.comparison && !intents.includes("comparison")) intents.push("comparison");
      return answer({ ...base, intents }, "continue");
    }
    case "seller_intro":
      return answer({ ...(base ?? emptyState(today)), sellerId: null, intents: ["patterns"], goal: null, pending: null }, "seller_intro");
    case "choose_seller": {
      const seller = entities.sellers.find((s) => s.id === leadTurn.sellerId);
      if (!seller) return { kind: "not_found", text: NOT_FOUND, state: base };
      const from = base ?? emptyState(today);
      const place = placeSeller(seller, from.regionId, from.inboxId, entities);
      return answer({ ...from, ...place, sellerId: seller.id, intents: ["patterns"], goal: null, pending: null }, "seller_intro");
    }
    case "ask": {
      if (!base) return null;
      const intents = topicsToIntents(leadTurn.topics);
      const needsFocus = leadTurn.topics.includes("unavailable_car") ? ["unavailable"] : [];
      const goal = nextGoal(base, intents, needsFocus, text, now);
      return answer({ ...base, intents: goal.intents, needsFocus: goal.needsFocus, goal: goal.goal, pending: null }, null);
    }
  }
}

/** The rule-based reading (the fallback), with the goal carried the same way as the planner's. */
function rulesTurn(text: string, base: LeadChatState | null, previous: LeadChatState | null, context: LeadChatContext | null, entities: LeadEntities, today: string, now: Date): TurnResolution {
  const turn = resolveTurn({ text, today, entities, previous, context });
  if (turn.kind !== "answer") return turn;
  const parsed = parseQuestion(text, today);
  const goal = nextGoal(base, parsed.intents, parsed.needsFocus, text, now);
  const keep = !!base && sameSelection(turn.state, base);
  return { ...turn, state: { ...turn.state, goal: goal.goal, pending: keep ? (base?.pending ?? null) : null } };
}

export async function interpretTurn(args: {
  parsed: ChatRequest;
  base: LeadChatState | null;
  previousState: LeadChatState | null;
  context: LeadChatContext | null;
  entities: LeadEntities;
  pseudonyms: Pseudonyms;
  today: string;
  now: Date;
  userId: string;
  assistantId: string;
  conversationId: string;
  supabase: SupabaseClient;
}): Promise<Interpretation> {
  const { parsed, base, entities, pseudonyms, today, now } = args;
  const text = parsed.message.content;
  if (parsed.leadTurn) {
    const turn = structuredTurn(parsed.leadTurn, base, entities, text, today, now);
    if (turn) return { turn, via: "structured" };
  }
  // The planner is an external call: only where the Leadanalys chat may use OpenAI at all.
  if (!leadChatExternalAllowed()) return { turn: rulesTurn(text, base, args.previousState, args.context, entities, today, now), via: "rules" };

  const prefetch = base
    ? loadSelection(args.supabase, { state: base, intents: [...PREFETCH_INTENTS], examples: null, entities, today, now }).catch(() => null)
    : Promise.resolve(null);
  const result = await runPlanner(args, text);
  const loaded = await prefetch;
  if (result.ok) {
    const applied = applyPlan({ plan: result.plan, text, entities, base, today, pseudonyms, now });
    return { turn: applied.turn, via: "planner", planner: { plannerMs: result.ms, plannerOutcome: "ok", ...(applied.problems.length ? { plannerProblems: applied.problems } : {}) }, prefetch: loaded };
  }
  return {
    turn: rulesTurn(text, base, args.previousState, args.context, entities, today, now),
    via: "fallback",
    planner: { plannerMs: result.ms, plannerOutcome: result.reason, ...(result.code ? { plannerCode: result.code } : {}) },
    prefetch: loaded,
  };
}

/** The planner call: pseudonymised text, the minimal context, the global AI budget and usage recorded. */
async function runPlanner(args: Parameters<typeof interpretTurn>[0], text: string) {
  const { base, entities, pseudonyms } = args;
  const started = Date.now();
  const slot = await beginAIRequest(null, "chat");
  if (!slot.ok) return { ok: false as const, reason: "error" as const, ms: Date.now() - started, code: "budget" };
  try {
    assertExternalAllowed({ external: true, conversationClass: "lead", userHasTestAccess: false, context: [] });
    const region = base?.regionId ? entities.regions.find((r) => r.id === base.regionId)?.name ?? null : null;
    const inbox = base?.inboxId ? entities.inboxes.find((i) => i.id === base.inboxId)?.name ?? null : null;
    const context: PlannerContext = {
      today: args.today,
      selection: {
        region,
        inbox,
        seller: base?.sellerId ? (pseudonyms.aliasOf.get(base.sellerId) ?? null) : null,
        period: base ? `${periodLabel(base.from, base.to)} (${base.from} – ${base.to})` : "senaste 7 dagarna",
        comparison: base?.comparison ?? false,
      },
      goal: base?.goal ? pseudonyms.hide(base.goal.question).slice(0, 300) : null,
      pending: base?.pending ? (base.pending.kind === "fetch" ? "Hämta underlaget från HubSpot för det aktiva urvalet" : "Analysera dialogerna i det aktiva urvalet") : null,
      regions: entities.regions.map((r) => r.name),
      inboxes: entities.inboxes.map((i) => i.name).slice(0, 80),
    };
    const result = await planTurn(pseudonyms.hide(text), context, (usage) => {
      void recordChatUsage({ userId: args.userId, assistantId: args.assistantId, conversationId: args.conversationId, provider: "openai", dataClass: "lead", usage, purpose: "lead_chat" });
    });
    await finishAIRequest(slot.requestId, result.ok ? "completed" : "failed");
    return result;
  } catch {
    await finishAIRequest(slot.requestId, "failed");
    return { ok: false as const, reason: "error" as const, ms: Date.now() - started, code: "guard" };
  }
}
