import "server-only";

import { serverEnv } from "@/server/env";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Rate limits, concurrency limits and budget stops for external AI calls,
 * checked atomically in the database (public.ai_begin_request).
 *
 * Budgets are server-side estimates from recorded usage. A request that is
 * already running can push the total slightly over a limit (bounded by
 * FOLKE_AI_MAX_OUTPUT_TOKENS). OpenAI's project budget is a second line of
 * defence, not a guaranteed hard limit.
 */

export type LimitReason = "monthly_budget" | "user_daily_budget" | "concurrency" | "rate_limit" | "unavailable";

const MESSAGES: Record<LimitReason, string> = {
  monthly_budget: "Månadens AI-budget är förbrukad. Kontakta en administratör.",
  user_daily_budget: "Du har nått dagens AI-budget. Försök igen i morgon.",
  concurrency: "Du har redan ett svar som genereras. Vänta tills det är klart.",
  rate_limit: "Du har ställt många frågor på kort tid. Vänta en minut och försök igen.",
  unavailable: "AI-tjänsten är inte tillgänglig just nu. Försök igen om en stund.",
};

export type BeginResult = { ok: true; requestId: string } | { ok: false; reason: LimitReason; message: string };

export async function beginAIRequest(userId: string | null, kind: "chat" | "embedding"): Promise<BeginResult> {
  const env = serverEnv();
  const { data, error } = await createSupabaseAdminClient().rpc("ai_begin_request", {
    p_user_id: userId,
    p_kind: kind,
    p_max_concurrent: env.FOLKE_AI_MAX_CONCURRENT_PER_USER,
    p_max_per_minute: env.FOLKE_AI_MAX_REQUESTS_PER_MINUTE,
    p_user_daily_limit_usd: env.FOLKE_AI_USER_DAILY_LIMIT_USD,
    p_monthly_limit_usd: env.FOLKE_AI_MONTHLY_LIMIT_USD,
  });
  if (error || !data) {
    console.error("[ai/limits] could not check limits", error?.message);
    return { ok: false, reason: "unavailable", message: MESSAGES.unavailable };
  }
  const result = data as { ok: boolean; reason?: LimitReason; request_id?: string };
  if (result.ok && result.request_id) return { ok: true, requestId: result.request_id };
  const reason = result.reason ?? "unavailable";
  return { ok: false, reason, message: MESSAGES[reason] ?? MESSAGES.unavailable };
}

export async function finishAIRequest(requestId: string, status: "completed" | "failed" | "aborted") {
  const { error } = await createSupabaseAdminClient().rpc("ai_finish_request", {
    p_request_id: requestId,
    p_status: status,
  });
  if (error) console.error("[ai/limits] could not finish request", error.message);
}
