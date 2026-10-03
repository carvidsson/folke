import { describe, expect, it } from "vitest";

import {
  CUSTOMER,
  INBOX_ID,
  LISTING_TEXT,
  SELLER_A,
  SELLER_B,
  customerMessage,
  message,
  sellerMessage,
  systemEvent,
  thread,
} from "./fixtures.test-helpers";
import { classifyEvent, normalizeThread } from "./normalize";

const context = { inboxId: INBOX_ID, formNames: new Map([["700001", "Leadsväxel – test"]]) };

// Wednesday 2 September 2026, 10:00 Stockholm (08:00 UTC).
const ARRIVAL = "2026-09-02T08:00:00.000Z";

function normalize(history: Parameters<typeof normalizeThread>[1], overrides: Partial<Parameters<typeof thread>[0]> = {}) {
  return normalizeThread(thread({ id: "1", createdAt: ARRIVAL, ...overrides }), history, context);
}

describe("event classification", () => {
  it("recognises a human seller reply only with every verified signal", () => {
    const reply = sellerMessage(ARRIVAL, "Hej");
    expect(classifyEvent(reply)).toBe("seller");
    expect(classifyEvent({ ...reply, createdBy: "I-77" })).toBe("uncertain_outgoing");
    expect(classifyEvent({ ...reply, senders: [{ actorId: "I-77", name: "Integration" }], createdBy: "I-77" })).toBe("uncertain_outgoing");
    expect(classifyEvent({ ...reply, client: { clientType: "INTEGRATION" } })).toBe("uncertain_outgoing");
    expect(classifyEvent({ ...reply, status: { statusType: "FAILED" } })).toBe("uncertain_outgoing");
    expect(classifyEvent({ ...reply, senders: [{ actorId: SELLER_A }, { actorId: SELLER_B }] })).toBe("uncertain_outgoing");
  });

  it("separates customers, comments, system events and bots", () => {
    expect(classifyEvent(customerMessage(ARRIVAL, "Hej"))).toBe("customer");
    expect(classifyEvent(message({ type: "COMMENT", createdAt: ARRIVAL, createdBy: SELLER_A, senders: [{ actorId: SELLER_A }] }))).toBe("comment");
    expect(classifyEvent(systemEvent("ASSIGNMENT", ARRIVAL, { assignedTo: SELLER_A }))).toBe("assignment");
    expect(classifyEvent(systemEvent("THREAD_STATUS_CHANGE", ARRIVAL))).toBe("status");
    expect(classifyEvent(systemEvent("THREAD_INBOX_CHANGE", ARRIVAL, { toInboxId: INBOX_ID }))).toBe("inbox_change");
    expect(classifyEvent(systemEvent("WELCOME_MESSAGE", ARRIVAL))).toBe("automated");
    expect(classifyEvent(systemEvent("SOMETHING_NEW", ARRIVAL))).toBe("other");
  });
});

