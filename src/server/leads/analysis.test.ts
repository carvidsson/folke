import { describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";

import { applyRules, attachmentLines, followUpSituation, hasContent, prepareDialogue, sanitiseClassification, sourceFingerprint, type RawClassification } from "./analysis";
import { SYNTHETIC_CUSTOMER, customerMessage, sellerMessage, thread } from "./fixtures.test-helpers";
import { attachmentKind, htmlToText, messageText, normalizeThread, type NormalizedLead } from "./normalize";

/** Deterministic parts of the AI analysis (ADR-047). Synthetic data only. */

const T0 = "2026-09-01T08:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

function lead(roles: ["customer" | "seller", number][]): NormalizedLead {
  return {
    row: { threadId: "1", arrivedAt: T0, arrivalWindow: "business_hours", channel: "form", source: "Blocket", vehicle: null } as LeadRow,
    parsed: null,
    dialogue: roles.map(([role, h]) => ({ role, sellerId: role === "seller" ? "A-1" : null, at: at(h), text: `${role} ${h}`, senderName: null, attachments: [] })),
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
  assessment: null,
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

  it("never asserts a stall or a missed opportunity when the customer wrote last", () => {
    const assessed = {
      ...base,
      assessment: { goal: "Få en offert.", questions: [], signals: [], timeframe: "", budget: "", objections: [], infoNeeded: [], progress: "stalled" as const, progressReason: "Säljaren återkom inte.", missedOpportunity: "yes" as const, missedReason: "Säljaren återkom inte med offerten." },
    };
    const now = new Date(at(24 * 10));
    const customerLast = applyRules(assessed, followUpSituation(lead([["customer", 0], ["seller", 1], ["customer", 2]]), now)).assessment!;
    expect(customerLast).toMatchObject({ progress: "unclear", missedOpportunity: "unclear" });
    expect(customerLast.missedReason).toMatch(/går inte att avgöra från HubSpot/);
    // The seller wrote after the customer: the model's judgement stands.
    expect(applyRules(assessed, followUpSituation(lead([["customer", 0], ["seller", 1]]), now)).assessment).toMatchObject({ progress: "stalled", missedOpportunity: "yes" });
  });
});

/**
 * What Folke may conclude about how a dialogue continued (ADR-048): visible in HubSpot, not determinable
 * from HubSpot, or an explicitly stated other channel – never an assumed handover, never a failure from
 * missing text. Attachments: a file, an offer-like file by name, or an offer stated in the text.
 */
describe("continuation and attachments (regression A–E)", () => {
  const now = new Date(at(24 * 10));
  type Msg = { role: "customer" | "seller"; h: number; text: string; attachments?: ("offer_document" | "document" | "image")[] };
  const dialogue = (msgs: Msg[]): NormalizedLead => ({
    row: { threadId: "1", arrivedAt: T0, arrivalWindow: "business_hours", channel: "form", source: "Blocket", vehicle: null, responderId: "A-1" } as LeadRow,
    parsed: null,
    dialogue: msgs.map((m) => ({ role: m.role, sellerId: m.role === "seller" ? "A-1" : null, at: at(m.h), text: m.text, senderName: null, attachments: m.attachments ?? [] })),
  });
  const prepared = (l: NormalizedLead) => {
    const p = prepareDialogue("D1", l, new Map([["A-1", "Säljare 1"]]), new Map(), [], now);
    if ("blocked" in p) throw new Error("blocked");
    return p.text;
  };
  const assessed = (a: Partial<NonNullable<RawClassification["assessment"]>>): RawClassification => ({
    ...base,
    behaviours: { ...base.behaviours, next_step: { status: "missing", reason: "x" }, follow_up: { status: "missing", reason: "x" } },
    assessment: {
      goal: "Få en leasingkalkyl.",
      questions: [],
      signals: [],
      timeframe: "",
      budget: "",
      objections: [],
      infoNeeded: [],
      progress: "stalled",
      progressReason: "Säljaren återkom inte.",
      missedOpportunity: "yes",
      missedReason: "Offert saknas.",
      continuation: "visible",
      agreedNextStep: false,
      opportunities: [],
      strengths: [],
      ...a,
    },
  });

  it("A: an offer attached in HubSpot is visible to the analysis – as offer-like by name, stated by the text when it says so", () => {
    const byName = prepared(
      dialogue([
        { role: "customer", h: 0, text: "Vad kostar leasing på 1 500 mil?" },
        { role: "seller", h: 1, text: "Hej! Vilken insats tänker du dig?" },
        { role: "customer", h: 2, text: "Ingen insats." },
        { role: "seller", h: 3, text: "Mvh", attachments: ["offer_document"] },
      ]),
    );
    expect(byName).toContain("[Bilaga: offertliknande dokument enligt filnamnet (innehållet är inte läst)]");
    expect(byName).not.toContain("meddelandet anger");
    const stated = prepared(
      dialogue([
        { role: "customer", h: 0, text: "Vad kostar leasing?" },
        { role: "seller", h: 1, text: "Hej! Här kommer kalkylen enligt dina önskemål.", attachments: ["document"] },
      ]),
    );
    expect(stated).toContain("[Bilaga: dokument – meddelandet anger att en offert eller kalkyl bifogas eller skickas]");
  });

  it("B: a promised offer that later appears in HubSpot is visible – the rules leave a visible continuation alone", () => {
    const text = prepared(
      dialogue([
        { role: "customer", h: 0, text: "Kan ni räkna på en Tiguan?" },
        { role: "seller", h: 1, text: "Absolut, jag tar fram en offert." },
        { role: "seller", h: 5, text: "Hej igen!", attachments: ["offer_document"] },
      ]),
    );
    expect(text).toContain("offertliknande dokument");
    const c = applyRules(
      assessed({ continuation: "visible", progress: "moved_forward", progressReason: "Offerten skickades i HubSpot.", missedOpportunity: "no", missedReason: "" }),
      followUpSituation(dialogue([{ role: "customer", h: 0, text: "" }, { role: "seller", h: 1, text: "" }, { role: "seller", h: 5, text: "" }]), now),
    );
    expect(c.assessment).toMatchObject({ continuation: "visible", progress: "moved_forward" });
    expect(c.assessment!.progressReason).not.toMatch(/går inte att avgöra/);
  });

  it("C: the customer leaves the offer basis and nothing more is visible – not determinable, never a missed opportunity or an assumed handover", () => {
    const l = dialogue([
      { role: "customer", h: 0, text: "Vad blir leasingen?" },
      { role: "seller", h: 1, text: "Jag behöver ditt personnummer för försäkringspriset." },
      { role: "customer", h: 2, text: "Här är det." },
    ]);
    const c = applyRules(assessed({ continuation: "not_determinable" }), followUpSituation(l, now));
    expect(c.assessment).toMatchObject({ progress: "unclear", missedOpportunity: "unclear" });
    expect(c.assessment!.missedReason).toMatch(/går inte att avgöra från HubSpot/);
    expect(c.behaviours.next_step.status).toBe("unclear");
    expect(c.behaviours.follow_up.status).toBe("not_relevant");
    expect(JSON.stringify(c)).not.toMatch(/utanför HubSpot|offert saknas|följde inte upp|tappade fart/i);
    // The seller wrote last ("offer coming") and the customer is silent: still not determinable, not "no follow-up".
    const promised = dialogue([
      { role: "customer", h: 0, text: "Vad blir leasingen?" },
      { role: "seller", h: 1, text: "Jag tar fram en offert." },
    ]);
    const p = applyRules(assessed({ continuation: "not_determinable" }), followUpSituation(promised, now));
    expect(p.behaviours.follow_up.status).toBe("unclear");
    expect(p.assessment).toMatchObject({ progress: "unclear", missedOpportunity: "unclear" });
  });

  it("D: the seller says they will call – a stated next step by phone; nothing is claimed about the call", () => {
    const l = dialogue([
      { role: "customer", h: 0, text: "Jag har många frågor om leasing." },
      { role: "seller", h: 1, text: "Jag ringer dig i eftermiddag så går vi igenom dem." },
    ]);
    const c = applyRules(assessed({ continuation: "stated_other_channel" }), followUpSituation(l, now));
    expect(c.behaviours.next_step.status).toBe("done");
    expect(c.behaviours.follow_up).toMatchObject({ status: "unclear" });
    expect(c.assessment).toMatchObject({ progress: "unclear", missedOpportunity: "unclear" });
    expect(c.assessment!.progressReason).toMatch(/per telefon eller i annan kanal\. Vad som hände då syns inte i HubSpot/);
    // A visible opportunity in the same dialogue (the seller wrote after it) is kept.
    const visible = applyRules(assessed({ continuation: "stated_other_channel", opportunities: ["unanswered_questions"] }), followUpSituation(l, now));
    expect(visible.assessment!.missedOpportunity).toBe("yes");
  });

  it("E: an ordinary attachment is never called an offer, and file names never reach the text", () => {
    const text = prepared(
      dialogue([
        { role: "customer", h: 0, text: "Hur ser bilen ut inuti?" },
        { role: "seller", h: 1, text: "Hej! Se bilder.", attachments: ["image", "document"] },
      ]),
    );
    expect(text).toContain("[Bilaga: bild]");
    expect(text).toContain("[Bilaga: dokument (vad det innehåller framgår inte)]");
    expect(text).not.toMatch(/offert/i);
    expect(attachmentKind({ type: "FILE", name: "IMG_2041.jpg", fileUsageType: "IMAGE" })).toBe("image");
    expect(attachmentKind({ type: "FILE", name: "Broschyr ID.4.pdf", fileUsageType: "OTHER" })).toBe("document");
    expect(attachmentKind({ type: "FILE", name: "Offert Testsson ID.4.pdf", fileUsageType: "OTHER" })).toBe("offer_document");
    expect(attachmentLines(["offer_document"], "")).not.toContain("Testsson");
    // A greeting-only message without any attachment is said to have neither text nor attachment.
    expect(prepared(dialogue([{ role: "customer", h: 0, text: "Hej" }, { role: "seller", h: 1, text: "Mvh" }]))).toContain("(meddelande utan eget innehåll och utan bilaga i HubSpot)");
  });

  it("an agreed next step is progress even when the customer wrote last", () => {
    const l = dialogue([
      { role: "customer", h: 0, text: "Kan jag provköra på lördag?" },
      { role: "seller", h: 1, text: "Lördag kl 11 fungerar." },
      { role: "customer", h: 2, text: "Tack, då ses vi på lördag." },
    ]);
    const c = applyRules(assessed({ agreedNextStep: true, continuation: "visible", progress: "stalled" }), followUpSituation(l, now));
    expect(c.assessment!.progress).toBe("moved_forward");
    expect(c.behaviours.next_step.status).toBe("done");
  });
});
