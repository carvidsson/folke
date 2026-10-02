import { z } from "zod";

import { ATTACHMENT_BUCKET } from "@/server/attachments/cleanup";
import { getApiSession } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * GET /api/attachments/[id] – the owner's own attachment file (thumbnail,
 * preview or ?download=1). Ownership is proven with the user's client (RLS:
 * owner only, no administrator access) before the file is read from the
 * private bucket. Served from the app's own origin, so no signed Storage
 * links are handed out and the CSP stays unchanged.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/attachments/[id]">) {
  const session = await getApiSession();
  if (!session) return new Response("Inte inloggad", { status: 401 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new Response("Hittades inte", { status: 404 });

  const supabase = await createSupabaseServerClient();
  const { data: row } = await supabase
    .from("conversation_attachments")
    .select("storage_path, mime_type, file_name, status")
    .eq("id", id)
    .maybeSingle<{ storage_path: string | null; mime_type: string; file_name: string; status: string }>();
  if (!row?.storage_path || row.status !== "ready") return new Response("Hittades inte", { status: 404 });

  const { data: file, error } = await createSupabaseAdminClient().storage.from(ATTACHMENT_BUCKET).download(row.storage_path);
  if (error || !file) return new Response("Hittades inte", { status: 404 });

  const download = new URL(request.url).searchParams.get("download") === "1";
  const name = encodeURIComponent(row.file_name);
  return new Response(file, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      "Cache-Control": "private, no-store",
    },
  });
}
