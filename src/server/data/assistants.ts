import "server-only";

import type {
  Assistant,
  AssistantGrant,
  AssistantIconKey,
  AssistantStatus,
  AssistantTone,
  ID,
  KnowledgeCollection,
} from "@/lib/domain/types";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

// Never select `instructions` here: the column is not granted to end users.
const ASSISTANT_COLUMNS =
  "id, slug, name, tagline, description, icon, tone, status, suggested_prompts, sort_order, ai_model, assistant_managers(user_id), assistant_collections(collection_id)";

interface AssistantRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  icon: AssistantIconKey;
  tone: AssistantTone;
  status: AssistantStatus;
  suggested_prompts: string[];
  sort_order: number;
  ai_model: string | null;
  assistant_managers: { user_id: string }[];
  assistant_collections: { collection_id: string }[];
}

function toAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    icon: row.icon,
    tone: row.tone,
    status: row.status,
    suggestedPrompts: row.suggested_prompts,
    aiModel: row.ai_model,
    managerIds: row.assistant_managers.map((m) => m.user_id),
    collectionIds: row.assistant_collections.map((c) => c.collection_id),
  };
}

/** Assistants visible to the caller (admins/managers see all they administer). */
export async function listAssistants(): Promise<Assistant[]> {
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase.from("assistants").select(ASSISTANT_COLUMNS).order("sort_order").returns<AssistantRow[]>(),
  );
  return rows.map(toAssistant);
}

/** Assistants the current user may actually use (granted directly or via group). */
export async function listMyAssistants(): Promise<Assistant[]> {
  const supabase = await createSupabaseServerClient();
  const ids = unwrap(await supabase.rpc("my_assistant_ids")) as string[];
  if (!ids.length) return [];
  const rows = unwrap(
    await supabase
      .from("assistants")
      .select(ASSISTANT_COLUMNS)
      .in("id", ids)
      .order("sort_order")
      .returns<AssistantRow[]>(),
  );
  return rows.map(toAssistant);
}

/** The assistant, only if the current user may use it. */
export async function getMyAssistant(assistantId: ID): Promise<Assistant | null> {
  const assistants = await listMyAssistants();
  return assistants.find((a) => a.id === assistantId) ?? null;
}

/**
 * System instructions for a chat request. Uses the secret-key client because
 * end users may not read instructions; call ONLY after getMyAssistant()
 * confirmed the user may use the assistant.
 */
export async function getInstructionsForAuthorizedChat(assistantId: ID): Promise<string> {
  const admin = createSupabaseAdminClient();
  const row = unwrap(
    await admin.from("assistants").select("instructions").eq("id", assistantId).single<{ instructions: string }>(),
  );
  return row.instructions;
}

/** Instructions for the admin/manager configuration view (checked in the database). */
export async function getInstructionsForAdmin(assistantId: ID): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_assistant_instructions", { p_assistant_id: assistantId });
  return error ? null : (data as string);
}

interface GrantRow {
  id: string;
  assistant_id: string;
  user_id: string | null;
  group_id: string | null;
}

export async function listAssistantGrants(): Promise<AssistantGrant[]> {
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase.from("assistant_grants").select("id, assistant_id, user_id, group_id").returns<GrantRow[]>(),
  );
  return rows.map((g) => ({
    id: g.id,
    assistantId: g.assistant_id,
    subject: g.user_id ? { type: "user", userId: g.user_id } : { type: "group", groupId: g.group_id! },
  }));
}

export async function listCollections(): Promise<KnowledgeCollection[]> {
  const supabase = await createSupabaseServerClient();
  return unwrap(
    await supabase.from("collections").select("id, name, description").order("name").returns<KnowledgeCollection[]>(),
  );
}
