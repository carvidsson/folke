import type {
  Assistant,
  AssistantGrant,
  KnowledgeCollection,
} from "@/lib/domain/types";

/** SYNTHETIC TEST DATA. */

export const ASSISTANTS: Assistant[] = [
  {
    id: "a-sales",
    slug: "salj",
    name: "Säljassistenten",
    tagline: "Kundkommunikation, kampanjer och produktinformation",
    description:
      "Hjälper säljare att formulera kundutskick, hitta rätt kampanjvillkor, jämföra modeller och ta fram enklare värderingsunderlag.",
    icon: "sales",
    tone: "sage",
    status: "active",
    managerIds: ["u-03"],
    collectionIds: ["c-products", "c-campaigns", "c-policies"],
    instructions:
      "Du är Säljassistenten i Folke. Du hjälper säljare med kundkommunikation, kampanjer och produktinformation. Hänvisa alltid till källdokument för priser och kampanjvillkor. Lämna aldrig bindande prisuppgifter.",
    suggestedPrompts: [
      "Skriv ett uppföljningsmejl efter en provkörning",
      "Vilka kampanjer gäller för tjänstebilar just nu?",
      "Jämför räckvidd och laddtid mellan två elbilsmodeller",
      "Ta fram ett värderingsunderlag för en inbytesbil",
    ],
  },
  {
    id: "a-analysis",
    slug: "analys",
    name: "Analysassistenten",
    tagline: "Ekonomidata och verksamhetsrapporter",
    description:
      "Analyserar ekonomiska rapporter och nyckeltal, sammanfattar avvikelser och hjälper till att ta fram beslutsunderlag.",
    icon: "analysis",
    tone: "slate",
    status: "active",
    managerIds: ["u-04"],
    collectionIds: ["c-finance"],
    instructions:
      "Du är Analysassistenten i Folke. Du analyserar ekonomidata och verksamhetsrapporter. Var tydlig med vilka siffror som kommer från vilka rapporter och markera osäkerheter.",
    suggestedPrompts: [
      "Sammanfatta resultatet för augusti per anläggning",
      "Vilka kostnadsposter avviker mest mot budget?",
      "Jämför bruttomarginal nybil och begagnat senaste kvartalet",
      "Förbered underlag till ledningsgruppens månadsmöte",
    ],
  },
  {
    id: "a-meetings",
    slug: "mote",
    name: "Mötesassistenten",
    tagline: "Sammanfattningar, beslut och uppföljning",
    description:
      "Sammanfattar mötesanteckningar, identifierar beslut och ansvariga och skapar tydliga uppföljningslistor.",
    icon: "meetings",
    tone: "sand",
    status: "active",
    managerIds: ["u-01"],
    collectionIds: ["c-meetings"],
    instructions:
      "Du är Mötesassistenten i Folke. Sammanfatta mötesanteckningar strukturerat: sammanfattning, beslut, åtgärder med ansvarig och datum, öppna frågor.",
    suggestedPrompts: [
      "Sammanfatta anteckningarna från dagens möte",
      "Lista alla beslut och vem som äger dem",
      "Skapa en uppföljningslista med deadlines",
      "Skriv ett kort utskick till deltagarna",
    ],
  },
  {
    id: "a-warranty",
    slug: "garanti",
    name: "Garantiassistenten",
    tagline: "Garantivillkor och ärendeförberedelse",
    description:
      "Söker i garantivillkor och tekniska bulletiner och hjälper verkstaden att förbereda kompletta garantiärenden.",
    icon: "warranty",
    tone: "clay",
    status: "active",
    managerIds: ["u-05"],
    collectionIds: ["c-warranty"],
    instructions:
      "Du är Garantiassistenten i Folke. Du hjälper verkstadsmedarbetare att tolka garantivillkor och förbereda garantiärenden. Citera alltid aktuellt villkorsdokument och ange giltighetsperiod.",
    suggestedPrompts: [
      "Omfattas ett byte av laddkabel inom nybilsgarantin?",
      "Vilka uppgifter behövs för ett garantiärende på drivlina?",
      "Finns det en teknisk bulletin om infotainment-omstarter?",
      "Förbered en ärendebeskrivning utifrån felkoderna",
    ],
  },
];

export const COLLECTIONS: KnowledgeCollection[] = [
  { id: "c-products", name: "Produktinformation", description: "Modellprogram, specifikationer och utrustningsnivåer." },
  { id: "c-campaigns", name: "Kampanjer", description: "Aktuella kampanjer, erbjudanden och villkor." },
  { id: "c-policies", name: "Riktlinjer", description: "Interna riktlinjer och rutiner." },
  { id: "c-finance", name: "Ekonomi", description: "Månads- och kvartalsrapporter, budget och prognoser." },
  { id: "c-meetings", name: "Möten", description: "Mötesmallar, protokollrutiner och stående agendor." },
  { id: "c-warranty", name: "Garanti", description: "Garantivillkor, tekniska bulletiner och ärendemallar." },
];

export const ASSISTANT_GRANTS: AssistantGrant[] = [
  { id: "ag-01", assistantId: "a-sales", subject: { type: "group", groupId: "g-sales" } },
  { id: "ag-02", assistantId: "a-sales", subject: { type: "group", groupId: "g-leadership" } },
  { id: "ag-03", assistantId: "a-sales", subject: { type: "user", userId: "u-13" } },
  { id: "ag-04", assistantId: "a-analysis", subject: { type: "group", groupId: "g-leadership" } },
  { id: "ag-05", assistantId: "a-analysis", subject: { type: "group", groupId: "g-finance" } },
  { id: "ag-06", assistantId: "a-meetings", subject: { type: "group", groupId: "g-all" } },
  { id: "ag-07", assistantId: "a-warranty", subject: { type: "group", groupId: "g-workshop" } },
  { id: "ag-08", assistantId: "a-warranty", subject: { type: "group", groupId: "g-warranty" } },
  { id: "ag-09", assistantId: "a-warranty", subject: { type: "user", userId: "u-01" } },
];
