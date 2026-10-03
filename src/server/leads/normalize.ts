import "server-only";

import type { ExclusionReason, LeadRow, ResponseStatus } from "@/lib/leads/types";

import { arrivalWindow, businessMinutesBetween, calendarMinutesBetween } from "./business-hours";
import { EMAIL_CHANNEL, FORMS_CHANNEL, type HubSpotMessage, type HubSpotThread } from "./hubspot";
import { parseLeadText, type ParsedLead } from "./lead-fields";
import { identifyVehicle } from "./vehicle";

/**
 * From a HubSpot thread and its history to the facts of one lead. The rules
 * were verified against the real inbox (ADR-046):
 *
 * - The history mixes messages with system events (ASSIGNMENT,
 *   THREAD_STATUS_CHANGE, THREAD_INBOX_CHANGE) and internal COMMENTs.
 * - A human seller reply is an OUTGOING MESSAGE from an agent actor ("A-…")
 *   that the same agent created, sent through HubSpot and with status SENT.
 * - Any other outgoing message (bot, integration, automation, failed send)
 *   is "uncertain": if one comes before the first human reply, the response
 *   time is not computed rather than guessed.
 */

export type EventKind =
  | "customer"
  | "seller"
  | "uncertain_outgoing"
  | "comment"
  | "assignment"
  | "status"
  | "inbox_change"
  | "automated"
  | "other";

const AGENT = /^A-\d+$/;

export function classifyEvent(m: HubSpotMessage): EventKind {
  switch (m.type) {
    case "MESSAGE": {
      const sender = m.senders?.[0]?.actorId ?? null;
      if (m.direction === "INCOMING") return sender && !AGENT.test(sender) ? "customer" : "other";
      if (m.direction !== "OUTGOING") return "other";
      const human =
        sender !== null &&
        AGENT.test(sender) &&
        (m.senders?.length ?? 0) === 1 &&
        m.createdBy === sender &&
        m.client?.clientType === "HUBSPOT" &&
        m.status?.statusType === "SENT";
      return human ? "seller" : "uncertain_outgoing";
    }
    case "COMMENT":
      return "comment";
    case "ASSIGNMENT":
      return "assignment";
    case "THREAD_STATUS_CHANGE":
      return "status";
    case "THREAD_INBOX_CHANGE":
      return "inbox_change";
    case "WELCOME_MESSAGE":
      return "automated";
    default:
      return "other";
  }
}

/**
 * A file sent with a message, as far as it can be told from HubSpot's metadata (verified 2026-10-03:
 * `attachments: [{ type: "FILE", name, fileUsageType: "IMAGE" | "OTHER", … }]`). An attachment is only
 * an offer document when its file name says so – otherwise Folke only knows that a file was sent.
 */
export type AttachmentKind = "offer_document" | "document" | "image";

const OFFER_FILE = /offert|kalkyl|offer|quote|leasingförslag|finansieringsförslag|prisförslag/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|heic|webp|bmp)$/i;

export function attachmentKind(a: { type?: string | null; name?: string | null; fileUsageType?: string | null }): AttachmentKind {
  const name = a.name ?? "";
  if (a.fileUsageType === "IMAGE" || IMAGE_FILE.test(name)) return "image";
  return OFFER_FILE.test(name) ? "offer_document" : "document";
}

export interface DialogueMessage {
  role: "customer" | "seller";
  sellerId: string | null;
  at: string;
  text: string;
  /** Kinds of attached files (never their names). */
  attachments: AttachmentKind[];
  /** Sender names HubSpot reports (for redaction only). */
  senderName: string | null;
}

export interface NormalizedLead {
  row: LeadRow;
  parsed: ParsedLead | null;
  /** Customer and human seller messages in order (contains personal data). */
  dialogue: DialogueMessage[];
}

