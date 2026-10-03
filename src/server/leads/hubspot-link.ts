import "server-only";

/**
 * Links from Folke to a conversation in HubSpot (ADR-048).
 *
 * HubSpot does not document the inbox URL of a thread, so Folke does not
 * guess it. An administrator pastes the address of one real conversation
 * opened in HubSpot; Folke verifies that it is on the account's UI domain,
 * contains the account id, and that exactly one path segment is a thread id
 * HubSpot knows. That segment becomes {threadId} in the stored pattern.
 */

export type TemplateResult = { ok: true; template: string; threadId: string } | { ok: false; error: string };

export async function deriveThreadTemplate(
  raw: string,
  account: { portalId: string; uiDomain: string | null },
  isThread: (id: string) => Promise<boolean>,
): Promise<TemplateResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Klistra in hela adressen till en konversation i HubSpot." };
  }
  const expectedHost = account.uiDomain ?? "app.hubspot.com";
  if (url.protocol !== "https:" || url.hostname !== expectedHost) {
    return { ok: false, error: `Adressen ska börja med https://${expectedHost}/.` };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (!segments.includes(account.portalId)) {
    return { ok: false, error: "Adressen hör inte till Börjessons HubSpot-konto." };
  }
  const candidates = [...new Set(segments.filter((s) => /^\d{6,20}$/.test(s) && s !== account.portalId))];
  const threads: string[] = [];
  for (const c of candidates) if (await isThread(c)) threads.push(c);
  if (threads.length !== 1) {
    return { ok: false, error: "Hittade ingen konversation i adressen. Öppna en konversation i HubSpots inkorg och kopiera adressen därifrån." };
  }
  const threadId = threads[0];
  const path = segments.map((s) => (s === threadId ? "{threadId}" : s)).join("/");
  const template = `https://${url.hostname}/${path}`;
  if (template.length > 300) return { ok: false, error: "Adressen är för lång." };
  return { ok: true, template, threadId };
}
