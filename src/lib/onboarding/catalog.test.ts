import { describe, expect, it } from "vitest";

import { WRITING_TONES } from "@/lib/domain/preferences";

import { ANSWER_EXAMPLES, INTRO_STEPS, composeExampleMail } from "./catalog";

describe("onboarding examples", () => {
  it("show three clearly different answer lengths", () => {
    const words = (s: string) => s.split(/\s+/).length;
    expect(words(ANSWER_EXAMPLES.short)).toBeLessThan(words(ANSWER_EXAMPLES.balanced));
    expect(words(ANSWER_EXAMPLES.balanced) * 2).toBeLessThan(words(ANSWER_EXAMPLES.detailed));
  });

  it("compose a different e-mail per tone, deterministically", () => {
    const mails = WRITING_TONES.map((t) => composeExampleMail(t).body);
    expect(new Set(mails).size).toBe(3);
    expect(composeExampleMail("formal").body).toBe(composeExampleMail("formal").body);
  });

  it("apply quick options to the preview", () => {
    expect(composeExampleMail("professional").body).toContain("Jag bekräftar");
    expect(composeExampleMail("professional", ["we_form"]).body).toContain("Vi bekräftar");
    const full = composeExampleMail("personal");
    const short = composeExampleMail("personal", ["short_emails"]);
    expect(short.words).toBeLessThan(full.words);
    expect(composeExampleMail("formal").body).toContain("Bästa Anna");
    expect(composeExampleMail("formal", ["less_formal"]).body).toContain("Hej Anna");
  });

  it("follow Folke's own writing rules (no emojis or dashes as separators)", () => {
    for (const tone of WRITING_TONES) {
      for (const options of [[], ["we_form"], ["short_emails"], ["less_formal"]] as const) {
        const { body } = composeExampleMail(tone, options);
        expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(body).not.toMatch(/\s[–—]\s/);
      }
    }
    expect(INTRO_STEPS).toHaveLength(5);
  });
});
