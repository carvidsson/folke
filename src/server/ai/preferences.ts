import "server-only";

import {
  DEFAULT_AI_PREFERENCES,
  type AIPreferences,
  type AnswerLength,
  type WritingOption,
  type WritingTone,
} from "@/lib/domain/preferences";

/**
 * Turns a user's structured AI preferences into personal instructions
 * (ADR-037, ADR-038). They concern length, level of detail and tone, and
 * take precedence over general style guidance in the organization's and the
 * assistant's instructions – never over the rules, the assistant's task,
 * required formats, facts, sources or permissions (PERSONAL_PRECEDENCE in
 * ./prompt.ts). Returns an empty list for defaults.
 */

const ANSWER_LENGTH: Record<AnswerLength, string> = {
  short:
    "Svara kort och direkt: högst två till tre meningar eller en kort punktlista med det viktigaste. Utelämna bakgrund som inte efterfrågas.",
  balanced:
    "Svara balanserat: kärnan först och sedan det viktigaste sammanhanget, normalt i ett till tre korta stycken eller en kort punktlista. Utelämna detaljer som inte behövs för frågan.",
  detailed:
    "Svara utförligt och förklarande, även om instruktionerna ovan ber om kortfattade svar: ge kärnan först och gå sedan igenom varje relevant villkor, belopp, undantag och steg i källorna, med förklaring av vad det betyder i praktiken. Använd gärna rubriker eller punktlistor. Lägg aldrig till information som inte stöds av källorna.",
};

const WRITING_TONE: Record<WritingTone, string> = {
  professional: "sakligt och professionellt: tydligt, vänligt och rakt på sak",
  personal:
    'personligt och naturligt: varmt och vardagligt, som till någon du känner, till exempel med hälsningen "Hej Anna!" och avslutningen "Vänliga hälsningar"',
  formal:
    'mer formellt: hövligt och korrekt, med en formell hälsning som "Bästa Anna," och avslutningen "Med vänlig hälsning", utan vardagliga uttryck. Det valet gäller före allmänna råd om att undvika formellt språk',
};

const WRITING_OPTION: Record<WritingOption, string> = {
  no_emojis: "Använd inga emojis.",
  no_long_dashes: "Undvik onödiga tankstreck (– och —). Använd punkt, komma eller kolon i stället.",
  we_form:
    'Skriv i vi-form i kundkommunikation och andra texter som skrivs för användarens räkning, till exempel "vi hjälper dig gärna" och "hos oss". Skriv inte om företaget i tredje person.',
  less_formal: "Undvik alltför formellt språk.",
  short_emails:
    "Håll mejl och meddelanden relativt korta, ungefär 60 till 100 ord: det viktigaste först, utan detaljer som mottagaren inte har frågat efter. Erbjud hellre att berätta mer.",
};

/** Free text is quoted and cannot open new prompt sections or source tags. */
function quote(text: string, max: number) {
  const clean = text
    .replace(/<\s*\/?\s*källa/gi, "(källa")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/[«»]/g, '"')
    .trim()
    .slice(0, max);
  return `«${clean}»`;
}

export function personalInstructions(prefs: AIPreferences | null): string[] {
  if (!prefs) return [];
  const lines: string[] = [];
  if (prefs.answerLength) lines.push(ANSWER_LENGTH[prefs.answerLength]);
  if (prefs.writingTone) {
    lines.push(
      `När du skriver texter för användarens räkning, till exempel e-postutkast och meddelanden, skriv ${WRITING_TONE[prefs.writingTone]}. Faktasvar, villkor och analyser förblir sakliga.`,
    );
  }
  for (const option of prefs.writingOptions) {
    if (WRITING_OPTION[option]) lines.push(WRITING_OPTION[option]);
  }
  if (prefs.extraNotes?.trim()) {
    lines.push(`Användarens egna önskemål om form och ton: ${quote(prefs.extraNotes, 1000)}`);
  }
  if (prefs.writingSample?.trim()) {
    lines.push(
      `Exempel på användarens skrivstil. Efterlikna stilen i texter för användarens räkning, men använd aldrig innehållet som fakta: ${quote(prefs.writingSample, 4000)}`,
    );
  }
  return lines;
}

/**
 * Fixed example preferences for administrators' previews and instruction
 * tests. Never a real user's settings.
 */
export type ExamplePreferences = "none" | AnswerLength;

export function examplePreferences(kind: ExamplePreferences): AIPreferences | null {
  return kind === "none" ? null : { ...DEFAULT_AI_PREFERENCES, answerLength: kind, onboardingStatus: "completed" };
}

/** Server-written length reminder for the end of the prompt (no free text). */
export function personalReminder(prefs: AIPreferences | null): string | null {
  return prefs?.answerLength ? ANSWER_LENGTH[prefs.answerLength] : null;
}
