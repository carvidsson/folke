import { describe, expect, it } from "vitest";

import { WAITING_TEXT_INTERVAL_MS, WAITING_TEXTS, waitingText, type WaitingPhase } from "./waiting-texts";

describe("Folke's waiting texts", () => {
  const all = Object.values(WAITING_TEXTS).flat();

  it("are short Folke sentences without technical or unsure wording", () => {
    for (const text of all) {
      expect(text).toMatch(/^Folke .+…$/);
      expect(text.length).toBeLessThanOrEqual(50);
      expect(text).not.toMatch(/kunskapsbank|söker|AI|modell|osäker|kanske|gissa|slarv|oops|hoppsan/i);
    }
  });

  it("start on a stable text per answer and change calmly", () => {
    const phase: WaitingPhase = "searching";
    expect(waitingText(phase, "svar-1", 0)).toBe(waitingText(phase, "svar-1", 0));
    expect(waitingText(phase, "svar-1", 1)).not.toBe(waitingText(phase, "svar-1", 0));
    expect(WAITING_TEXT_INTERVAL_MS).toBeGreaterThanOrEqual(4000);
  });

  it("every phase has its own small pool", () => {
    for (const phase of ["searching", "attachments", "weighing", "composing"] as const) {
      expect(WAITING_TEXTS[phase].length).toBeGreaterThanOrEqual(3);
    }
  });
});
