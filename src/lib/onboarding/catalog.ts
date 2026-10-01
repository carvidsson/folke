import type { AnswerLength, WritingOption, WritingTone } from "@/lib/domain/preferences";

/**
 * Fixed, quality-checked examples for the onboarding and the instant
 * preview under Mina AI-inställningar. Choosing between them never calls an
 * AI model. Fictional content only – no real customers, prices or terms.
 *
 * Answer settings (how Folke answers questions) and writing settings (texts
 * Folke writes on the user's behalf) are kept apart, like in the stored
 * preferences.
 */

// ---------------------------------------------------------------------------
// Step 1: answer length
// ---------------------------------------------------------------------------

export const ANSWER_EXAMPLE_QUESTION = "Hur lång är leveranstiden för en ny bil just nu?";

export const ANSWER_EXAMPLES: Record<AnswerLength, string> = {
  short: "Normalt 10–12 veckor från order. Lagerbilar kan levereras på 1–2 veckor.",
  balanced:
    "Leveranstiden är normalt 10–12 veckor från order.\n\nFör bilar som redan finns i lager kan leverans ske på 1–2 veckor. Ange gärna modell och utrustning, så kan jag kontrollera mer exakt.",
  detailed:
    "Leveranstiden är normalt 10–12 veckor från order.\n\n**Det här påverkar tiden**\n- **Lagerbilar** finns redan i Sverige och kan levereras på 1–2 veckor.\n- **Fabriksbeställda bilar** byggs efter order, och då gäller 10–12 veckor.\n- **Extrautrustning** som monteras efter leverans kan lägga till ungefär en vecka.\n\nOm kunden har ett datum att passa är det säkrast att välja en lagerbil eller stämma av med försäljningsansvarig innan ni lovar något.",
};

// ---------------------------------------------------------------------------
// Step 2 and 3: writing style, composed from parts so the preview reacts
// instantly to tone and quick options.
// ---------------------------------------------------------------------------

export const WRITING_EXAMPLE_CONTEXT = "Bekräfta en provkörning med kunden Anna på torsdag kl. 14.";

type Phrase = string | { jag: string; vi: string };
interface Sentence {
  text: Phrase;
  /** Left out when the user prefers short e-mails. */
  extra?: boolean;
}
interface MailTemplate {
  subject: string;
  greeting: string;
  sentences: Sentence[];
  closing: string;
}

const MAILS: Record<WritingTone | "formal_relaxed", MailTemplate> = {
  professional: {
    subject: "Bekräftelse av provkörning torsdag kl. 14",
    greeting: "Hej Anna,",
    sentences: [
      { text: { jag: "Jag bekräftar din provkörning på torsdag kl. 14.", vi: "Vi bekräftar din provkörning på torsdag kl. 14." } },
      { text: "Bilen står klar vid entrén när du kommer." },
      { text: "Provkörningen tar ungefär 30 minuter, och du behöver ta med körkort.", extra: true },
      { text: { jag: "Hör av dig om tiden behöver ändras.", vi: "Hör av dig till oss om tiden behöver ändras." }, extra: true },
    ],
    closing: "Med vänliga hälsningar",
  },
  personal: {
    subject: "Välkommen på provkörning på torsdag",
    greeting: "Hej Anna!",
    sentences: [
      {
        text: {
          jag: "Vad roligt att du vill provköra. Jag ser fram emot att ses på torsdag kl. 14.",
          vi: "Vad roligt att du vill provköra. Vi ser fram emot att ses på torsdag kl. 14.",
        },
      },
      { text: { jag: "Jag har bilen redo när du kommer.", vi: "Vi har bilen redo när du kommer." } },
      { text: "Turen tar ungefär en halvtimme, så du hinner känna efter ordentligt. Glöm inte körkortet.", extra: true },
      { text: "Säg bara till om tiden inte passar.", extra: true },
    ],
    closing: "Vänliga hälsningar",
  },
  formal: {
    subject: "Bekräftelse: provkörning torsdagen kl. 14.00",
    greeting: "Bästa Anna,",
    sentences: [
      {
        text: {
          jag: "Härmed bekräftar jag Er bokade provkörning torsdagen kl. 14.00.",
          vi: "Härmed bekräftar vi Er bokade provkörning torsdagen kl. 14.00.",
        },
      },
      { text: "Fordonet finns tillgängligt vid vår entré." },
      { text: "Provkörningen beräknas omfatta cirka 30 minuter. Vänligen medtag giltigt körkort.", extra: true },
      {
        text: { jag: "Vänligen kontakta mig om tiden behöver ändras.", vi: "Vänligen kontakta oss om tiden behöver ändras." },
        extra: true,
      },
    ],
    closing: "Med vänlig hälsning",
  },
  // "Undvik alltför formellt språk" softens the formal style.
  formal_relaxed: {
    subject: "Bekräftelse av provkörning torsdag kl. 14",
    greeting: "Hej Anna,",
    sentences: [
      { text: { jag: "Jag bekräftar din bokade provkörning på torsdag kl. 14.", vi: "Vi bekräftar din bokade provkörning på torsdag kl. 14." } },
      { text: "Bilen finns vid vår entré." },
      { text: "Provkörningen tar ungefär 30 minuter. Ta gärna med körkort.", extra: true },
      { text: { jag: "Kontakta mig om tiden behöver ändras.", vi: "Kontakta oss om tiden behöver ändras." }, extra: true },
    ],
    closing: "Med vänlig hälsning",
  },
};

