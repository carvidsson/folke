import "server-only";

import { headers } from "next/headers";

import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Security events that are not captured by database triggers (sign-in,
 * MFA, denied requests, downloads, invitations …).
 *
 * Never put conversation or document content in `metadata`.
 */
export type SecurityEvent =
  | "auth.sign_in"
  | "auth.sign_in_failed"
  | "auth.mfa_verified"
  | "auth.mfa_failed"
  | "auth.mfa_enrolled"
  | "auth.mfa_reset"
  | "auth.password_set"
  | "auth.password_reset_requested"
  | "auth.sign_out"
  | "auth.session_expired"
  | "auth.activated"
  | "access.denied"
  | "admin.user_invited"
  | "admin.user_reinvited"
  | "document.uploaded"
  | "document.downloaded"
  | "document.processed"
  | "chat.provider_error"
  | "ai.model_changed"
  | "ai.test_access_changed"
  | "ai.synthetic_corpus_loaded"
  | "ai.synthetic_corpus_removed"
  | "ai.embeddings_indexed"
  | "ai.document_approved"
  | "ai.document_revoked"
  | "ai.instructions_changed"
  | "leads.report_generated"
  | "leads.ai_analysis_run"
  | "leads.region_analysis_started"
  | "leads.synced"
  | "leads.config_changed"
  | "leads.access_changed";

export async function logSecurityEvent(
  action: SecurityEvent,
  {
    actorId = null,
    targetType = null,
    targetId = null,
    metadata = {},
  }: {
    actorId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("audit_log").insert({
      action,
      actor_id: actorId,
      target_type: targetType,
      target_id: targetId,
      metadata: { ...metadata, ip, userAgent: h.get("user-agent")?.slice(0, 200) ?? null },
    });
    if (error) console.error("[audit] insert failed", error.message);
  } catch (error) {
    // Logging must never break the user flow.
    console.error("[audit] failed", error);
  }
}
