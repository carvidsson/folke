import { describe, expect, it } from "vitest";

import { SYNTHETIC_CUSTOMER } from "./fixtures.test-helpers";
import { leaksPersonalData, maskRareCapitalised, pseudonymise, redactText, type KnownPersonalData } from "./redact";

const known: KnownPersonalData = {
  customer: [SYNTHETIC_CUSTOMER.name, SYNTHETIC_CUSTOMER.email, SYNTHETIC_CUSTOMER.phone],
  sellers: new Map([["Sälja Säljarsson", "Säljare 1"]]),
};

describe("redaction", () => {
  it("removes contact details, personnummer, plates and links", () => {
    const text = [
      "Mejla annan.person@folke.example eller ring +46 70 000 00 09 eller 0700000008 eller 031-00 00 07.",
      "Mitt personnummer är 19900101-0000 och 900101 0000.",
      "Min bil har regnr ABC12D, se https://www.example.com/bil?id=1.",
    ].join("\n");
    const out = redactText(text, known);
    expect(out).not.toMatch(/@|\+46|0700000008|031-00|19900101|900101 0000|ABC12D|https?:/);
    expect(out).toContain("[e-post]");
    expect(out).toContain("[telefon]");
    expect(out).toContain("[personnummer]");
    expect(out).toContain("[regnr]");
    expect(out).toContain("[länk]");
  });

  it("keeps business context: cars, prices, engine codes", () => {
    const out = redactText("Golf GTI 245 hk och Passat TDI 150 för 299 900 kr, leverans vecka 42.", known);
    expect(out).toBe("Golf GTI 245 hk och Passat TDI 150 för 299 900 kr, leverans vecka 42.");
  });

  it("replaces known names, pseudonymises sellers and masks greetings", () => {
    const out = redactText(
      "Hej Testa!\nTack för ditt intresse. Sälja hjälper dig.\nHälsningar\nSälja Säljarsson\nSäljare, Teststad\n070-000 00 05",
      known,
    );
    expect(out).toContain("Hej [kund]!");
    expect(out).toContain("Säljare 1 hjälper dig.");
    expect(out).toContain("[signatur]");
    expect(out).not.toMatch(/Testa|Säljarsson|Teststad|070-000/);
  });

  it("replaces HubSpot's sender display name as a whole and keeps business words", () => {
    // Verified shape: "<seller> <mailbox name>". "Bil" must not become a name part.
    const withDisplayName: KnownPersonalData = { ...known, literals: new Map([["Sälja Säljarsson Börjessons Bil", "Säljare 1"]]) };
    const out = redactText("Bilen finns kvar hos Börjessons Bil.\n/Sälja Säljarsson Börjessons Bil", withDisplayName);
    expect(out).toBe("Bilen finns kvar hos Börjessons Bil.\n/Säljare 1");
    expect(leaksPersonalData(`bil: Volkswagen Golf\n${out}`, withDisplayName)).toBe(false);
    expect(leaksPersonalData("Hälsningar Sälja Säljarsson Börjessons Bil", withDisplayName)).toBe(true);
  });

  it("masks greetings to names it does not know", () => {
    expect(redactText("Hej Okänd, tack för mejlet.", known)).toBe("Hej [namn], tack för mejlet.");
  });

  it("drops quoted e-mail history", () => {
    const out = redactText("Låter bra!\n\nDen 1 sep. 2026 skrev Testa Kundsson <x@folke.example>:\n> Hej igen\n> Gammal text", known);
    expect(out).toBe("Låter bra!");
  });

  it("detects anything that slipped through", () => {
    expect(leaksPersonalData("Skriv till a@folke.example", known)).toBe(true);
    expect(leaksPersonalData("Ring 070-000 00 06", known)).toBe(true);
    expect(leaksPersonalData("Personnummer 19900101-0000", known)).toBe(true);
    expect(leaksPersonalData("Hälsa Kundsson", known)).toBe(true);
    expect(leaksPersonalData("Säljare 1 svarade [kund] om priset 299 900 kr.", known)).toBe(false);
  });

  it("masks rare capitalised words that may be unknown names, and keeps ordinary ones", () => {
    const [first, second] = maskRareCapitalised([
      "Min fru Lisa vill provköra en Tiguan. Vi kommer på Fredag.",
      "Har ni en Tiguan i blått? Det gäller en bil till Lisa och mig, men Elbil är också intressant och en elbil kan passa.",
    ]);
    // "Lisa" occurs in two dialogues here, so the run-level rule keeps it – the per-dialogue check is the main line.
    expect(first).toBe("Min fru Lisa vill provköra en Tiguan. Vi kommer på Fredag.");
    expect(second).toContain("men Elbil är");
    const [single] = maskRareCapitalised(["Jag pratade med min granne Jonte om en Tiguan och en Polo."]);
    expect(single).toBe("Jag pratade med min granne [namn] om en Tiguan och en Polo.");
  });

  // Regressions from the validation against real (redacted) dialogues, 2026-10-03.
  it("masks an unknown name right after a redaction marker or glued to a time", () => {
    const [text] = maskRareCapitalised(["Mitt personnummer är: [personnummer] Zelmira [namn]. Jag vill ha 0 kr i insats."]);
    expect(text).toBe("Mitt personnummer är: [personnummer] [namn] [namn]. Jag vill ha 0 kr i insats.");
    const [glued] = maskRareCapitalised(["Hälsningar från 17:21Zelmira"]);
    expect(glued).toBe("Hälsningar från 17:21[namn]");
    // Line starts are sentence starts and are kept.
    expect(maskRareCapitalised(["Hej!\nTiguan låter bra."])[0]).toBe("Hej!\nTiguan låter bra.");
  });

  it("finds a known name even when a quoted header glues it to a time", () => {
    expect(leaksPersonalData("Den fre 4 sep. 2026 17:21Sälja", known)).toBe(true);
    expect(redactText("Hej!\nKvarvarande text 17:21Sälja", known)).toContain("17:21Säljare 1");
  });

  it("drops quoted history in the header shapes seen in HubSpot", () => {
    const headers = [
      "Den fre 4 sep. 2026 17:21Sälja Säljarsson från Börjessons Bil <",
      "lör 5 sep. 2026 kl. 09:28 skrev Säljare 1 <",
      "8 sep. 2026 kl. 09:09 skrev Säljare 2 <[e-post]>:",
      "tisdag 8 september 2026 08:15:00 +0200, <forsaljning@folke.example<mailto:forsaljning@folke.example>>:",
      "On Tue, Sep 8, 2026 at 9:09 AM Sälja <salja@folke.example> wrote:",
      "Från: Sälja Säljarsson",
      "-----Original Message-----",
    ];
    for (const header of headers) {
      expect(redactText(`Tack, låter bra!\n\n${header}\nKälla: Blocket\nNamn: ${SYNTHETIC_CUSTOMER.name}`, known), header).toBe("Tack, låter bra!");
    }
    // An ordinary line with a year is not a quote header.
    expect(redactText("Leverans tidigast 2026 vecka 12:\nDet passar oss.", known)).toBe("Leverans tidigast 2026 vecka 12:\nDet passar oss.");
    expect(redactText("Ja tack!\nSkickat från min iPhone", known)).toBe("Ja tack!");
  });

  it("gives stable pseudonyms in order of first appearance", () => {
    const map = pseudonymise(["A-2", "A-1", "A-2", "A-3"]);
    expect([...map]).toEqual([
      ["A-2", "Säljare 1"],
      ["A-1", "Säljare 2"],
      ["A-3", "Säljare 3"],
    ]);
  });
});
