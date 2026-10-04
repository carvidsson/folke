import { z } from "zod";

/**
 * Leadanalys in the chat (ADR-050) – types shared by the server and the chat UI.
 *
 * The context a page hands to the chat and the state a conversation remembers only describe a
 * selection (ids and a period). The server re-resolves them against the user's current lead access
 * on every turn: they never grant or widen access.
 */

export const LEAD_INTENTS = ["overview", "response_time", "source", "virtual", "comparison", "patterns", "examples", "meeting", "explain"] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

const id = z.string().regex(/^[0-9a-f-]{36}$/);
const inbox = z.string().regex(/^\d{1,20}$/);
const actor = z.string().regex(/^A-\d{1,20}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const preset = z.enum(["7d", "30d", "this_month", "last_month", "custom"]);

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

/** What a lead conversation remembers between turns (conversations.lead_context). */
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
});
export type LeadChatState = z.infer<typeof leadChatStateSchema>;