describe("thread normalisation", () => {
  it("finds the first human reply among system events, in any input order", () => {
    // HubSpot returns the newest first.
    const history = [
      systemEvent("THREAD_STATUS_CHANGE", "2026-09-02T12:00:00.000Z"),
      sellerMessage("2026-09-02T11:00:00.000Z", "Uppföljning"),
      sellerMessage("2026-09-02T08:45:00.000Z", "Hej, bilen finns kvar."),
      message({ type: "COMMENT", createdAt: "2026-09-02T08:30:00.000Z", createdBy: SELLER_A, senders: [{ actorId: SELLER_A }], text: "Intern notering" }),
      systemEvent("ASSIGNMENT", "2026-09-02T08:20:00.000Z", { assignedTo: SELLER_A }),
      systemEvent("THREAD_STATUS_CHANGE", "2026-09-02T08:00:01.000Z"),
      customerMessage(ARRIVAL, LISTING_TEXT),
    ];
    const r = normalize(history);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { row, dialogue, parsed } = r.lead;
    expect(row).toMatchObject({
      status: "registered_reply",
      arrivalWindow: "business_hours",
      channel: "form",
      source: "Blocket",
      formName: "Leadsväxel – test",
      vehicle: "Volkswagen ID.4",
      firstResponseAt: "2026-09-02T08:45:00.000Z",
      calendarMinutes: 45,
      businessMinutes: 45,
      ownerId: SELLER_A,
      responderId: SELLER_A,
      assignmentEvents: 1,
      customerMessages: 1,
      sellerMessages: 2,
      internalComments: 1,
    });
    expect(parsed?.format).toBe("listing");
    // The dialogue has no comments or events, and the form text is reduced to the customer's message.
    expect(dialogue.map((m) => m.role)).toEqual(["customer", "seller", "seller"]);
    expect(dialogue[0].text).toBe("Hej! Finns bilen kvar?\nJag undrar också: kan ni ta inbyte?");
  });

  it("keeps owner and actual responder apart", () => {
    const r = normalize([customerMessage(ARRIVAL, "Hej"), sellerMessage("2026-09-02T09:00:00.000Z", "Svar", SELLER_B)], { assignedTo: SELLER_A });
    expect(r.ok && r.lead.row).toMatchObject({ ownerId: SELLER_A, responderId: SELLER_B });
  });

  it("marks a lead without any outgoing message as no reply in HubSpot", () => {
    const r = normalize([customerMessage(ARRIVAL, "Hej"), systemEvent("ASSIGNMENT", "2026-09-02T09:00:00.000Z", { assignedTo: SELLER_A })], { status: "OPEN" });
    expect(r.ok && r.lead.row).toMatchObject({ status: "no_registered_reply", firstResponseAt: null, calendarMinutes: null, responderId: null, threadOpen: true });
  });

  it("does not compute a response time when an unclassifiable outgoing message came first", () => {
    const bot = { ...sellerMessage("2026-09-02T08:01:00.000Z", "Automatiskt svar"), createdBy: "I-1", senders: [{ actorId: "I-1" }] };
    const r = normalize([customerMessage(ARRIVAL, "Hej"), bot, sellerMessage("2026-09-02T09:00:00.000Z", "Svar")]);
    expect(r.ok && r.lead.row).toMatchObject({ status: "uncertain", calendarMinutes: null, businessMinutes: null, responderId: null });
  });

  it("ignores outgoing messages that are not human for the no-reply count, but marks them uncertain", () => {
    const failed = { ...sellerMessage("2026-09-02T08:10:00.000Z", "Svar"), status: { statusType: "FAILED" } };
    const r = normalize([customerMessage(ARRIVAL, "Hej"), failed]);
    expect(r.ok && r.lead.row.status).toBe("uncertain");
  });

  it("excludes spam, empty threads and threads that start outgoing", () => {
    expect(normalize([customerMessage(ARRIVAL, "Hej")], { spam: true })).toEqual({ ok: false, reason: "spam" });
    expect(normalize([systemEvent("THREAD_STATUS_CHANGE", ARRIVAL)])).toEqual({ ok: false, reason: "no_messages" });
    expect(normalize([sellerMessage(ARRIVAL, "Hej!"), customerMessage("2026-09-02T09:00:00.000Z", "Hej")])).toEqual({
      ok: false,
      reason: "starts_with_outgoing",
    });
  });

  it("notes threads moved into the inbox and e-mail leads without form fields", () => {
    const r = normalize([
      customerMessage(ARRIVAL, "Hej, jag har en fråga om en bil.", "1002"),
      systemEvent("THREAD_INBOX_CHANGE", "2026-09-02T08:30:00.000Z", { fromInboxId: "900002", toInboxId: INBOX_ID }),
    ]);
    expect(r.ok && r.lead.row).toMatchObject({ movedIntoInbox: true, channel: "email", source: "E-post", vehicle: null });
    expect(r.ok && r.lead.parsed).toBeNull();
  });

  it("does not treat a customer actor as an agent", () => {
    expect(CUSTOMER.startsWith("A-")).toBe(false);
  });
});
