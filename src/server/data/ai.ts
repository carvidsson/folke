import "server-only";

import { externalProviderConfigured } from "@/server/ai/guard";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Whether the current user may start synthetic test conversations with
 * the external AI provider (AI test access + OpenAI configured).
 */
export async function getMySyntheticModeAvailability(userId: string): Promise<boolean> {
  if (!externalProviderConfigured()) return false;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select("ai_test_access")
    .eq("id", userId)
    .maybeSingle<{ ai_test_access: boolean }>();
  return data?.ai_test_access === true;
}
