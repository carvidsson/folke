import "server-only";

import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

// Admin-only data. RLS returns rows only to system administrators.

export interface UsageRow {
  kind: "chat" | "embedding";
  userId: string | null;
  assistantId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSek: number;
  estimated: boolean;
  dataClass: "internal" | "synthetic" | null;
  createdAt: string;
}

/** Estimated external AI spend (USD) this month and today (Stockholm time). */
export async function getAISpend(): Promise<{ monthUsd: number; todayUsd: number }> {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
  const monthStart = `${today.slice(0, 7)}-01T00:00:00+01:00`;
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase
      .from("ai_usage")
      .select("cost_usd, created_at")
      .gte("created_at", monthStart)
      .limit(50_000)
      .returns<{ cost_usd: number | string; created_at: string }[]>(),
  );
  const dayStart = new Date(`${today}T00:00:00+01:00`).getTime();
  return rows.reduce(
    (t, r) => ({
      monthUsd: t.monthUsd + Number(r.cost_usd),
      todayUsd: t.todayUsd + (new Date(r.created_at).getTime() >= dayStart ? Number(r.cost_usd) : 0),
    }),
    { monthUsd: 0, todayUsd: 0 },
  );
}

/** AI usage for the last `days` days (aggregated in the page). */
export async function listUsageForDays(days: number): Promise<UsageRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase
      .from("ai_usage")
      .select(
        "kind, user_id, assistant_id, provider, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, cost_sek, estimated, data_class, created_at",
      )
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(10_000)
      .returns<
        {
          kind: "chat" | "embedding";
          user_id: string | null;
          assistant_id: string | null;
          provider: string;
          model: string;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          cost_usd: number | string;
          cost_sek: number | string;
          estimated: boolean;
          data_class: "internal" | "synthetic" | null;
          created_at: string;
        }[]
      >(),
  );
  return rows.map((r) => ({
    kind: r.kind,
    userId: r.user_id,
    assistantId: r.assistant_id,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    outputTokens: r.output_tokens,
    costUsd: Number(r.cost_usd),
    costSek: Number(r.cost_sek),
    estimated: r.estimated,
    dataClass: r.data_class,
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
