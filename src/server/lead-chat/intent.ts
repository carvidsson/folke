import "server-only";

import type { LeadIntent } from "@/lib/leads/chat";
import { addDays } from "@/lib/leads/periods";
import type { PeriodPreset } from "@/lib/leads/types";

/**
 * What a question asks for (ADR-050) – deterministic and deliberately small: a handful of keyword
 * groups decide which brief modules are loaded. A question without any keyword inherits the previous
 * turn's intents (a follow-up), or gets the overview. No AI is involved, so the same question always
 * loads the same material. Everything here is pure.
 */

const BOUNDARY = String.raw`(?:(?<!\p{L})(?=\p{L})|(?<=\p{L})(?!\p{L}))`;

/** A RegExp in which \b is a Unicode-aware word boundary (å, ä and ö count as letters). */
export function rx(source: string): RegExp {
  return new RegExp(source.split(String.raw`\b`).join(BOUNDARY), "u");
}

const INTENT_PATTERNS: [LeadIntent, RegExp][] = [
  ["response_time", rx(String.raw`svarstid|svarar|snabb|långsam|reaktionstid|tid till (första )?svar|dröj|väntetid|hur fort|hur lång tid`)],
  ["source", rx(String.raw`källa|källor|blocket|hemsida|webben|webbplats|sajt|wayke|bytbil|bilweb|tradera|kanal|var .* kommer ifrån`)],
  ["virtual", rx(String.raw`virtuell`)],
  ["comparison", rx(String.raw`förra (månaden|perioden|veckan)|föregående|jämför|blivit (bättre|sämre)|(bättre|sämre) än|förändr|ökat|minskat|utvecklats|\btrend|än tidigare`)],
  ["patterns", rx(String.raw`styrk|svaghet|utvecklingsområde|utveckla|förbättr|problem|brist|fungerar|bra på|bli bättre|göra bättre|mönster|coach|tappar|missar|möjlighet`)],
  ["examples", rx(String.raw`exempel|\bvisa (några|ett par|fem|tre|två|fyra|\d+)\b|konkret`)],
  ["meeting", rx(String.raw`säljmöte|\bmöte|\bta(r|git)? upp\b|agenda|genomgång|med säljarna|med teamet|lyfta med`)],
  ["explain", rx(String.raw`varför|vad beror|förklar|orsak|hur kommer det sig`)],
];

/** Questions about things the lead analysis does not contain. Answered without AI. */
const OUT_OF_SCOPE: [string, RegExp][] = [
  ["sales", rx(String.raw`\baffär|\bsålt\b|\bsålde\b|försäljning|konverter|intäkt|omsättning|ordervärde|hur många bilar`)],
  ["forecast", rx(String.raw`prognos|kommer att (gå|bli)|nästa (månad|kvartal) kommer`)],
  ["ranking", rx(String.raw`rangordna|\branka|rankning|topplista|bästa säljare|sämsta säljare|vem är (bäst|sämst)|betyg på`)],
  ["customer", rx(String.raw`vad (skrev|sa|svarade) kunden|kundens (namn|nummer|telefon|e-?post|mejl)|vem var kunden|personuppgift`)],
];

const WIDEN = rx(String.raw`\bresten\b|\bövriga\b|\bresterande\b|alla andra|andra säljare|hela (regionen|inkorgen|teamet|gruppen)`);
const ALL = rx(String.raw`alla (regioner|inkorgar|leads)|\btotalt\b|hela (företaget|bolaget|börjessons)`);
const SAME_KIND = rx(String.raw`\bsamma\b|\bliknande\b|det här problemet|den typen`);
const GOOD = rx(String.raw`\bbra\b|fungera|lyckade|styrk|\bgoda\b|positiva`);
const IMPROVE = rx(String.raw`förbättr|utveckla|mindre bra|missa|tapp|problem|kunde (ha )?gjort|sämre|brist`);

const NUMBER_WORDS: [string, number][] = [
  ["ett par", 2],
  ["några", 3],
  ["ett", 1],
  ["en", 1],
  ["två", 2],
  ["tre", 3],
  ["fyra", 4],
  ["fem", 5],
  ["sex", 6],
  ["sju", 7],
  ["åtta", 8],
  ["nio", 9],
  ["tio", 10],
];

export interface ExampleRequest {
  polarity: "good" | "improve" | "both";
  count: number;
}

export interface PeriodRequest {
  preset: PeriodPreset;
  from?: string;
  to?: string;
}

export interface ParsedQuestion {
  /** Intents the question itself names (empty: a follow-up or an open question). */
  intents: LeadIntent[];
  examples: ExampleRequest | null;
  period: PeriodRequest | null;
  /** "resten", "övriga": widen the previous selection one step. */
  widen: boolean;
  /** "alla regioner", "totalt": everything the user may see. */
  all: boolean;
  /** "samma problem": keep the previous answer's focus types. */
  sameKind: boolean;
  outOfScope: string | null;
}

export function normalizeQuestion(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseQuestion(text: string, today: string): ParsedQuestion {
  const q = normalizeQuestion(text);
  const intents = INTENT_PATTERNS.filter(([, re]) => re.test(q)).map(([intent]) => intent);
  return {
    intents,
    examples: intents.includes("examples") ? exampleRequest(q) : null,
    period: periodFromText(q, today),
    widen: WIDEN.test(q) && !ALL.test(q),
    all: ALL.test(q),
    sameKind: SAME_KIND.test(q),
    outOfScope: OUT_OF_SCOPE.find(([, re]) => re.test(q))?.[0] ?? null,
  };
}

export function exampleRequest(q: string): ExampleRequest {
  const good = GOOD.test(q);
  const improve = IMPROVE.test(q);
  const digits = /(?<!\d)(\d{1,2})(?!\d)/.exec(q);
  const word = NUMBER_WORDS.find(([w]) => rx(String.raw`\b${w} (exempel|dialoger|leads|st)\b|\bvisa ${w}\b`).test(q));
  const count = Math.min(10, Math.max(1, digits ? Number(digits[1]) : word ? word[1] : 3));
  return { polarity: good && !improve ? "good" : improve && !good ? "improve" : "both", count };
}

const MONTH_NAMES = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** A period named in the question, or null (the selection's period is kept). */
export function periodFromText(q: string, today: string): PeriodRequest | null {
  if (rx(String.raw`senaste (veckan|7 dagarna|sju dagarna)|\bi veckan\b|den här veckan`).test(q)) return { preset: "7d" };
  if (rx(String.raw`senaste (månaden|30 dagarna|trettio dagarna)`).test(q)) return { preset: "30d" };
  if (rx(String.raw`(den här|denna|innevarande) månad|hittills i månaden|\bi månaden\b`).test(q)) return { preset: "this_month" };
  // "jämfört med förra månaden" is a comparison, not a new period.
  if (rx(String.raw`förra månaden|föregående månad`).test(q) && !rx(String.raw`jämför|\b(än|mot|med) (förra|föregående)`).test(q)) {
    return { preset: "last_month" };
  }
  const month = MONTH_NAMES.findIndex((m) => rx(String.raw`\b(i|under|för) ${m}\b`).test(q));
  if (month >= 0) {
    const year = Number(today.slice(0, 4)) - (month + 1 > Number(today.slice(5, 7)) ? 1 : 0);
    const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const next = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`;
    return { preset: "custom", from, to: [addDays(next, -1), today].sort()[0] };
  }
  return null;
}
