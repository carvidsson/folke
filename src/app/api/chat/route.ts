import { chatRequestSchema, type ChatStreamEvent } from "@/lib/chat/protocol";
import { isDocumentSource } from "@/lib/domain/types";
import { getAIProvider } from "@/server/ai";
import { verifyCitations } from "@/server/ai/citations";
import { embedQuery } from "@/server/ai/embeddings";
import { userMessageFor } from "@/server/ai/errors";
import {
  assertExternalAllowed,
  attachmentsEnabled,
  attachmentsExternalAllowed,
  chooseProviderId,
  historyAllowedClasses,
  retrievalDataClass,
  type ConversationDataClass,
} from "@/server/ai/guard";
import { beginAIRequest, finishAIRequest } from "@/server/ai/limits";
import { resolveChatModel } from "@/server/ai/models";
import { personalInstructions, personalReminder } from "@/server/ai/preferences";
import { buildSystemPrompt, limitHistory, titleFromMessage } from "@/server/ai/prompt";
import type { UsageReport } from "@/server/ai/types";
import { recordChatUsage } from "@/server/ai/usage";
import {
  attachmentPrompt,
  buildAttachmentContext,
  checkAttachments,
  EMPTY_ATTACHMENT_CONTEXT,
  messageAttachments,
  type AttachmentMeta,
} from "@/server/attachments/context";
import { logSecurityEvent } from "@/server/audit";
import { getApiSession } from "@/server/auth/session";
import { retrieveContext } from "@/server/chat/retrieval";
import { citedSources, filterHistory, type HistoryRow } from "@/server/chat/turn";
import { getInstructionsForAuthorizedChat, getMyAssistant } from "@/server/data/assistants";
import { getMyAIPreferences, getOrganizationInstructionsForChat } from "@/server/data/instructions";
import { handleLeadChat } from "@/server/lead-chat/handler";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { handleTableChat, TABLE_ASSISTANT_SLUG } from "@/server/tables/chat";
import { loadTableDataset } from "@/server/tables/dataset";

/**
 * POST /api/chat – stores the user's message, retrieves permitted document
 * excerpts, streams the assistant's answer (NDJSON) and stores it with its
 * verified sources. Every read and write of conversations and documents goes
 * through the user's own Supabase client, so RLS applies.
 *
 * External AI (OpenAI) is used only when the data guard allows it
 * (src/server/ai/guard.ts): ordinary conversations with documents a system
 * administrator approved for OpenAI (policy "approved-documents"), and
 * synthetic test conversations with synthetic documents. Everything else
 * uses the mock provider, which makes no external calls. No user names,
 * e-mail addresses or ids are sent to the provider.
 */

const HISTORY_ROWS = 30;

/** Document assistants never have lead conversations (insert policy, ADR-050). */
type DocumentConversationClass = Exclude<ConversationDataClass, "lead">;

