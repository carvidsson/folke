import { chatRequestSchema, type ChatStreamEvent } from "@/lib/chat/protocol";
import type { SourceReference } from "@/lib/domain/types";
import { getAIProvider } from "@/server/ai";
import { estimateCostSek } from "@/server/ai/pricing";
import { buildSystemPrompt, titleFromMessage } from "@/server/ai/prompt";
import type { ContextChunk, ProviderMessage } from "@/server/ai/types";
import { logSecurityEvent } from "@/server/audit";
import { getApiSession } from "@/server/auth/session";
import { getInstructionsForAuthorizedChat, getMyAssistant } from "@/server/data/assistants";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * POST /api/chat – stores the user's message, retrieves permitted document
 * excerpts, streams the assistant's answer (NDJSON) and stores it with its
 * sources. Every read and write of conversations goes through the user's own
 * Supabase client, so RLS guarantees privacy.
 */

const HISTORY_LIMIT = 20;
const CONTEXT_LIMIT = 6;

export const maxDuration = 60;

/** Query-focused excerpt for source cards (falls back to the chunk start). */
function excerptFor(snippet: string | null, content: string) {
  const text = (snippet?.trim() || content).replace(/\s+/g, " ");
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const session = await getApiSession();
  if (!session) return jsonError("Inte inloggad", 401);

  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Ogiltig förfrågan", 400);
  const { assistantId, conversationId, message } = parsed.data;
  const userId = session.user.id;

  const assistant = await getMyAssistant(assistantId);
  if (!assistant) {
    await logSecurityEvent("access.denied", {
      actorId: userId,
      targetType: "assistant",
      targetId: assistantId,
      metadata: { route: "/api/chat" },
    });
    return jsonError("Assistenten är inte tillgänglig", 403);
  }

  const supabase = await createSupabaseServerClient();

  // --- Conversation (existing and owned, or new) ---------------------------
  let conversation: { id: string; title: string };
  let created = false;
  if (conversationId) {
    const { data } = await supabase
      .from("conversations")
      .select("id, title, assistant_id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle<{ id: string; title: string; assistant_id: string }>();
    if (!data || data.assistant_id !== assistant.id) return jsonError("Konversationen hittades inte", 404);
    conversation = data;
  } else {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ assistant_id: assistant.id, title: titleFromMessage(message.content) })
      .select("id, title")
      .single<{ id: string; title: string }>();
    if (error || !data) return jsonError("Konversationen kunde inte skapas", 500);
    conversation = data;
    created = true;
  }

  const { error: insertError } = await supabase.from("messages").insert({
    conversation_id: conversation.id,
    role: "user",
    content: message.content,
    attachments: message.attachments ?? [],
  });
  if (insertError) return jsonError("Meddelandet kunde inte sparas", 500);

  // --- History and retrieval (both under the user's RLS) -------------------
  const [{ data: historyRows }, { data: chunkRows }] = await Promise.all([
    supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT)
      .returns<ProviderMessage[]>(),
    supabase.rpc("search_document_chunks", {
      p_assistant_id: assistant.id,
      p_query: message.content,
      p_limit: CONTEXT_LIMIT,
    }),
  ]);

  const history = (historyRows ?? []).reverse();
  const chunks = (chunkRows ?? []) as {
    chunk_id: number;
    document_id: string;
    title: string;
    content: string;
    location: string | null;
    snippet: string | null;
  }[];
  const context: ContextChunk[] = chunks.map((c, i) => ({
    index: i + 1,
    documentId: c.document_id,
    title: c.title,
    content: c.content,
    location: c.location,
    snippet: c.snippet?.trim() || null,
  }));
  const sources: SourceReference[] = chunks.map((c) => ({
    id: String(c.chunk_id),
    documentId: c.document_id,
    title: c.title,
    excerpt: excerptFor(c.snippet, c.content),
    location: c.location,
  }));

  const instructions = await getInstructionsForAuthorizedChat(assistant.id);
  const provider = getAIProvider();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client went away; keep going so the answer is still stored.
        }
      };

      send({ type: "conversation", conversationId: conversation.id, title: conversation.title, created });
      if (sources.length) send({ type: "sources", sources });

      let answer = "";
      let usage: { model: string; inputTokens: number; outputTokens: number } | null = null;
      let failed = false;

      try {
        for await (const event of provider.streamChat({
          system: buildSystemPrompt(instructions, context),
          messages: history,
          context,
          signal: request.signal,
        })) {
          if (event.type === "text") {
            answer += event.delta;
            send(event);
          } else if (event.type === "usage") {
            usage = event;
          }
        }
      } catch (error) {
        if (!request.signal.aborted) {
          failed = true;
          console.error("[api/chat] provider error", error);
          await logSecurityEvent("chat.provider_error", {
            actorId: userId,
            targetType: "assistant",
            targetId: assistant.id,
            metadata: { provider: provider.id },
          });
          send({ type: "error", message: "Svaret kunde inte genereras." });
        }
      }

      // Store whatever was produced (also partial answers after "Stoppa").
      if (answer.trim()) {
        const { error } = await supabase.from("messages").insert({
          conversation_id: conversation.id,
          role: "assistant",
          content: answer,
          sources: failed ? [] : sources,
        });
        if (error) console.error("[api/chat] could not store answer", error.message);
      }

      if (usage) {
        const { error } = await createSupabaseAdminClient()
          .from("ai_usage")
          .insert({
            user_id: userId,
            assistant_id: assistant.id,
            conversation_id: conversation.id,
            provider: provider.id,
            model: usage.model,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cost_sek: estimateCostSek(provider.id, usage.model, usage.inputTokens, usage.outputTokens),
          });
        if (error) console.error("[api/chat] could not record usage", error.message);
      }

      if (!failed) send({ type: "done" });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
