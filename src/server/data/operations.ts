import "server-only";

import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

// Admin-only data. RLS returns rows only to system administrators.

export interface UsageRow {
  userId: string | null;
  assistantId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costSek: number;
  createdAt: string;
}

/** AI usage for the last `days` days (aggregated in the page). */
export async function listUsageForDays(days: number): Promise<UsageRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase
      .from("ai_usage")
      .select("user_id, assistant_id, provider, model, input_tokens, output_tokens, cost_sek, created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(10_000)
      .returns<
        {
          user_id: string | null;
          assistant_id: string | null;
          provider: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cost_sek: number | string;
          created_at: string;
        }[]
      >(),
  );
  return rows.map((r) => ({
    userId: r.user_id,
    assistantId: r.assistant_id,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costSek: Number(r.cost_sek),
    createdAt: r.created_at,
  }));
}

export interface AuditEntry {
  id: number;
  occurredAt: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export async function listAuditLog({
  limit = 200,
  action,
}: { limit?: number; action?: string } = {}): Promise<AuditEntry[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("audit_log")
    .select("id, occurred_at, actor_id, action, target_type, target_id, metadata")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (action) query = query.like("action", `${action}%`);
  const rows = unwrap(
    await query.returns<
      {
        id: number;
        occurred_at: string;
        actor_id: string | null;
        action: string;
        target_type: string | null;
        target_id: string | null;
        metadata: Record<string, unknown>;
      }[]
    >(),
  );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    metadata: r.metadata ?? {},
  }));
}

export interface RetentionBucket {
  inactiveSince: string;
  conversations: number;
  messages: number;
}

export async function getRetentionSummary(): Promise<RetentionBucket[]> {
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(await supabase.rpc("conversation_retention_summary")) as {
    inactive_since: string;
    conversations: number;
    messages: number;
  }[];
  return rows.map((r) => ({
    inactiveSince: r.inactive_since,
    conversations: Number(r.conversations),
    messages: Number(r.messages),
  }));
}