export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const session = await getApiSession();
  if (!session) return jsonError("Inte inloggad", 401);

  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Ogiltig förfrågan", 400);
  const { assistantId, conversationId, message, mode } = parsed.data;
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

  // Leadanalys (ADR-050): its own material and rules, the same protocol and storage.
  if (assistant.kind === "lead_analysis") return handleLeadChat({ request, session, assistant, parsed: parsed.data, supabase });

  // AI test access and the assistant's model are read from the database for
  // every request – never taken from the client.
  const [{ data: profile }, { data: assistantRow }] = await Promise.all([
    supabase.from("profiles").select("ai_test_access").eq("id", userId).single<{ ai_test_access: boolean }>(),
    supabase.from("assistants").select("ai_model").eq("id", assistant.id).single<{ ai_model: string | null }>(),
  ]);
  const userHasTestAccess = profile?.ai_test_access === true;

  // --- Attachments (ADR-045): the user's own, ready uploads only ------------
  const attachmentIds = [...new Set(message.attachmentIds ?? [])];
  let attachmentRows: AttachmentMeta[] = [];
  if (attachmentIds.length) {
    if (!attachmentsEnabled()) return jsonError("Bilagor är inte aktiverade", 400);
    const checked = await checkAttachments(supabase, attachmentIds, conversationId);
    if (!checked.ok) return jsonError(checked.error, 400);
    attachmentRows = checked.rows;
  }

  // --- Conversation (existing and owned, or new) ---------------------------
  let conversation: { id: string; title: string; data_class: DocumentConversationClass };
  let created = false;
  if (conversationId) {
    const { data } = await supabase
      .from("conversations")
      .select("id, title, assistant_id, data_class")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle<{ id: string; title: string; assistant_id: string; data_class: ConversationDataClass }>();
    if (!data || data.assistant_id !== assistant.id || data.data_class === "lead") return jsonError("Konversationen hittades inte", 404);
    conversation = { ...data, data_class: data.data_class };
  } else {
    const dataClass: DocumentConversationClass = mode === "synthetic" ? "synthetic" : "internal";
    if (dataClass === "synthetic" && !userHasTestAccess) {
      await logSecurityEvent("access.denied", {
        actorId: userId,
        targetType: "assistant",
        targetId: assistant.id,
        metadata: { route: "/api/chat", reason: "synthetic_mode_without_test_access" },
      });
      return jsonError("Du har inte behörighet till syntetiskt testläge", 403);
    }
    const { data, error } = await supabase
      .from("conversations")
      .insert({ assistant_id: assistant.id, title: titleFromMessage(message.content), data_class: dataClass })
      .select("id, title, data_class")
      .single<{ id: string; title: string; data_class: DocumentConversationClass }>();
    if (error || !data) return jsonError("Konversationen kunde inte skapas", 500);
    conversation = data;
    created = true;
  }

  // Bind new uploads to the conversation (RLS: own uploads, own conversation).
  const unbound = attachmentRows.filter((a) => !a.conversation_id).map((a) => a.id);
  if (unbound.length) {
    const { error } = await supabase.from("conversation_attachments").update({ conversation_id: conversation.id }).in("id", unbound);
    if (error) {
      console.error("[api/chat] could not bind attachments", error.message);
      return jsonError("Bilagorna kunde inte kopplas till konversationen", 500);
    }
  }

  // Structured Excel analysis (ADR-055): Analysassistenten with recognised exports in the conversation.
  // Questions that are not about them fall through to the ordinary chat below, unchanged.
  if (assistant.slug === TABLE_ASSISTANT_SLUG && attachmentsEnabled()) {
    const dataset = await loadTableDataset(supabase, conversation.id);
    if (dataset) {
      const response = await handleTableChat({
        request,
        userId,
        assistant,
        conversation,
        created,
        userHasTestAccess,
        assistantModel: assistantRow?.ai_model ?? null,
        message: message.content,
        storedAttachments: messageAttachments(attachmentRows),
        dataset,
        supabase,
      });
      if (response) return response;
    }
  }

  // --- Provider decision (data guard) and limits ---------------------------
  const providerId = chooseProviderId({ conversationClass: conversation.data_class, userHasTestAccess });
  const provider = getAIProvider(providerId);
  const model = provider.external ? resolveChatModel(assistantRow?.ai_model) : null;

  let requestId: string | null = null;
  if (provider.external) {
    const limit = await beginAIRequest(userId, "chat");
    if (!limit.ok) return jsonError(limit.message, 429);
    requestId = limit.requestId;
  }

  const { data: storedMessage, error: insertError } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      role: "user",
      content: message.content,
      attachments: messageAttachments(attachmentRows),
    })
    .select("id")
    .single<{ id: string }>();
  if (insertError || !storedMessage) {
    if (requestId) await finishAIRequest(requestId, "failed");
    return jsonError("Meddelandet kunde inte sparas", 500);
  }

  // --- History and retrieval (both under the user's RLS) -------------------
  // History first: a follow-up question is searched together with the
  // previous one, and the chunks the previous answer cited are re-read.
  const { data: historyRows } = await supabase
    .from("messages")
    .select("role, content, sources, attachments")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_ROWS)
    .returns<HistoryRow[]>();
  const rows = (historyRows ?? []).reverse();

  // One query embedding per text, shared by knowledge-base and attachment search.
  const embeddings = new Map<string, ReturnType<typeof embedQuery>>();
  const embed = (text: string) => {
    if (!embeddings.has(text)) {
      embeddings.set(
        text,
        embedQuery(text, { userId, assistantId: assistant.id, conversationId: conversation.id, dataClass: conversation.data_class }, request.signal),
      );
    }
    return embeddings.get(text)!;
  };

  const { context, sources, stats } = await retrieveContext(supabase, {
    assistantId: assistant.id,
    message: message.content,
    history: rows,
    dataClass: retrievalDataClass(conversation.data_class, provider.external),
    embed: provider.external ? embed : null,
  });

  // The conversation's attachments (ADR-045). Nothing happens without any.
  const attachmentContext = attachmentsEnabled()
    ? await buildAttachmentContext(supabase, {
        conversationId: conversation.id,
        message: message.content,
        currentIds: attachmentIds,
        history: rows,
        embed: provider.external && attachmentsExternalAllowed() ? embed : null,
      })
    : EMPTY_ATTACHMENT_CONTEXT;
  const attachmentFiles = [
    ...attachmentContext.images.map((f) => ({ name: f.name, kind: "image" as const, dataUrl: f.dataUrl })),
    ...attachmentContext.pdfs.map((f) => ({ name: f.name, kind: "pdf" as const, dataUrl: f.dataUrl })),
  ];
  // Counts and chunk ids only – never document, attachment or conversation content.
  console.info(
    "[chat/retrieval]",
    JSON.stringify({ conversation: conversation.id, provider: provider.id, ...stats, attachments: attachmentContext.stats }),
  );

  const referenced = [...new Set(rows.flatMap((m) => (m.sources ?? []).filter(isDocumentSource).map((s) => s.documentId)))];
  // Earlier answers are only sent again while their documents are still
  // readable – and, for external calls, still approved (revocation).
  const { data: readable } = referenced.length
    ? await supabase.from("documents").select("id, ai_data_class").in("id", referenced)
    : { data: [] };
  const allowedClasses = historyAllowedClasses(conversation.data_class, provider.external);
  const usable = ((readable ?? []) as { id: string; ai_data_class: string }[]).filter(
    (d) => !allowedClasses || (allowedClasses as string[]).includes(d.ai_data_class),
  );
  const history = limitHistory(filterHistory(rows, new Set(usable.map((d) => d.id))));

  // Instruction layers: organization → assistant → the user's own preferences.
  const [organizationInstructions, assistantInstructions, preferences] = await Promise.all([
    getOrganizationInstructionsForChat(),
    getInstructionsForAuthorizedChat(assistant.id),
    getMyAIPreferences(userId),
  ]);
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

      send({
        type: "conversation",
        conversationId: conversation.id,
        title: conversation.title,
        created,
        dataClass: conversation.data_class === "synthetic" ? "synthetic" : "standard",
        provider: providerId,
        model: model?.id ?? null,
      });
      if (sources.length) send({ type: "sources", sources });

      let answer = "";
      let usage: UsageReport | null = null;
      let failed = false;

      try {
        // Last line of defence before anything leaves Folke.
        assertExternalAllowed({
          external: provider.external,
          conversationClass: conversation.data_class,
          userHasTestAccess,
          context,
          attachments: attachmentContext.excerpts.length + attachmentFiles.length,
        });
        for await (const event of provider.streamChat({
          system: buildSystemPrompt(
            {
              organization: organizationInstructions,
              assistant: assistantInstructions,
              personal: personalInstructions(preferences),
              personalReminder: personalReminder(preferences),
            },
            context,
            {
              broad: stats.scope === "broad",
              attachments: attachmentPrompt(attachmentContext),
            },
          ),
          messages: history,
          files: attachmentFiles,
          context,
          model: model?.id,
          signal: request.signal,
          onUsage: (u) => (usage = u),
        })) {
          answer += event.delta;
          send(event);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          failed = true;
          console.error("[api/chat] provider error", error instanceof Error ? `${error.name}: ${(error as { code?: string }).code ?? ""} ${(error as { detail?: string }).detail ?? ""}` : "unknown");
          await logSecurityEvent("chat.provider_error", {
            actorId: userId,
            targetType: "assistant",
            targetId: assistant.id,
            metadata: { provider: provider.id, code: (error as { code?: string }).code ?? null },
          });
          send({ type: "error", message: userMessageFor(error) });
        }
      }

      if (failed) {
        // Roll back the question so a retry does not duplicate it in the
        // history; partial output from a failed call is not stored.
        await supabase.from("messages").delete().eq("id", storedMessage.id);
      } else if (answer.trim()) {
        // Also partial answers after "Stoppa". Only verified citations and
        // the excerpts they point to are stored.
        const verified = verifyCitations(answer, context.length);
        const finalSources = citedSources(sources, verified.cited);
        const { error } = await supabase.from("messages").insert({
          conversation_id: conversation.id,
          role: "assistant",
          content: verified.content,
          sources: finalSources,
        });
        if (error) console.error("[api/chat] could not store answer", error.message);
        send({ type: "done", content: verified.content, sources: finalSources });
      } else {
        send({ type: "done", content: "", sources: [] });
      }

      const finalUsage = usage as UsageReport | null;
      if (finalUsage) {
        await recordChatUsage({
          userId,
          assistantId: assistant.id,
          conversationId: conversation.id,
          provider: provider.id,
          dataClass: conversation.data_class,
          usage: finalUsage,
        });
      }
      if (requestId) {
        await finishAIRequest(requestId, failed ? "failed" : request.signal.aborted ? "aborted" : "completed");
      }

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
