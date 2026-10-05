import { z } from "zod";

/**
 * Leadanalys in the chat (ADR-050) – types shared by the server and the chat UI.
 *
 * The context a page hands to the chat and the state a conversation remembers only describe a
 * selection (ids and a period). The server re-resolves them against the user's current lead access
 * on every turn: they never grant or widen access.
 */

export const LEAD_INTENTS = ["overview", "response_time", "source", "virtual", "comparison", "patterns", "examples", "meeting", "explain", "needs"] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

const id = z.string().regex(/^[0-9a-f-]{36}$/);
const inbox = z.string().regex(/^\d{1,20}$/);
const actor = z.string().regex(/^A-\d{1,20}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const preset = z.enum(["7d", "30d", "this_month", "last_month", "custom"]);
const needsFocus = z.array(z.string().regex(/^[a-z_]{2,24}(:[a-z_]{2,24})?$/)).max(8);

/** From the Leadanalys page ("Fråga Folke om det här"). Validated, then re-resolved on the server. */
export const leadChatContextSchema = z.object({
  regionId: id.nullish(),
  inboxId: inbox.nullish(),
  sellerId: actor.nullish(),
  preset: preset.optional(),
  from: date.optional(),
  to: date.optional(),
});
export type LeadChatContext = z.infer<typeof leadChatContextSchema>;

/**
 * What a question can be about – the planner's closed list (and the topics a suggested question
 * carries). The server maps each to the brief modules it may load; nothing else can be asked for.
 */
export const LEAD_TOPICS = [
  "seller_work",
  "strengths_improvements",
  "follow_up_next_steps",
  "coaching",
  "customer_needs",
  "unavailable_car",
  "response_times",
  "sources",
  "virtual",
  "overview",
  "examples",
  "explain",
] as const;
export type LeadTopic = (typeof LEAD_TOPICS)[number];

/** GOAL: what the user is trying to find out – kept across follow-ups that only change the selection. */
export const leadGoalSchema = z.object({
  intents: z.array(z.enum(LEAD_INTENTS)).min(1).max(LEAD_INTENTS.length),
  needsFocus: needsFocus.optional(),
  /** The user's question as asked (shown back in "Fortsätt"; never used to decide access). */
  question: z.string().max(500),
  askedAt: z.string().max(40),
});
export type LeadGoal = z.infer<typeof leadGoalSchema>;

/** PENDING: a step Folke offered before it can answer the goal (fetch from HubSpot or AI analysis). */
export const leadPendingSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["fetch", "analyse"]),
  /** The selection the step was offered for: a continuation only resumes while it is unchanged. */
  regionId: id.nullable(),
  inboxId: inbox.nullable(),
  sellerId: actor.nullable(),
  from: date,
  to: date,
  inboxIds: z.array(inbox).max(60),
  createdAt: z.string().max(40),
});
export type LeadPending = z.infer<typeof leadPendingSchema>;

/**
 * What a lead conversation remembers between turns (conversations.lead_context, jsonb).
 * SELECTION – what we look at: region, inbox, seller, period and comparison (the v1 fields).
 * GOAL – what the user wants answered. PENDING – the step needed before Folke can go on.
 * Old conversations without goal or pending stay valid.
 */
export const leadChatStateSchema = z.object({
  regionId: id.nullable(),
  inboxId: inbox.nullable(),
  sellerId: actor.nullable(),
  preset,
  from: date,
  to: date,
  intents: z.array(z.enum(LEAD_INTENTS)).max(LEAD_INTENTS.length),
  comparison: z.boolean(),
  /** Opportunity or strength types the previous answer was built on ("samma typ av problem"). */
  focus: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(8),
  /** lead-needs-1 (ADR-052): what a needs question was about ("need:trade_in", "unavailable" …), for follow-ups. */
  needsFocus: needsFocus.optional(),
  goal: leadGoalSchema.nullable().optional(),
  pending: leadPendingSchema.nullable().optional(),
});
export type LeadChatState = z.infer<typeof leadChatStateSchema>;

/**
 * A structured turn from a click (no planner, no free-text interpretation): the continuation after a
 * step, "Jag vill veta mer om en säljare", choosing a seller, or a suggested question. Validated and
 * re-resolved on the server like everything else.
 */
export const leadTurnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue"), pendingId: z.uuid() }),
  z.object({ kind: z.literal("seller_intro") }),
  z.object({ kind: z.literal("choose_seller"), sellerId: actor }),
  z.object({ kind: z.literal("ask"), topics: z.array(z.enum(LEAD_TOPICS)).min(1).max(4) }),
]);
export type LeadTurn = z.infer<typeof leadTurnSchema>;
