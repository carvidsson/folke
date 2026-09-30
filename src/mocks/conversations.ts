import type { Conversation, Message } from "@/lib/domain/types";

import { DEMO_USER_ID } from "./people";
import { ago } from "./time";

/** SYNTHETIC TEST DATA. Figures, names and events are invented. */

type Offset = { minutes?: number; hours?: number; days?: number };

interface ConversationSeed {
  id: string;
  assistantId: string;
  title: string;
  startedAgo: Offset;
  messages: (Omit<Message, "createdAt" | "id"> & { at: Offset })[];
}

const SEEDS: ConversationSeed[] = [
  {
    id: "k-garanti-laddkabel",
    assistantId: "a-warranty",
    title: "Laddkabel – omfattas av nybilsgarantin?",
    startedAgo: { minutes: 40 },
    messages: [
      {
        role: "user",
        at: { minutes: 40 },
        content:
          "En kund med en elbil från mars 2025 har en laddkabel som slutat fungera. Kontakten är inte skadad. Omfattas det av nybilsgarantin?",
      },
      {
        role: "assistant",
        at: { minutes: 39 },
        content: `Ja, sannolikt. Enligt garantivillkoren räknas medföljande laddkabel som **originalutrustning** och omfattas av nybilsgarantin i 24 månader från leveransdatum [1].

**Förutsättningar**
- Kabeln ska vara den som levererades med bilen.
- Det får inte finnas yttre mekanisk skada, t.ex. klämskador eller brännmärken på kontakten [1].
- Felet ska kunna verifieras med laddfelskod eller mätprotokoll.

**Inför ärendet behöver du**
1. Fordonets chassinummer och leveransdatum
2. Laddfelskod från bilens logg
3. Foto på kabel och kontakt från båda sidor

Batterigarantin för högvoltssystemet gäller inte här – den omfattar bara batteripaketet och dess styrenhet [2].`,
        sources: [
          { id: "s-1", documentId: "d-13", title: "Garantivillkor nybil 2026", excerpt: "Medföljande laddutrustning betraktas som originalutrustning och omfattas av nybilsgarantin under 24 månader från leveransdatum, förutsatt att ingen yttre mekanisk skada föreligger.", location: "Avsnitt 4.3, s. 11" },
          { id: "s-2", documentId: "d-14", title: "Batterigaranti högvoltssystem", excerpt: "Batterigarantin omfattar högvoltsbatteriets celler, moduler och tillhörande styrenhet (BMS). Extern laddutrustning omfattas inte.", location: "Avsnitt 1.2, s. 2" },
        ],
      },
      {
        role: "user",
        at: { minutes: 36 },
        content: "Bra. Kan du skriva en kort ärendebeskrivning jag kan klistra in?",
      },
      {
        role: "assistant",
        at: { minutes: 35 },
        content: `Här är ett förslag:

> **Ärende:** Laddkabel (mode 3) ur funktion
> **Symptom:** Laddning startar inte. Bilen rapporterar laddfel vid anslutning till flera olika laddpunkter.
> **Kontroll:** Visuell kontroll utan anmärkning. Kontakt och kabelmantel oskadade.
> **Åtgärd:** Byte av laddkabel enligt garantivillkor avsnitt 4.3.
> **Bilagor:** Laddfelskod, foton på kabel och kontakt.

Komplettera med chassinummer och leveransdatum innan du skickar in.`,
        sources: [
          { id: "s-3", documentId: "d-16", title: "Rutin för garantiärenden", excerpt: "Ärendebeskrivningen ska innehålla symptom, utförd kontroll, föreslagen åtgärd samt hänvisning till tillämpligt villkorsavsnitt.", location: "Bild 7" },
        ],
      },
    ],
  },
  {
    id: "k-analys-augusti",
    assistantId: "a-analysis",
    title: "Resultat augusti per anläggning",
    startedAgo: { hours: 3 },
    messages: [
      {
        role: "user",
        at: { hours: 3 },
        content: "Sammanfatta resultatet för augusti per anläggning och peka ut största avvikelsen mot budget.",
        attachments: [{ id: "f-1", name: "kommentarer-augusti.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 48_000 }],
      },
      {
        role: "assistant",
        at: { hours: 3 },
        content: `Sammanfattning av augusti (syntetiska exempelsiffror):

| Anläggning | Rörelseresultat | Budget | Avvikelse |
|---|---:|---:|---:|
| Centrum | 2,4 mkr | 2,1 mkr | **+0,3 mkr** |
| Norr | 1,1 mkr | 1,5 mkr | **−0,4 mkr** |
| Syd | 1,8 mkr | 1,7 mkr | +0,1 mkr |

**Största avvikelsen** är Anläggning Norr, där begagnatförsäljningen låg 18 % under budget. Enligt kommentarerna i din bifogade fil förklaras det delvis av ett försenat inflöde av inbytesbilar [1].

Vill du att jag bryter ner Norr per affärsområde?`,
        sources: [
          { id: "s-4", documentId: "d-07", title: "Månadsrapport augusti 2026", excerpt: "Flik 'Resultat per enhet', rader 12–40.", location: "Flik: Resultat per enhet" },
          { id: "s-5", documentId: "d-08", title: "Budget 2026 per anläggning", excerpt: "Budgeterat rörelseresultat augusti per anläggning.", location: "Flik: Månad" },
        ],
      },
    ],
  },
  {
    id: "k-mote-ledning",
    assistantId: "a-meetings",
    title: "Ledningsgruppsmöte – beslut och åtgärder",
    startedAgo: { hours: 26 },
    messages: [
      {
        role: "user",
        at: { hours: 26 },
        content: "Här är mina anteckningar från ledningsgruppen. Sammanfatta och lista beslut och åtgärder.",
        attachments: [{ id: "f-2", name: "anteckningar-lg.txt", mimeType: "text/plain", sizeBytes: 6_400 }],
      },
      {
        role: "assistant",
        at: { hours: 26 },
        content: `**Sammanfattning**
Mötet behandlade höstens kampanjplan, bemanning i verkstaden inför däckskiftet och införandet av Folke.

**Beslut**
- Höstkampanjen för företagsleasing startar enligt plan.
- Extra bemanning i verkstaden under vecka 42–44.

**Åtgärder**
| Åtgärd | Ansvarig | Klart |
|---|---|---|
| Ta fram kampanjmaterial | Helena B. | 7 okt |
| Boka inhyrda tekniker | Maria E. | 3 okt |
| Utbildningsplan för Folke | Anna L. | 14 okt |

**Öppna frågor**
- Ska kampanjen även gälla privatleasing?`,
        sources: [
          { id: "s-6", documentId: "d-11", title: "Mall för mötesprotokoll", excerpt: "Protokollet struktureras i sammanfattning, beslut, åtgärder (ansvarig, datum) och öppna frågor.", location: "s. 1" },
        ],
      },
    ],
  },
  {
    id: "k-salj-provkorning",
    assistantId: "a-sales",
    title: "Uppföljningsmejl efter provkörning",
    startedAgo: { days: 2, hours: 4 },
    messages: [
      {
        role: "user",
        at: { days: 2, hours: 4 },
        content: "Skriv ett vänligt uppföljningsmejl till en kund som provkörde en elbil i helgen och var intresserad av företagsleasing.",
      },
      {
        role: "assistant",
        at: { days: 2, hours: 4 },
        content: `**Ämne:** Tack för provkörningen

Hej [Namn],

Tack för att du tog dig tid att provköra bilen i helgen! Det var roligt att höra att du uppskattade körupplevelsen.

Eftersom du nämnde företagsleasing vill jag tipsa om att vi just nu har en höstkampanj med förmånliga villkor som gäller till och med 31 oktober [1]. Jag tar gärna fram ett konkret förslag utifrån din körsträcka och önskad avtalstid.

Passar det att vi hörs en kort stund i veckan?

Vänliga hälsningar
[Ditt namn]`,
        sources: [
          { id: "s-7", documentId: "d-03", title: "Höstkampanj företagsleasing", excerpt: "Kampanjen gäller nytecknade företagsleasingavtal med leverans senast 31 oktober 2026.", location: "s. 1" },
          { id: "s-8", documentId: "d-06", title: "Tonalitet i kundkommunikation", excerpt: "Skriv personligt och kortfattat. Avsluta med ett tydligt, lågt tröskelvärde för nästa steg.", location: "s. 3" },
        ],
      },
    ],
  },
  {
    id: "k-salj-inbyte",
    assistantId: "a-sales",
    title: "Värderingsunderlag inbytesbil",
    startedAgo: { days: 4 },
    messages: [
      { role: "user", at: { days: 4 }, content: "Vilka uppgifter behöver jag samla in för ett värderingsunderlag på en inbytesbil?" },
      {
        role: "assistant",
        at: { days: 4 },
        content: `Enligt riktlinjerna för inbytesvärdering behöver du [1]:

1. Registreringsnummer och mätarställning
2. Servicehistorik (digital eller stämplad)
3. Antal nycklar
4. Skador och anmärkningar, med foton
5. Däckstatus (sommar/vinter, mönsterdjup)

Värderingen är ett **underlag** – slutligt inbytespris sätts av begagnatansvarig.`,
        sources: [
          { id: "s-9", documentId: "d-05", title: "Riktlinjer för inbytesvärdering", excerpt: "Värderingsunderlaget ska omfatta identitet, mätarställning, servicehistorik, nycklar, skador och däck.", location: "Avsnitt 2, s. 3" },
        ],
      },
    ],
  },
  {
    id: "k-analys-marginal",
    assistantId: "a-analysis",
    title: "Bruttomarginal nybil vs begagnat Q2",
    startedAgo: { days: 9 },
    messages: [
      { role: "user", at: { days: 9 }, content: "Jämför bruttomarginalen för nybil och begagnat under Q2." },
      {
        role: "assistant",
        at: { days: 9 },
        content: `Under Q2 (syntetiska exempelsiffror) var bruttomarginalen **8,2 %** för nybil och **11,6 %** för begagnat [1]. Skillnaden har ökat med 0,9 procentenheter jämfört med Q1, främst till följd av lägre inköpspriser på begagnade elbilar.`,
        sources: [
          { id: "s-10", documentId: "d-09", title: "Kvartalsrapport Q2 2026", excerpt: "Bruttomarginal per affärsområde, tabell 3.", location: "s. 8" },
        ],
      },
    ],
  },
  {
    id: "k-garanti-bulletin",
    assistantId: "a-warranty",
    title: "Bulletin om omstart av infotainment",
    startedAgo: { days: 12 },
    messages: [
      { role: "user", at: { days: 12 }, content: "Finns det någon teknisk bulletin om att infotainmentsystemet startar om under körning?" },
      {
        role: "assistant",
        at: { days: 12 },
        content: `Ja. **TB-2026-114** beskriver sporadiska omstarter av infotainmentenheten och åtgärdas med en mjukvaruuppdatering [1]. Notera att bulletinen gäller till och med 20 oktober 2026.`,
        sources: [
          { id: "s-11", documentId: "d-15", title: "Teknisk bulletin TB-2026-114 – infotainment", excerpt: "Symptom: infotainmentenheten startar om under körning. Åtgärd: uppdatera mjukvara till senaste version via verkstadsverktyget.", location: "s. 1" },
        ],
      },
    ],
  },
  {
    id: "k-mote-verkstad",
    assistantId: "a-meetings",
    title: "Planering däckskifte",
    startedAgo: { days: 21 },
    messages: [
      { role: "user", at: { days: 21 }, content: "Gör en uppföljningslista från verkstadsmötet om däckskiftet." },
      {
        role: "assistant",
        at: { days: 21 },
        content: `**Uppföljning – däckskifte**
- [ ] Öppna bokning för däckskifte i kundportalen
- [ ] Säkerställ lager av vanliga dimensioner
- [ ] Informera servicemottagare om utökade öppettider`,
      },
    ],
  },
];

function toConversation(seed: ConversationSeed, now: Date): Conversation {
  const messages: Message[] = seed.messages.map(({ at, ...m }, i) => ({
    ...m,
    id: `${seed.id}-m${i + 1}`,
    createdAt: ago(now, at),
  }));
  return {
    id: seed.id,
    assistantId: seed.assistantId,
    ownerId: DEMO_USER_ID,
    title: seed.title,
    createdAt: ago(now, seed.startedAgo),
    updatedAt: messages.at(-1)?.createdAt ?? ago(now, seed.startedAgo),
    messages,
  };
}

export function buildConversations(now: Date): Conversation[] {
  return SEEDS.map((seed) => toConversation(seed, now));
}