export interface ExampleMail {
  subject: string;
  body: string;
  words: number;
}

/** The example e-mail for a tone and quick options (deterministic, no AI). */
export function composeExampleMail(tone: WritingTone, options: readonly WritingOption[] = []): ExampleMail {
  const template = tone === "formal" && options.includes("less_formal") ? MAILS.formal_relaxed : MAILS[tone];
  const form = options.includes("we_form") ? "vi" : "jag";
  const sentences = template.sentences
    .filter((s) => !(s.extra && options.includes("short_emails")))
    .map((s) => (typeof s.text === "string" ? s.text : s.text[form]));
  const body = `${template.greeting}\n\n${sentences.join(" ")}\n\n${template.closing}`;
  return { subject: template.subject, body, words: body.split(/\s+/).filter(Boolean).length };
}

/** Small before/after examples for each quick option. */
export const WRITING_OPTION_EXAMPLES: Record<WritingOption, { before: string; after: string }> = {
  no_emojis: { before: "Vi ses på torsdag! 🙂", after: "Vi ses på torsdag." },
  no_long_dashes: { before: "Bilen är klar – välkommen in!", after: "Bilen är klar. Välkommen in!" },
  we_form: { before: "Jag bekräftar din provkörning.", after: "Vi bekräftar din provkörning." },
  short_emails: { before: "Ett mejl med alla detaljer och flera stycken.", after: "Ett kort mejl med det viktigaste." },
  less_formal: { before: "Vänligen medtag giltigt körkort.", after: "Ta gärna med körkort." },
};

// ---------------------------------------------------------------------------
// Optional introduction to the interface
// ---------------------------------------------------------------------------

export type IntroIcon = "new-chat" | "assistant" | "sources" | "history" | "settings";

export const INTRO_STEPS: { icon: IntroIcon; title: string; text: string }[] = [
  {
    icon: "new-chat",
    title: "Starta en konversation",
    text: "Klicka på Ny chatt i sidomenyn, eller skriv direkt i rutan på startsidan.",
  },
  {
    icon: "assistant",
    title: "Välj assistent",
    text: "Varje assistent är gjord för ett område, till exempel försäljning eller garanti. Välj den överst i chatten.",
  },
  {
    icon: "sources",
    title: "Kontrollera källorna",
    text: "Under svaren visas källorna. Klicka på en källa för att se utdraget och vilken sida det kommer från.",
  },
  {
    icon: "history",
    title: "Hitta tidigare konversationer",
    text: "Dina konversationer finns i sidomenyn och under Alla konversationer. Bara du kan se dem.",
  },
  {
    icon: "settings",
    title: "Ändra dina AI-inställningar",
    text: "Under Inställningar, Mina AI-inställningar, kan du när som helst ändra hur Folke svarar och skriver.",
  },
];
