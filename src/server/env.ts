import "server-only";

import { z } from "zod";

/**
 * Server-side environment. Validated lazily on first use so a missing
 * variable produces a clear error instead of an obscure failure deep inside
 * a request.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Public base URL used in invitation and password-reset links. */
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
  FOLKE_AI_PROVIDER: z.string().default("mock"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Folke är inte konfigurerad: kontrollera miljövariablerna (${missing}). Se .env.example och docs/SETUP.md.`,
    );
  }
  cached = parsed.data;
  return cached;
}
