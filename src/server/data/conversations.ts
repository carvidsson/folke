import "server-only";

import type {
  Attachment,
  Conversation,
  ConversationDataClass,
  ConversationSummary,
  ID,
  Message,
  MessageRole,
  SourceReference,
} from "@/lib/domain/types";
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
  sources: SourceReference[];
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
  const referenced = [...new Set(row.messages.flatMap((m) => (m.sources ?? []).map((s) => s.documentId)))];
  const readable = new Set(
    referenced.length
      ? unwrap(await supabase.from("documents").select("id").in("id", referenced).returns<{ id: string }[]>()).map(
          (d) => d.id,
        )
      : [],
  );

  const messages: Message[] = row.messages.map((m) => {
    const sources = (m.sources ?? []).filter((s) => readable.has(s.documentId));
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
