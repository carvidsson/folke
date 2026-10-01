import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

import { sessionCookieOptions } from "@/lib/supabase/cookie-options";
import { serverEnv } from "@/server/env";

/**
 * Supabase client acting AS THE SIGNED-IN USER. All queries are subject to
 * RLS. This is the default client for pages, route handlers and actions.
 *
 * Cached per request so the session is only resolved once.
 */
export const createSupabaseServerClient = cache(async () => {
  // Read cookies first: this marks the route as dynamic before anything else.
  const cookieStore = await cookies();
  const env = serverEnv();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
});
