import "server-only";

import type { AIPreferences, AnswerLength, OnboardingStatus, WritingOption, WritingTone } from "@/lib/domain/preferences";
import type { ID } from "@/lib/domain/types";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

/**
 * Shared organization instructions, instruction history and personal AI
 * preferences (ADR-037). Reads for administration go through the user's
 * client (RLS: system administrators and assistant managers). Chat uses the
 * secret-key client for instructions, like assistant instructions, because
 * end users may not read them.
 */

export interface OrganizationInstructions {
  content: string;
  updatedAt: string;
  updatedByName: string | null;
}

export interface InstructionRevision {
  id: number;
  content: string;
  createdAt: string;
  createdByName: string | null;
}

/** For administration (RLS decides; null if the viewer may not read them). */
export async function getOrganizationInstructions(): Promise<OrganizationInstructions | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("organization_instructions")
    .select("content, updated_at, editor:profiles!organization_instructions_updated_by_fkey(full_name, email)")
    .maybeSingle<{ content: string; updated_at: string; editor: { full_name: string; email: string } | null }>();
  if (!data) return null;
  return {
    content: data.content,
    updatedAt: data.updated_at,
    updatedByName: data.editor ? data.editor.full_name || data.editor.email : null,
  };
}

/**
 * Organization instructions for a chat request. Call ONLY after the
 * request's user was authorized for the assistant.
 */
export async function getOrganizationInstructionsForChat(): Promise<string> {
  const { data } = await createSupabaseAdminClient()
    .from("organization_instructions")
    .select("content")
    .maybeSingle<{ content: string }>();
  return data?.content ?? "";
}

export async function listInstructionRevisions(
  scope: "organization" | "assistant",
  assistantId?: ID,
  limit = 10,
): Promise<InstructionRevision[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("instruction_revisions")
    .select("id, content, created_at, author:profiles!instruction_revisions_created_by_fkey(full_name, email)")
    .eq("scope", scope)
    .order("id", { ascending: false })
    .limit(limit);
  if (assistantId) query = query.eq("assistant_id", assistantId);
  const rows = unwrap(
    await query.returns<
      { id: number; content: string; created_at: string; author: { full_name: string; email: string } | null }[]
    >(),
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created_at,
    createdByName: r.author ? r.author.full_name || r.author.email : null,
  }));
}

interface PreferenceRow {
  answer_length: AnswerLength | null;
  writing_tone: WritingTone | null;
  writing_options: WritingOption[];
  extra_notes: string | null;
  writing_sample: string | null;
  onboarding_status: OnboardingStatus;
}

/** The caller's own AI preferences (RLS: owner only); null = defaults. */
export async function getMyAIPreferences(userId: ID): Promise<AIPreferences | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("user_ai_preferences")
    .select("answer_length, writing_tone, writing_options, extra_notes, writing_sample, onboarding_status")
    .eq("user_id", userId)
    .maybeSingle<PreferenceRow>();
  if (!data) return null;
  return {
    answerLength: data.answer_length,
    writingTone: data.writing_tone,
    writingOptions: data.writing_options,
    extraNotes: data.extra_notes,
    writingSample: data.writing_sample,
    onboardingStatus: data.onboarding_status,
  };
}

export interface InstructionDraft {
  content: string;
  updatedAt: string;
  updatedByName: string | null;
}

/** The draft for a target, if any (RLS: those who may edit it). */
export async function getInstructionDraft(
  scope: "organization" | "assistant",
  assistantId?: ID,
): Promise<InstructionDraft | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("instruction_drafts")
    .select("content, updated_at, editor:profiles!instruction_drafts_updated_by_fkey(full_name, email)")
    .eq("target", assistantId ?? "organization")
    .eq("scope", scope)
    .maybeSingle<{ content: string; updated_at: string; editor: { full_name: string; email: string } | null }>();
  if (!data) return null;
  return {
    content: data.content,
    updatedAt: data.updated_at,
    updatedByName: data.editor ? data.editor.full_name || data.editor.email : null,
  };
}
