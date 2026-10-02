/**
 * Folke's waiting texts while an answer is prepared. Each pool matches what
 * the system is actually doing at that moment (see useChat):
 *
 *   searching   – before the stream starts: the server searches Kunskapsbanken
 *   attachments – the same phase, when the message has attachments (they are read too)
 *   weighing    – the model works with two or more retrieved excerpts
 *   composing   – the model works with one or no excerpt
 *
 * Dry, warm and low-key – an experienced colleague, never unsure or sloppy.
 */

export type WaitingPhase = "searching" | "attachments" | "weighing" | "composing";

export const WAITING_TEXTS: Record<WaitingPhase, readonly string[]> = {
  searching: [
    "Folke ställer ifrån sig kaffet och börjar leta…",
    "Folke avbryter fikan och letar i arkivet…",
    "Folke rotar i arkivet…",
    "Folke letar efter rätt pärm…",
    "Folke tar ett varv i arkivet…",
    "Folke hämtar rätt underlag…",
  ],
  attachments: [
    "Folke bläddrar igenom det du bifogade…",
    "Folke läser igenom underlaget du skickade…",
    "Folke lägger ditt underlag bredvid arkivets…",
  ],
  weighing: [
    "Folke jämför sina anteckningar…",
    "Folke bläddrar bland underlagen…",
    "Folke letar efter det finstilta…",
    "Folke läser det finstilta så du slipper…",
  ],
  composing: [
    "Folke funderar på hur det bäst sägs…",
    "Folke samlar tankarna…",
    "Folke formulerar sig…",
    "Folke kollar en gång till…",
  ],
};

/** How long a text stays before a calm change to the next one. */
export const WAITING_TEXT_INTERVAL_MS = 6500;

/** A stable starting point per answer, so texts vary between answers without flicker. */
export function waitingText(phase: WaitingPhase, seed: string, step: number): string {
  const pool = WAITING_TEXTS[phase];
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[(hash + step) % pool.length];
}
