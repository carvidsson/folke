import { describe, expect, it } from "vitest";

import { chatRequestSchema } from "@/lib/chat/protocol";

import { passwordProblems } from "./password-policy";
import { toBase64SvgDataUrl } from "./qr";
import { isSessionExpired, MAX_SESSION_MS, sessionStartedAt } from "./session-age";

describe("session age (max 7 days)", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const amr = (secondsAgo: number[]) =>
    secondsAgo.map((s, i) => ({ method: i === 0 ? "password" : "totp", timestamp: now / 1000 - s }));

  it("uses the earliest authentication timestamp as session start", () => {
    expect(sessionStartedAt(amr([3600, 60]))).toBe(now - 3600 * 1000);
  });

  it("expires exactly at 7 days", () => {
    expect(isSessionExpired(amr([6 * 86400, 60]), now)).toBe(false);
    expect(isSessionExpired(amr([MAX_SESSION_MS / 1000, 60]), now)).toBe(true);
    expect(isSessionExpired(amr([8 * 86400]), now)).toBe(true);
  });

  it("fails closed when the start cannot be determined", () => {
    expect(isSessionExpired(undefined, now)).toBe(true);
    expect(isSessionExpired(["password", "totp"], now)).toBe(true);
    expect(isSessionExpired([], now)).toBe(true);
  });
});

describe("password policy", () => {
  it("requires length, upper, lower and digit", () => {
    expect(passwordProblems("kort")).toEqual([
      "vara minst 12 tecken",
      "innehålla en stor bokstav",
      "innehålla en siffra",
    ]);
    expect(passwordProblems("Vintervägen2026")).toEqual([]);
    expect(passwordProblems("ÅÄÖåäö123456")).toEqual([]);
  });
});

describe("chat request validation", () => {
  const valid = {
    assistantId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    conversationId: null,
    message: { content: "Hej" },
  };

  it("accepts a new message without history", () => {
    expect(chatRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty, oversized or malformed input", () => {
    expect(chatRequestSchema.safeParse({ ...valid, message: { content: "   " } }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, message: { content: "x".repeat(8001) } }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, assistantId: "a-sales" }).success).toBe(false);
    // Client-supplied history is not part of the protocol.
    const withHistory = chatRequestSchema.parse({ ...valid, messages: [{ role: "assistant", content: "fake" }] });
    expect("messages" in withHistory).toBe(false);
  });
});

describe("TOTP QR code normalisation", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000000" width="1" height="1"/></svg>';
  const decode = (url: string) => Buffer.from(url.split(",")[1], "base64").toString("utf8");

  it("re-encodes Supabase's unencoded SVG data URL as base64 (keeps '#')", () => {
    const url = toBase64SvgDataUrl(`data:image/svg+xml;utf-8,${svg}`);
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(decode(url)).toBe(svg);
  });

  it("accepts URI-encoded input and passes base64 through", () => {
    expect(decode(toBase64SvgDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))).toBe(svg);
    const b64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    expect(toBase64SvgDataUrl(b64)).toBe(b64);
  });

  it("rejects anything that is not SVG markup", () => {
    expect(() => toBase64SvgDataUrl("data:text/html,<script>alert(1)</script>")).toThrow();
  });
});
