import { chatRequestSchema, type ChatStreamEvent } from "@/lib/chat/protocol";
import { getAIProvider } from "@/server/ai";
import { getSession } from "@/server/auth/session";
import { getAssistantForUser } from "@/server/data/assistants";

/**
 * POST /api/chat – streams an assistant reply as NDJSON.
 *
 * The flow is shaped for production (session -> validate -> authorise ->
 * provider), but in the prototype the session is a demo stub and the
 * provider is the mock. Nothing is persisted.
 */
export async function POST(request: Request) {
  const session = await getSession();

  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Ogiltig förfrågan" }, { status: 400 });
  }
  const { assistantId, messages } = parsed.data;

  const assistant = await getAssistantForUser(session.user.id, assistantId);
  if (!assistant) {
    return Response.json({ error: "Assistenten är inte tillgänglig" }, { status: 403 });
  }

  const provider = getAIProvider();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        for await (const event of provider.streamChat({
          assistant,
          messages: messages.map(({ role, content }) => ({ role, content })),
          context: [],
          signal: request.signal,
        })) {
          send(event);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          console.error("[api/chat] provider error", error);
          send({ type: "error", message: "Svaret kunde inte genereras." });
        }
      } finally {
        controller.close();
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