export type NormalizeResult = { ok: true; lead: NormalizedLead } | { ok: false; reason: ExclusionReason };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Plain text from HubSpot's HTML version, for messages whose `text` is
 * empty. Quoted history (blockquote, Gmail/Outlook quote blocks) is removed;
 * the result is only ever used as input to redaction.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*class="[^"]*(?:gmail_quote|OutlookMessageHeader)[^"]*"[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message text; HubSpot's HTML version when the plain text is empty. */
export function messageText(m: HubSpotMessage): string {
  const text = m.text?.trim() ?? "";
  if (text) return m.text!;
  return m.richText ? htmlToText(m.richText) : "";
}

function byTime(a: HubSpotMessage, b: HubSpotMessage) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function normalizeThread(
  thread: HubSpotThread,
  history: HubSpotMessage[],
  context: { inboxId: string; formNames: Map<string, string> },
): NormalizeResult {
  if (thread.spam) return { ok: false, reason: "spam" };
  const events = [...history].sort(byTime).map((m) => ({ m, kind: classifyEvent(m) }));
  const messages = events.filter((e) => e.m.type === "MESSAGE");
  if (messages.length === 0) return { ok: false, reason: "no_messages" };
  const first = messages[0];
  if (first.kind !== "customer") return { ok: false, reason: "starts_with_outgoing" };

  const arrived = new Date(first.m.createdAt);
  const firstSeller = events.find((e) => e.kind === "seller" && e.m.createdAt >= first.m.createdAt);
  const uncertainBefore = events.some(
    (e) => e.kind === "uncertain_outgoing" && (!firstSeller || e.m.createdAt <= firstSeller.m.createdAt),
  );

  let status: ResponseStatus;
  if (uncertainBefore) status = "uncertain";
  else if (firstSeller) status = "registered_reply";
  else status = "no_registered_reply";

  const answeredAt = status === "registered_reply" && firstSeller ? new Date(firstSeller.m.createdAt) : null;
  const channelId = first.m.channelId;
  const parsed = channelId === FORMS_CHANNEL ? parseLeadText(messageText(first.m)) : null;
  const formName = first.m.channelAccountId ? (context.formNames.get(first.m.channelAccountId) ?? null) : null;

  const row: LeadRow = {
    threadId: thread.id,
    arrivedAt: arrived.toISOString(),
    arrivalWindow: arrivalWindow(arrived),
    channel: channelId === FORMS_CHANNEL ? "form" : channelId === EMAIL_CHANNEL ? "email" : "other",
    source: parsed?.source ?? (channelId === EMAIL_CHANNEL ? "E-post" : null),
    formName,
    vehicle: parsed?.vehicle ?? null,
    status,
    firstResponseAt: answeredAt?.toISOString() ?? null,
    calendarMinutes: answeredAt ? Math.round(calendarMinutesBetween(arrived, answeredAt)) : null,
    businessMinutes: answeredAt ? Math.round(businessMinutesBetween(arrived, answeredAt)) : null,
    ownerId: thread.assignedTo && AGENT.test(thread.assignedTo) ? thread.assignedTo : null,
    responderId: status === "registered_reply" ? (firstSeller?.m.senders?.[0]?.actorId ?? null) : null,
    assignmentEvents: events.filter((e) => e.kind === "assignment").length,
    movedIntoInbox: events.some((e) => e.kind === "inbox_change" && e.m.toInboxId === context.inboxId),
    threadOpen: thread.status === "OPEN",
    customerMessages: events.filter((e) => e.kind === "customer").length,
    sellerMessages: events.filter((e) => e.kind === "seller").length,
    internalComments: events.filter((e) => e.kind === "comment").length,
    customerWroteLast: false,
    inboxId: context.inboxId,
    latestMessageAt: null,
    lastCustomerMessageAt: null,
    firstSellerAfterCustomerAt: null,
    followedUp: false,
    vehicleBrand: null,
    vehicleModel: null,
    vehicleSource: null,
    regnrKind: parsed?.regnrKind ?? null,
  };

  const dialogue: DialogueMessage[] = events
    .filter((e) => e.kind === "customer" || e.kind === "seller")
    .map((e) => ({
      role: e.kind === "seller" ? ("seller" as const) : ("customer" as const),
      sellerId: e.kind === "seller" ? (e.m.senders?.[0]?.actorId ?? null) : null,
      at: e.m.createdAt,
      // The form lead's own text is represented by its parsed message only.
      text: e.m === first.m && parsed && parsed.format !== "unknown" ? (parsed.message ?? "") : messageText(e.m),
      senderName: e.m.senders?.[0]?.name ?? null,
      attachments: (e.m.attachments ?? []).map(attachmentKind),
    }));

  row.customerWroteLast = status === "registered_reply" && dialogue.at(-1)?.role === "customer";

  // Message times for deterministic follow-up facts (same rules as followUpSituation).
  const lastCustomer = dialogue.map((m) => m.role).lastIndexOf("customer");
  const after = dialogue.slice(lastCustomer + 1);
  row.lastCustomerMessageAt = lastCustomer >= 0 ? dialogue[lastCustomer].at : null;
  row.firstSellerAfterCustomerAt = after[0]?.at ?? null;
  row.followedUp = after.length > 0 && after.some((m) => Date.parse(m.at) - Date.parse(after[0].at) >= 86_400_000);
  row.latestMessageAt = thread.latestMessageTimestamp ?? events.at(-1)?.m.createdAt ?? null;

  const vehicle = identifyVehicle(parsed);
  row.vehicleBrand = vehicle.brand;
  row.vehicleModel = vehicle.model;
  row.vehicleSource = vehicle.source;
  return { ok: true, lead: { row, parsed, dialogue } };
}
