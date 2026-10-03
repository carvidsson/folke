import { describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";

import { applyRules, followUpSituation, hasContent, sanitiseClassification, sourceFingerprint, type RawClassification } from "./analysis";
import { SYNTHETIC_CUSTOMER, customerMessage, sellerMessage, thread } from "./fixtures.test-helpers";
import { htmlToText, messageText, normalizeThread, type NormalizedLead } from "./normalize";

/** Deterministic parts of the AI analysis (ADR-047). Synthetic data only. */

const T0 = "2026-09-01T08:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

function lead(roles: ["customer" | "seller", number][]): NormalizedLead {
  return {
    row: { threadId: "1", arrivedAt: T0, arrivalWindow: "business_hours", channel: "form", source: "Blocket", vehicle: null } as LeadRow,
    parsed: null,
    dialogue: roles.map(([role, h]) => ({ role, sellerId: role === "seller" ? "A-1" : null, at: at(h), text: `${role} ${h}`, senderName: null })),
  };
}

const base: RawClassification = {
  intent: "price_or_offer",
  purchaseIntent: "interested",
  carStatus: "available",
  alternativeOffered: "not_applicable",
  behaviours: {
    answered_questions: { status: "done", reason: "" },
    next_step: { status: "done", reason: "" },
    needs_questions: { status: "not_relevant", reason: "" },
    visit_or_test_drive: { status: "not_relevant", reason: "" },
    follow_up: { status: "missing", reason: "Ingen uppföljning." },
  },
  observations: [],
  evidence: "sufficient",
};

describe("follow-up situation", () => {
  const now = new Date(at(24 * 10));

  it("is computed from the dialogue, not judged", () => {
    expect(followUpSituation(lead([["customer", 0]]), now).state).toBe("customer_last");
    expect(followUpSituation(lead([["customer", 0], ["seller", 1], ["customer", 2]]), now).state).toBe("customer_last");
    // The seller wrote last, two days before "now": too early.
    expect(followUpSituation(lead([["customer", 0], ["seller", 24 * 8]]), now).state).toBe("too_early");
    expect(followUpSituation(lead([["customer", 0], ["seller", 1]]), now)).toEqual({ state: "waiting", sellerMessagesSince: 1, followedUp: false });
    // A second seller message the same hour is not a follow-up; one a day later is.
    expect(followUpSituation(lead([["customer", 0], ["seller", 1], ["seller", 2]]), now).followedUp).toBe(false);
    expect(followUpSituation(lead([["customer", 0], ["seller", 1], ["seller", 30]]), now)).toEqual({ state: "waiting", sellerMessagesSince: 2, followedUp: true });
  });

  it("overrides the model where the facts decide", () => {
    const now10 = new Date(at(24 * 10));
    // Customer wrote last: follow-up can never be missing.
    expect(applyRules(base, followUpSituation(lead([["customer", 0]]), now10)).behaviours.follow_up.status).toBe("not_relevant");
    // The seller did write again a day later: done, whatever the model said.
    expect(applyRules(base, followUpSituation(lead([["customer", 0], ["seller", 1], ["seller", 30]]), now10)).behaviours.follow_up.status).toBe("done");
    // Waiting without a follow-up: the model decides missing or not relevant (a closing message) …
    const waiting = followUpSituation(lead([["customer", 0], ["seller", 1]]), now10);
    expect(applyRules(base, waiting).behaviours.follow_up).toEqual({ status: "missing", reason: "Ingen uppföljning." });
    const closing = { ...base, behaviours: { ...base.behaviours, follow_up: { status: "not_relevant" as const, reason: "" } } };
    expect(applyRules(closing, waiting).behaviours.follow_up.status).toBe("not_relevant");
    // … but can never claim a follow-up that HubSpot does not show.
    const claimed = { ...base, behaviours: { ...base.behaviours, follow_up: { status: "done" as const, reason: "" } } };
    expect(applyRules(claimed, waiting).behaviours.follow_up.status).toBe("missing");
  });

  it("changes the fingerprint when the follow-up step changes, not otherwise", () => {
    const l = lead([["customer", 0], ["seller", 1]]);
    const day1 = sourceFingerprint(l, new Date(at(25)));
    expect(sourceFingerprint(l, new Date(at(30)))).toBe(day1);
    expect(sourceFingerprint(l, new Date(at(24 * 4)))).not.toBe(day1);
  });
});

describe("message text", () => {
  it("uses HubSpot's HTML version when the plain text is empty, without quoted history", () => {
    const html =
      '<div>Hej!<br>Offerten är bifogad &amp; klar.</div><p>Mvh&nbsp;Sälja</p><blockquote>Gammal text</blockquote><div class="gmail_quote">Den 1 sep skrev …</div>';
    expect(htmlToText(html)).toBe("Hej!\nOfferten är bifogad & klar.\nMvh Sälja");
    const m = { ...sellerMessage(T0, ""), richText: html };
    expect(messageText(m)).toContain("Offerten är bifogad");
    expect(messageText({ ...m, text: "Plain" })).toBe("Plain");
  });
});

describe("customer wrote last", () => {
  it("is set for a lead with a registered reply that ends with the customer", () => {
    const ctx = { inboxId: "900001", formNames: new Map<string, string>() };
    const ended = normalizeThread(thread({ id: "1", createdAt: T0 }), [customerMessage(T0, "Hej"), sellerMessage(at(1), "Svar"), customerMessage(at(2), "Mitt personnummer …")], ctx);
    expect(ended.ok && ended.lead.row.customerWroteLast).toBe(true);
    const answered = normalizeThread(thread({ id: "2", createdAt: T0 }), [customerMessage(T0, "Hej"), sellerMessage(at(1), "Svar")], ctx);
    expect(answered.ok && answered.lead.row.customerWroteLast).toBe(false);
    // Without any registered reply it is "no registered reply", not "customer wrote last".
    const none = normalizeThread(thread({ id: "3", createdAt: T0 }), [customerMessage(T0, "Hej")], ctx);
    expect(none.ok && none.lead.row).toMatchObject({ status: "no_registered_reply", customerWroteLast: false });
  });
});

describe("AI text before saving", () => {
  it("drops reasons and observations that contain personal data", () => {
    const known = { customer: [SYNTHETIC_CUSTOMER.name], sellers: new Map([["Sälja Säljarsson", "Säljare 1"]]) };
    const dirty: RawClassification = {
      ...base,
      behaviours: { ...base.behaviours, next_step: { status: "missing", reason: `Ring ${SYNTHETIC_CUSTOMER.name} på 070-000 00 07.` } },
      observations: ["Säljaren svarade snabbt.", "Sälja borde ha ringt.", "Mejla kund@folke.example."],
    };
    const clean = sanitiseClassification(dirty, known);
    expect(clean.behaviours.next_step).toEqual({ status: "missing", reason: "" });
    expect(clean.observations).toEqual(["Säljaren svarade snabbt."]);
  });
});

describe("messages without text", () => {
  it("recognises a seller e-mail with only a greeting and signature", () => {
    expect(hasContent("Med Vänliga Hälsningar\n[signatur]")).toBe(false);
    expect(hasContent("Hej [kund],\n\nMvh\n[signatur]")).toBe(false);
    expect(hasContent("Hej [kund], Här kommer offerten.\nMvh\n[signatur]")).toBe(true);
    expect(hasContent("Ja, den finns kvar.")).toBe(true);
  });

  it("never lets next step be missing when the customer wrote last", () => {
    const missing = { ...base, behaviours: { ...base.behaviours, next_step: { status: "missing" as const, reason: "x" } } };
    const now = new Date(at(24 * 10));
    expect(applyRules(missing, followUpSituation(lead([["customer", 0], ["seller", 1], ["customer", 2]]), now)).behaviours.next_step.status).toBe("unclear");
    expect(applyRules(missing, followUpSituation(lead([["customer", 0], ["seller", 1]]), now)).behaviours.next_step.status).toBe("missing");
  });
});
