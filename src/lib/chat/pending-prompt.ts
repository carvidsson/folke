/**
 * Hands a prompt from the start page's quick-start box to the chat view
 * without putting user text in the URL (where it would end up in browser
 * history and server logs).
 *
 * TODO(backend): replace with a server action that creates the conversation
 * and redirects to /chat/[id].
 */

const KEY = "folke:pending-prompt";

export function setPendingPrompt(prompt: string) {
  try {
    sessionStorage.setItem(KEY, prompt);
  } catch {
    // Storage unavailable (private mode etc.) – the chat simply starts empty.
  }
}

export function takePendingPrompt(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
