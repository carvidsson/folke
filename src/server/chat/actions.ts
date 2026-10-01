"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/server/admin/actions";
import { getSession } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Permanently deletes one of the caller's own conversations (and its
 * messages, by cascade). RLS only allows the owner; nobody else – including
 * administrators – can delete or read it. Usage records keep their numbers
 * but lose the link to the conversation (on delete set null).
 */
export async function deleteConversationAction(conversationId: string): Promise<ActionResult> {
  const { user } = await getSession();
  if (!z.uuid().safeParse(conversationId).success) return { ok: false, error: "Ogiltig konversation." };

  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("conversations")
    .delete({ count: "exact" })
    .eq("id", conversationId)
    .eq("user_id", user.id);
  if (error || !count) return { ok: false, error: "Konversationen kunde inte tas bort." };

  revalidatePath("/", "layout");
  return { ok: true, message: "Konversationen har tagits bort." };
}
