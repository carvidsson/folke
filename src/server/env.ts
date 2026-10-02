import "server-only";

import { z } from "zod";

/**
 * Server-side environment. Validated lazily on first use so a missing
 * variable produces a clear error instead of an obscure failure deep inside
 * a request.
 */

/** Optional string: empty values count as "not set". */
const optional = () =>
  z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));

const number = (fallback: number) => z.coerce.number().positive().default(fallback);

/** Only OpenAI's global and EU endpoints are accepted (see docs/SECURITY.md). */
const OPENAI_BASE_URLS = ["https://api.openai.com/v1", "https://eu.api.openai.com/v1"];

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Public base URL used in invitation and password-reset links. */
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),

  /**
   * "mock" (default): no external AI calls at all.
   * "openai": OpenAI answers according to FOLKE_AI_EXTERNAL_DATA.
   */
  FOLKE_AI_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  /**
   * "synthetic-only" (default): only synthetic test conversations use OpenAI.
   * "approved-documents": ordinary conversations use OpenAI too, with
   * documents a system administrator approved one by one (ADR-036).
   */
  FOLKE_AI_EXTERNAL_DATA: z.enum(["synthetic-only", "approved-documents"]).default("synthetic-only"),

  OPENAI_API_KEY: optional(),
  OPENAI_PROJECT: optional(),
  OPENAI_ORGANIZATION: optional(),
  OPENAI_BASE_URL: optional().refine((v) => !v || OPENAI_BASE_URLS.includes(v.replace(/\/$/, "")), {
    message: `OPENAI_BASE_URL måste vara ${OPENAI_BASE_URLS.join(" eller ")}`,
  }),

  /** Comma-separated subset of the model catalog (src/server/ai/models.ts). */
  FOLKE_CHAT_MODELS: optional(),
  FOLKE_CHAT_MODEL_DEFAULT: optional(),
  FOLKE_EMBEDDING_MODEL: optional(),

  /** Limits and budget stops (USD, server-side; not a hard guarantee). */
  FOLKE_AI_USER_DAILY_LIMIT_USD: number(0.5),
  FOLKE_AI_MONTHLY_LIMIT_USD: number(10),
  FOLKE_AI_MAX_CONCURRENT_PER_USER: number(2),
  FOLKE_AI_MAX_REQUESTS_PER_MINUTE: number(10),
  /** Includes the model's reasoning tokens (OpenAI counts them in the limit). */
  FOLKE_AI_MAX_OUTPUT_TOKENS: number(2000),
  FOLKE_AI_TIMEOUT_MS: number(45_000),
  /** Conversion for the SEK column in usage reports (an estimate). */
  FOLKE_USD_TO_SEK: number(10.5),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Names only – never values, which may be secrets.
    const invalid = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Folke är inte konfigurerad: kontrollera miljövariablerna (${invalid}). Se .env.example och docs/SETUP.md.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Tests change process.env between cases. */
export function resetServerEnvForTests() {
  cached = null;
}
