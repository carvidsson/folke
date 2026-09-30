import type { SourceReference } from "@/lib/domain/types";

/**
 * Canned replies for the mock AI provider. SYNTHETIC TEST DATA.
 * Keyed by assistant id; the provider picks one based on the prompt.
 */

export interface CannedReply {
  /** Lowercase keywords that make this reply a better match. */
  keywords: string[];
  content: string;
  sources: SourceReference[];
}

export const CANNED_REPLIES: Record<string, CannedReply[]> = {
  "a-sales": [
    {
      keywords: ["kampanj", "leasing", "erbjudande", "tjänstebil"],
      content: `Just nu gäller **Höstkampanj företagsleasing** [1]:

- Gäller nytecknade företagsleasingavtal
- Leverans senast **31 oktober 2026**
- Kan kombineras med serviceavtal, men inte med andra rabatter

Sommarkampanjen för servicepaket har gått ut och ska inte längre erbjudas [2].

Vill du att jag formulerar ett kort erbjudande till en kund?`,
      sources: [
        { id: "m-s1", documentId: "d-03", title: "Höstkampanj företagsleasing", excerpt: "Kampanjen gäller nytecknade företagsleasingavtal med leverans senast 31 oktober 2026. Kan inte kombineras med andra rabatter.", location: "s. 1–2" },
        { id: "m-s2", documentId: "d-04", title: "Sommarkampanj servicepaket", excerpt: "Kampanjperiod 1 juni – 31 augusti 2026.", location: "s. 1" },
      ],
    },
    {
      keywords: ["mejl", "mail", "skriv", "kund", "provkör"],
      content: `Här är ett förslag:

**Ämne:** Tack för besöket

Hej [Namn],

Tack för att du besökte oss! Jag hoppas att provkörningen gav en bra bild av bilen. Jag har sammanställt de uppgifter vi pratade om och skickar gärna ett konkret förslag när det passar dig.

Hör av dig om du har frågor – du når mig enklast på det här mejlet.

Vänliga hälsningar
[Ditt namn]

Tonen följer riktlinjerna för kundkommunikation [1].`,
      sources: [
        { id: "m-s3", documentId: "d-06", title: "Tonalitet i kundkommunikation", excerpt: "Skriv personligt och kortfattat. Avsluta med ett tydligt nästa steg.", location: "s. 3" },
      ],
    },
    {
      keywords: [],
      content: `Utifrån modellprogrammet för 2027 kan jag hjälpa dig med detta [1].

**Att tänka på**
- Kontrollera alltid aktuell utrustningsnivå mot beställningsunderlaget [2].
- Priser och kampanjvillkor ska hämtas från gällande kampanjdokument.

Berätta gärna mer om kundens behov så kan jag ge ett mer konkret förslag.`,
      sources: [
        { id: "m-s4", documentId: "d-01", title: "Modellprogram 2027 – elbilar", excerpt: "Översikt över modeller, batterikapacitet, räckvidd enligt WLTP och laddeffekt.", location: "s. 4–9" },
        { id: "m-s5", documentId: "d-02", title: "Utrustningsnivåer och tillval – SUV", excerpt: "Tre utrustningsnivåer: Bas, Plus och Premium.", location: "s. 2" },
      ],
    },
  ],
  "a-analysis": [
    {
      keywords: [],
      content: `Här är en första analys (syntetiska exempelsiffror):

| Nyckeltal | Utfall | Budget | Avvikelse |
|---|---:|---:|---:|
| Omsättning | 48,2 mkr | 46,5 mkr | +3,7 % |
| Bruttomarginal | 9,8 % | 10,2 % | −0,4 pe |
| Personalkostnad | 7,1 mkr | 6,9 mkr | +2,9 % |

**Tolkning**
Omsättningen ligger över budget, men marginalen är något svagare. Den högre personalkostnaden förklaras främst av inhyrd personal i verkstaden [1].

Vill du att jag tar fram ett underlag per anläggning?`,
      sources: [
        { id: "m-a1", documentId: "d-07", title: "Månadsrapport augusti 2026", excerpt: "Resultaträkning per enhet samt kommentarer till avvikelser.", location: "Flik: Sammanfattning" },
        { id: "m-a2", documentId: "d-08", title: "Budget 2026 per anläggning", excerpt: "Budgeterade belopp per månad och anläggning.", location: "Flik: Månad" },
      ],
    },
  ],
  "a-meetings": [
    {
      keywords: [],
      content: `**Sammanfattning**
Mötet fokuserade på prioriteringar inför kommande kvartal och fördelning av ansvar.

**Beslut**
- Arbetet prioriteras enligt föreslagen ordning.
- Uppföljning sker på nästa ordinarie möte.

**Åtgärder**
| Åtgärd | Ansvarig | Klart |
|---|---|---|
| Sammanställa underlag | [Namn] | [Datum] |
| Informera berörda team | [Namn] | [Datum] |

**Öppna frågor**
- Behöver budgeten justeras?

Strukturen följer mallen för mötesprotokoll [1]. Klistra gärna in dina anteckningar så fyller jag i namn och datum.`,
      sources: [
        { id: "m-m1", documentId: "d-11", title: "Mall för mötesprotokoll", excerpt: "Protokollet struktureras i sammanfattning, beslut, åtgärder (ansvarig, datum) och öppna frågor.", location: "s. 1" },
      ],
    },
  ],
  "a-warranty": [
    {
      keywords: ["batteri", "högvolt", "laddkabel", "laddning"],
      content: `Batterigarantin för högvoltssystemet gäller i **8 år eller 160 000 km**, beroende på vad som inträffar först [1].

**Omfattas**
- Battericeller och moduler
- Batteriets styrenhet (BMS)

**Omfattas inte**
- Extern laddutrustning – den hanteras under nybilsgarantin [2]
- Normal kapacitetsminskning över 70 % av ursprunglig kapacitet`,
      sources: [
        { id: "m-w1", documentId: "d-14", title: "Batterigaranti högvoltssystem", excerpt: "Garantin gäller 8 år eller 160 000 km. Kapacitet under 70 % inom garantitiden betraktas som fel.", location: "Avsnitt 1, s. 2" },
        { id: "m-w2", documentId: "d-13", title: "Garantivillkor nybil 2026", excerpt: "Medföljande laddutrustning omfattas av nybilsgarantin under 24 månader.", location: "Avsnitt 4.3, s. 11" },
      ],
    },
    {
      keywords: [],
      content: `För ett komplett garantiärende behöver du enligt rutinen [1]:

1. **Fordonsuppgifter** – chassinummer, mätarställning, leveransdatum
2. **Symptom** – kundens beskrivning och när felet uppstår
3. **Diagnos** – felkoder och utförda kontroller
4. **Åtgärd** – föreslagen reparation med hänvisning till villkorsavsnitt [2]
5. **Bilagor** – foton och mätprotokoll

Klistra in felkoderna så hjälper jag dig att formulera ärendebeskrivningen.`,
      sources: [
        { id: "m-w3", documentId: "d-16", title: "Rutin för garantiärenden", excerpt: "Ärendet ska innehålla fordonsuppgifter, symptom, diagnos, åtgärd och bilagor.", location: "Bild 4–7" },
        { id: "m-w4", documentId: "d-13", title: "Garantivillkor nybil 2026", excerpt: "Allmänna villkor för nybilsgaranti.", location: "Avsnitt 2" },
      ],
    },
  ],
};
