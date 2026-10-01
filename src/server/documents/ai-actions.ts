"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/server/admin/actions";
import { approvedDocumentsEnabled } from "@/server/ai/guard";
import { indexDocument } from "@/server/ai/indexing";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Approval of individual documents for OpenAI (ADR-036).
 *
 * The decision is made in the database by public.set_document_ai_approval
 * (system administrators only, through the caller's own client, audited).
 * Indexing runs afterwards on the server. Revocation always works, also
 * when OpenAI is switched off, and takes effect for the next AI call.
 */

const uuid = z.uuid();

function refresh() {
  revalidatePath("/knowledge");
  revalidatePath("/admin", "layout");
}

function dbMessage(error: { message?: string } | null, fallback: string) {
  const message = error?.message ?? "";
  return /^(Endast|Dokumentet|Syntetiska)/.test(message) ? message : fallback;
}

export async function setDocumentAIApprovalAction(documentId: string, approved: boolean): Promise<ActionResult> {
  const { user } = await getSession();
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "Ogiltigt dokument." };
  if (user.role !== "system_admin") return { ok: false, error: "Endast systemadministratörer kan godkänna dokument för OpenAI." };
  if (approved && !approvedDocumentsEnabled()) {
    return { ok: false, error: "OpenAI är inte aktiverat för godkända dokument i den här miljön." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_document_ai_approval", { p_document_id: documentId, p_approved: approved });
  if (error) {
    console.error("[documents/ai] approval failed", error.code);
    return { ok: false, error: dbMessage(error, "Godkännandet kunde inte sparas.") };
  }
  await logSecurityEvent(approved ? "ai.document_approved" : "ai.document_revoked", {
    actorId: user.id,
    targetType: "documents",
    targetId: documentId,
  });

  if (!approved) {
    refresh();
    return { ok: true, message: "Godkännandet är återkallat. Dokumentet används inte längre av OpenAI." };
  }

  const result = await indexDocument(documentId, user.id);
  refresh();
  return result.status === "ready"
    ? { ok: true, message: "Dokumentet är godkänt för OpenAI och indexerat." }
    : { ok: false, error: `Dokumentet är godkänt men indexeringen misslyckades: ${result.error}` };
}

export async function reindexDocumentAction(documentId: string): Promise<ActionResult> {
  const { user } = await getSession();
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "Ogiltigt dokument." };
  if (user.role !== "system_admin") return { ok: false, error: "Behörighet saknas." };
  if (!approvedDocumentsEnabled()) return { ok: false, error: "OpenAI är inte aktiverat i den här miljön." };

  // Proves read access and the current class through RLS.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("documents")
    .select("ai_data_class")
    .eq("id", documentId)
    .maybeSingle<{ ai_data_class: string }>();
  if (data?.ai_data_class !== "approved") return { ok: false, error: "Dokumentet är inte godkänt för OpenAI." };

  const result = await indexDocument(documentId, user.id);
  refresh();
  return result.status === "ready"
    ? { ok: true, message: "Dokumentet är indexerat." }
    : { ok: false, error: result.error ?? "Indexeringen misslyckades." };
}

/** Which assistants may use the document (reviewers of the owning group and administrators; RLS decides). */
export async function setDocumentAssistantsAction(documentId: string, assistantIds: string[]): Promise<ActionResult> {
  await getSession();
  const parsed = z.array(uuid).max(10).safeParse(assistantIds);
  if (!uuid.safeParse(documentId).success || !parsed.success) return { ok: false, error: "Ogiltiga val." };

  const supabase = await createSupabaseServerClient();
  const { data: current, error: readError } = await supabase
    .from("document_assistants")
    .select("assistant_id")
    .eq("document_id", documentId)
    .returns<{ assistant_id: string }[]>();
  if (readError) return { ok: false, error: "Dokumentet hittades inte." };

  const existing = new Set((current ?? []).map((r) => r.assistant_id));
  const wanted = new Set(parsed.data);
  const remove = [...existing].filter((id) => !wanted.has(id));
  const add = [...wanted].filter((id) => !existing.has(id));

  if (remove.length) {
    const { error, count } = await supabase
      .from("document_assistants")
      .delete({ count: "exact" })
      .eq("document_id", documentId)
      .in("assistant_id", remove);
    if (error || count !== remove.length) return { ok: false, error: "Du får inte ändra assistenterna för dokumentet." };
  }
  if (add.length) {
    const { error } = await supabase
      .from("document_assistants")
      .insert(add.map((assistant_id) => ({ document_id: documentId, assistant_id })));
    if (error) return { ok: false, error: "Du får inte ändra assistenterna för dokumentet." };
  }
  refresh();
  return { ok: true, message: "Assistenterna har sparats." };
}
