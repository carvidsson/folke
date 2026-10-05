import { z } from "zod";

/** The parameters of an invitation or password-reset link (`/auth/confirm?token_hash=…&type=…`). */
export const emailLinkSchema = z.object({
  // Supabase's token hash: hexadecimal, sometimes with a short prefix ("pkce_").
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  type: z.enum(["invite", "recovery"]),
});
export type EmailLink = z.infer<typeof emailLinkSchema>;
