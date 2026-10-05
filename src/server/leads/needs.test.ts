import { describe, expect, it } from "vitest";

import type { LeadRow } from "@/lib/leads/types";

import { prepareDialogue } from "./analysis";
import { emptyNeeds, needsFingerprint, needsNoAI, roleOf, validateNeeds, withFormLabels, type RawNeeds } from "./needs";
import type { NormalizedLead } from "./normalize";

// Synthetic dialogue (folke.example): customer, seller, customer, seller.
const row = {
  threadId: "1",
  inboxId: "900001",
  arrivedAt: "2026-09-01T08:00:00.000Z",
  arrivalWindow: "business_hours",
  channel: "form",
  source: "Blocket",
  formName: "Leadsväxel - Teststad - Alla leads",
  vehicle: "Volkswagen ID.4",
  status: "registered_reply",
} as unknown as LeadRow;
const lead: NormalizedLead = {
  row,
  parsed: null,
  dialogue: [
    { role: "customer", sellerId: null, at: "2026-09-01T08:00:00.000Z", text: "Hej! Vad blir privatleasing på 36 mån? Kan ni ta min bil i inbyte?", attachments: [], senderName: null },
    { role: "seller", sellerId: "A-1", at: "2026-09-01T09:00:00.000Z", text: "Hej! Bilen är tyvärr såld. Vill du ha företagsleasing i stället?", attachments: [], senderName: null },
    { role: "customer", sellerId: null, at: "2026-09-01T10:00:00.000Z", text: "Synd. Vi tar en liknande om ni har, gärna med finansiering.", attachments: [], senderName: null },
    { role: "seller", sellerId: "A-1", at: "2026-09-01T11:00:00.000Z", text: "Jag har en vit i lager, se länk.", attachments: [], senderName: null },
  ],
};
const prepared = prepareDialogue("D1", lead, new Map([["A-1", "Säljare 1"]]), new Map(), [], new Date("2026-09-02T00:00:00Z"), { numbered: true });
if ("blocked" in prepared) throw new Error("blocked");

function raw(partial: Partial<RawNeeds> = {}): RawNeeds {
  return {
    id: "D1",
    purpose: "purchase",
    needs: [],
    signals: [],
    requests: [],
    timeframe: "none",
    timeframe_message: 0,
    unavailable: { situation: "none", situation_message: 0, carried: "not_applicable", carried_message: 0, note: "" },
    seller_topics: [],
    evidence: "sufficient",
    ...partial,
  };
}

