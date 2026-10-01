import "server-only";

/**
 * Provider-neutral AI errors with user-facing Swedish messages.
 *
 * Messages never contain keys, request details or vendor error text: the
 * original error is logged on the server only (without content).
 */

export type AIErrorCode =
  | "timeout"
  | "rate_limited"
  | "quota"
  | "auth"
  | "model_unavailable"
  | "network"
  | "bad_request"
  | "incomplete"
  | "unknown";

const MESSAGES: Record<AIErrorCode, string> = {
  timeout: "AI-tjänsten svarade inte i tid. Försök igen om en stund.",
  rate_limited: "AI-tjänsten är tillfälligt överbelastad. Vänta en stund och försök igen.",
  quota: "AI-tjänstens kvot är slut. Kontakta en administratör.",
  auth: "AI-tjänsten är felkonfigurerad. Kontakta en administratör.",
  model_unavailable: "Den valda AI-modellen är inte tillgänglig. Kontakta en administratör.",
  network: "Det gick inte att nå AI-tjänsten. Kontrollera anslutningen och försök igen.",
  bad_request: "AI-tjänsten kunde inte behandla frågan.",
  incomplete: "Svaret avbröts innan det var klart.",
  unknown: "Svaret kunde inte genereras.",
};

export class AIProviderError extends Error {
  constructor(
    readonly code: AIErrorCode,
    /** Technical detail for server logs (never shown to users). */
    readonly detail?: string,
  ) {
    super(MESSAGES[code]);
    this.name = "AIProviderError";
  }

  get userMessage() {
    return MESSAGES[this.code];
  }
}

export function userMessageFor(error: unknown): string {
  return error instanceof AIProviderError ? error.userMessage : MESSAGES.unknown;
}
