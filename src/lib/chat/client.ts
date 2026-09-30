import type { ChatRequest, ChatStreamEvent } from "./protocol";

/**
 * Sends a chat request and invokes `onEvent` for every streamed event.
 * Resolves when the stream ends; rejects on network/HTTP errors or abort.
 */
export async function streamChat(
  request: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Förfrågan misslyckades (${response.status})`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as ChatStreamEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as ChatStreamEvent);
}
