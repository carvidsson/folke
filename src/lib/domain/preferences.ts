/**
 * Personal AI preferences (ADR-037).
 *
 * Structured choices, picked from fixed examples in the onboarding
 * (src/lib/onboarding/catalog.ts) and editable later under
 * Min profil → Mina AI-inställningar. The server turns them into personal
 * instructions (src/server/ai/preferences.ts); they complement the
 * organization's and the assistant's instructions and never replace them.
 *
 * Values must match the check constraints in user_ai_preferences.
 */

export const ANSWER_LENGTHS = ["short", "balanced", "detailed"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

export const WRITING_TONES = ["professional", "personal", "formal"] as const;
export type WritingTone = (typeof WRITING_TONES)[number];

export const WRITING_OPTIONS = ["no_emojis", "no_long_dashes", "we_form", "less_formal", "short_emails"] as const;
export type WritingOption = (typeof WRITING_OPTIONS)[number];

export type OnboardingStatus = "not_started" | "completed" | "skipped";

export interface AIPreferences {
  /** null = default (balanced). */
  answerLength: AnswerLength | null;
  /** null = default (professional). Applies to texts written on the user's behalf. */
  writingTone: WritingTone | null;
  writingOptions: WritingOption[];
  extraNotes: string | null;
  /** Optional own text whose style Folke may imitate (style only, not content). */
  writingSample: string | null;
  onboardingStatus: OnboardingStatus;
}

export const DEFAULT_AI_PREFERENCES: AIPreferences = {
  answerLength: null,
  writingTone: null,
  writingOptions: [],
  extraNotes: null,
  writingSample: null,
  onboardingStatus: "not_started",
};

export const MAX_EXTRA_NOTES = 1000;
export const MAX_WRITING_SAMPLE = 4000;

export const ANSWER_LENGTH_LABELS: Record<AnswerLength, string> = {
  short: "Kort och direkt",
  balanced: "Balanserat",
  detailed: "Utförligt och förklarande",
};

export const WRITING_TONE_LABELS: Record<WritingTone, string> = {
  professional: "Sakligt och professionellt",
  personal: "Personligt och naturligt",
  formal: "Mer formellt",
};

export const WRITING_OPTION_LABELS: Record<WritingOption, string> = {
  no_emojis: "Undvik emojis",
  no_long_dashes: "Undvik långa tankstreck",
  we_form: "Skriv gärna i vi-form",
  less_formal: "Undvik överdrivet formellt språk",
  short_emails: "Håll e-postutkast kortfattade",
};
