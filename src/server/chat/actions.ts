"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/server/admin/actions";
import { getSession } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * The caller's own conversations: rename and delete. RLS only allows the
 * owner; nobody else – including administrators – can read, change or
 * delete them. Deleting removes the messages by cascade. Usage records keep
 * their numbers but lose the link to the conversation (on delete set null).
 */

const uuid = z.uuid();
const titleSchema = z.string().trim().min(1).max(120);

export async function renameConversationAction(conversationId: string, title: string): Promise<ActionResult> {
  const { user } = await getSession();
  const parsed = titleSchema.safeParse(title);
  if (!uuid.safeParse(conversationId).success) return { ok: false, error: "Ogiltig konversation." };
  if (!parsed.success) return { ok: false, error: "Namnet måste vara mellan 1 och 120 tecken." };

  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("conversations")
    .update({ title: parsed.data }, { count: "exact" })
    .eq("id", conversationId)
    .eq("user_id", user.id);
  if (error || !count) return { ok: false, error: "Konversationen kunde inte byta namn." };

  revalidatePath("/", "layout");
  return { ok: true, message: "Konversationen har bytt namn." };
}

export async function deleteConversationAction(conversationId: string): Promise<ActionResult> {
  return deleteConversationsAction([conversationId]);
}

export async function deleteConversationsAction(conversationIds: string[]): Promise<ActionResult> {
  const { user } = await getSession();
  const parsed = z.array(uuid).min(1).max(200).safeParse(conversationIds);
  if (!parsed.success) return { ok: false, error: "Ogiltigt urval." };
  const ids = [...new Set(parsed.data)];

  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("conversations")
    .delete({ count: "exact" })
    .in("id", ids)
    .eq("user_id", user.id);
  if (error || !count) return { ok: false, error: ids.length > 1 ? "Konversationerna kunde inte tas bort." : "Konversationen kunde inte tas bort." };

  revalidatePath("/", "layout");
  return {
    ok: true,
    message: count === 1 ? "Konversationen har tagits bort." : `${count} konversationer har tagits bort.`,
  };
}