describe("lead-needs-1", () => {
  it("numbers the messages in the prepared text and knows who wrote each", () => {
    expect(prepared.text).toContain("[M1 · Kund, 0 min]");
    expect(prepared.text).toContain("[M2 · Säljare 1, +1 h 0 min]");
    expect(roleOf(prepared.text, 1)).toBe("customer");
    expect(roleOf(prepared.text, 2)).toBe("seller");
    expect(roleOf(prepared.text, 9)).toBeNull();
    expect(roleOf(prepared.text, 0)).toBeNull();
  });

  it("keeps the lead analysis input unchanged without numbering", () => {
    const plain = prepareDialogue("D1", lead, new Map([["A-1", "Säljare 1"]]), new Map(), [], new Date("2026-09-02T00:00:00Z"));
    expect("blocked" in plain ? "" : plain.text).toContain("[Kund, 0 min]");
    expect("blocked" in plain ? "" : plain.text).not.toContain("M1 ·");
  });

  it("drops labels that do not rest on a customer message – the seller's topics never become needs", () => {
    const v = validateNeeds(
      raw({
        needs: [
          { code: "private_leasing", stance: "expressed", message: 1, note: "Frågar om privatleasing" },
          { code: "business", stance: "expressed", message: 2, note: "Företagsleasing" },
          { code: "trade_in", stance: "expressed", message: 7, note: "Inbyte" },
        ],
        requests: [{ code: "find_alternative", message: 3, note: "Vill ha en liknande" }],
        signals: [{ code: "wants_to_buy", message: 4, note: "Säljaren" }],
        seller_topics: ["business", "private_leasing"],
      }),
      prepared,
    );
    expect(v.needs.map((n) => n.code)).toEqual(["private_leasing"]);
    expect(v.requests.map((r) => r.code)).toEqual(["find_alternative"]);
    expect(v.signals).toEqual([]);
    // A seller topic the customer had expressed is the customer's need, not a seller topic.
    expect(v.sellerTopics).toEqual(["business"]);
  });

  it("keeps a single label per code, prefers expressed over declined and the specific need over the vague one", () => {
    const v = validateNeeds(
      raw({
        needs: [
          { code: "financing", stance: "declined", message: 1, note: "" },
          { code: "financing", stance: "expressed", message: 3, note: "" },
          { code: "leasing_unspecified", stance: "expressed", message: 1, note: "" },
          { code: "private_leasing", stance: "expressed", message: 1, note: "" },
          { code: "monthly_cost", stance: "expressed", message: 1, note: "" },
        ],
      }),
      prepared,
    );
    expect(v.needs.map((n) => [n.code, n.stance])).toEqual([
      ["financing", "expressed"],
      ["private_leasing", "expressed"],
    ]);
  });

  it("requires the customer's own words for privatleasing, företag and the like", () => {
    const leasa = { ...lead, dialogue: [{ ...lead.dialogue[0], text: "Vill leasa en sådan, 1500 mil per år." }] };
    const p = prepareDialogue("D1", leasa, new Map(), new Map(), [], new Date(), { numbered: true });
    if ("blocked" in p) throw new Error("blocked");
    const v = validateNeeds(
      raw({
        needs: [
          { code: "private_leasing", stance: "expressed", message: 1, note: "" },
          { code: "business", stance: "expressed", message: 1, note: "Uppger 1 500 mil" },
          { code: "trade_in", stance: "expressed", message: 1, note: "" },
        ],
      }),
      p,
    );
    // "leasa" without "privat" is leasing of an unknown kind; a mileage is not a company.
    expect(v.needs.map((n) => n.code)).toEqual(["leasing_unspecified"]);
    expect(validateNeeds(raw({ needs: [{ code: "private_leasing", stance: "expressed", message: 1, note: "" }] }), prepared).needs.map((n) => n.code)).toEqual(["private_leasing"]);
  });

  it("gives no needs, signals or requests outside purchase dialogues", () => {
    const v = validateNeeds(raw({ purpose: "after_sales", needs: [{ code: "product_facts", stance: "expressed", message: 1, note: "" }], requests: [{ code: "call_me", message: 1, note: "" }] }), prepared);
    expect(v.purpose).toBe("after_sales");
    expect(v.needs).toEqual([]);
    expect(v.requests).toEqual([]);
  });

  it("checks the timeframe against a customer message", () => {
    expect(validateNeeds(raw({ timeframe: "soon", timeframe_message: 3 }), prepared).timeframe).toBe("soon");
    expect(validateNeeds(raw({ timeframe: "soon", timeframe_message: 2 }), prepared).timeframe).toBe("none");
  });

  it("carries the need forward only with a seller message in or after the situation", () => {
    const sold = (carried: RawNeeds["unavailable"]["carried"], carriedMessage: number, situationMessage = 2) =>
      validateNeeds(raw({ unavailable: { situation: "sold", situation_message: situationMessage, carried, carried_message: carriedMessage, note: "Såld" } }), prepared).unavailable.carried;
    expect(sold("proposed_alternative", 4)).toBe("proposed_alternative");
    // The seller's own "sold" message is the chance to carry the need forward.
    expect(sold("proposed_alternative", 2)).toBe("proposed_alternative");
    // Pointing at a customer message or before the situation: not visible (a seller message exists).
    expect(sold("proposed_alternative", 3)).toBe("not_visible");
    expect(sold("proposed_alternative", 1)).toBe("not_visible");
    // "Cannot be determined" while the seller did write in or after it: what is visible can be told.
    expect(sold("not_determinable", 0)).toBe("not_visible");
    expect(sold("not_applicable", 0)).toBe("not_visible");
    // No situation – nothing to carry.
    expect(validateNeeds(raw(), prepared).unavailable.carried).toBe("not_applicable");
  });

  it("cannot see a continuation when no seller message follows the situation", () => {
    const short = { ...lead, dialogue: lead.dialogue.slice(0, 1) };
    const p = prepareDialogue("D1", short, new Map(), new Map(), [], new Date(), { numbered: true });
    if ("blocked" in p) throw new Error("blocked");
    const v = validateNeeds(raw({ unavailable: { situation: "sold", situation_message: 1, carried: "not_visible", carried_message: 0, note: "" } }), p);
    expect(v.unavailable.carried).toBe("not_determinable");
  });

  it("drops a note that contains personal data", () => {
    const known = { ...prepared.known, customer: ["Testa Kundsson"] };
    const v = validateNeeds(raw({ needs: [{ code: "trade_in", stance: "expressed", message: 1, note: "Testa Kundsson vill byta in" }] }), { text: prepared.text, known });
    expect(v.needs[0].note).toBe("");
  });

  it("adds deterministic labels from form fields and keeps them apart from message labels", () => {
    const parsed = { hasTradeIn: true, hasCompany: true } as NormalizedLead["parsed"];
    const base = validateNeeds(raw({ purpose: "other", needs: [{ code: "leasing_unspecified", stance: "expressed", message: 1, note: "" }] }), prepared);
    const v = withFormLabels(base, { parsed, row: { ...row, formName: "generellt provkörningsformulär på sajt" } });
    expect(v.needs.map((n) => [n.code, n.source])).toEqual([
      ["trade_in", "form"],
      ["business", "form"],
    ]);
    expect(v.requests.map((r) => [r.code, r.source])).toEqual([["book_visit", "form"]]);
    expect(v.purpose).toBe("purchase");
  });

  it("does not call the model for a form with fields only", () => {
    const formOnly: NormalizedLead = { ...lead, dialogue: [{ ...lead.dialogue[0], text: "" }] };
    expect(needsNoAI(formOnly)).toBe(true);
    expect(needsNoAI(lead)).toBe(false);
    expect(emptyNeeds(formOnly).purpose).toBe("purchase");
    expect(emptyNeeds({ row: { ...row, channel: "email" } }).purpose).toBe("other");
  });

  it("fingerprints the dialogue, not the follow-up step", () => {
    const a = needsFingerprint(lead);
    expect(needsFingerprint({ ...lead })).toBe(a);
    expect(needsFingerprint({ ...lead, dialogue: [...lead.dialogue, { ...lead.dialogue[2], at: "2026-09-03T08:00:00.000Z" }] })).not.toBe(a);
  });
});
