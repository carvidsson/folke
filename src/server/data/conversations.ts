import "server-only";

import type {
  Attachment,
  Conversation,
  ConversationDataClass,
  ConversationSummary,
  ID,
  Message,
  MessageRole,
  MessageSource,
} from "@/lib/domain/types";
import { isDocumentSource } from "@/lib/domain/types";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

// Conversations are private: RLS returns only the caller's own rows, so no
// owner filter is needed – but one is added anyway as defence in depth.

interface ConversationRow {
  id: string;
  user_id: string;
  assistant_id: string;
  title: string;
  data_class: ConversationDataClass;
  created_at: string;
  last_message_at: string;
}

interface MessageRow {
  id: string;
  role: MessageRole;
  content: string;
  sources: MessageSource[];
  attachments: Omit<Attachment, "id">[];
  created_at: string;
}

const CONVERSATION_COLUMNS = "id, user_id, assistant_id, title, data_class, created_at, last_message_at";

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    ownerId: row.user_id,
    title: row.title,
    dataClass: row.data_class,
    createdAt: row.created_at,
    updatedAt: row.last_message_at,
    preview: "",
  };
}

export async function listConversations(
  ownerId: ID,
  { limit }: { limit?: number } = {},
): Promise<ConversationSummary[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", ownerId)
    .order("last_message_at", { ascending: false });
  if (limit) query = query.limit(limit);
  const rows = unwrap(await query.returns<ConversationRow[]>());
  return rows.map(toSummary);
}

export async function getConversation(ownerId: ID, id: ID): Promise<Conversation | null> {
  const supabase = await createSupabaseServerClient();
  const row = unwrap(
    await supabase
      .from("conversations")
      .select(`${CONVERSATION_COLUMNS}, messages(id, role, content, sources, attachments, created_at)`)
      .eq("id", id)
      .eq("user_id", ownerId)
      .order("created_at", { referencedTable: "messages", ascending: true })
      .maybeSingle<ConversationRow & { messages: MessageRow[] }>(),
  );
  if (!row) return null;

  // Stored sources are only shown while the user can still read the
  // document, so old answers do not become a way around revoked access.
  const all = row.messages.flatMap((m) => m.sources ?? []);
  const referenced = [...new Set(all.filter(isDocumentSource).map((s) => s.documentId))];
  const readable = new Set(
    referenced.length
      ? unwrap(await supabase.from("documents").select("id").in("id", referenced).returns<{ id: string }[]>()).map(
          (d) => d.id,
        )
      : [],
  );
  const leads = await readableLeads(
    supabase,
    all.flatMap((s) => (s.kind === "lead" ? [s.id] : s.kind === "lead_set" ? s.threadIds : [])),
  );

  const messages: Message[] = row.messages.map((m) => {
    const sources = (m.sources ?? []).flatMap((s) => visibleSource(s, readable, leads));
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      sources: sources.length ? sources : undefined,
      attachments: m.attachments?.length ? m.attachments.map((a, i) => ({ ...a, id: `${m.id}-a${i}` })) : undefined,
    };
  });
  return { ...toSummary(row), messages };
}

/**
 * Leadanalys sources (ADR-050) follow the user's current lead access (RLS on lead_threads): a lead
 * the user can no longer see disappears from old answers, and the HubSpot link is rebuilt from the
 * current verified template.
 */
async function readableLeads(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, ids: string[]) {
  const unique = [...new Set(ids)].filter((id) => /^\d{1,20}$/.test(id));
  if (!unique.length) return { ids: new Set<string>(), template: null as string | null };
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += 100) {
    const rows = unwrap(
      await supabase
        .from("lead_threads")
        .select("hubspot_thread_id")
        .in("hubspot_thread_id", unique.slice(i, i + 100))
        .returns<{ hubspot_thread_id: string }[]>(),
    );
    for (const r of rows) found.add(r.hubspot_thread_id);
  }
  const settings = unwrap(
    await supabase
      .from("lead_settings")
      .select("hubspot_thread_url_template")
      .limit(1)
      .returns<{ hubspot_thread_url_template: string | null }[]>(),
  );
  return { ids: found, template: settings[0]?.hubspot_thread_url_template ?? null };
}

function visibleSource(
  s: MessageSource,
  documents: Set<string>,
  leads: { ids: Set<string>; template: string | null },
): MessageSource[] {
  if (isDocumentSource(s)) return documents.has(s.documentId) ? [s] : [];
  if (s.kind === "lead") return leads.ids.has(s.id) ? [{ ...s, hubspotUrl: leads.template ? leads.template.replace("{threadId}", s.id) : null }] : [];
  if (s.kind === "lead_set") {
    const threadIds = s.threadIds.filter((id) => leads.ids.has(id));
    return threadIds.length ? [{ ...s, threadIds, count: threadIds.length }] : [];
  }
  return [s];
}
