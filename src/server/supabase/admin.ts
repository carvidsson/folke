import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/server/env";

/**
 * Supabase client with the SECRET key. Bypasses RLS.
 *
 * Only for operations end users must not be able to perform themselves, and
 * only AFTER the caller's permission has been checked with the user client:
 *   - sending invitations (Auth admin API)
 *   - reading/writing files in the private storage bucket
 *   - writing document chunks and processing results
 *   - writing AI usage (cost) records and security events
 *
 * Never use it to read conversations or messages.
 */
export function createSupabaseAdminClient() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
