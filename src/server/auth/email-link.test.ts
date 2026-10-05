import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invitation and password-reset links (2026-10-05): opening a link never uses it up – e-mail scanners
 * open links within seconds – and the token is verified only when the person continues.
 */

const verifyOtp = vi.fn();
const createClient = vi.fn(async () => ({ auth: { verifyOtp } }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => createClient() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { GET } = await import("@/app/auth/confirm/route");
const { confirmEmailLinkAction } = await import("./actions");

const HASH = "a".repeat(56);
const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

beforeEach(() => {
  verifyOtp.mockReset();
  createClient.mockClear();
});

describe("opening the e-mail link", () => {
  it("never verifies the token – it only leads to the page with the button", async () => {
    const res = await GET(new NextRequest(`https://folke.example/auth/confirm?token_hash=${HASH}&type=invite`));
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login/confirm");
    expect(to.searchParams.get("token_hash")).toBe(HASH);
    expect(to.searchParams.get("type")).toBe("invite");
    expect(createClient).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses links without a valid token or with another type", async () => {
    for (const q of ["", `token_hash=${HASH}`, `token_hash=${HASH}&type=signup`, "token_hash=x&type=invite", `token_hash=${HASH}%20OR%201&type=invite`]) {
      const res = await GET(new NextRequest(`https://folke.example/auth/confirm?${q}`));
      expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login?error=link");
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("continuing (the POST)", () => {
  it("verifies the link and leads to choosing a password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    await expect(confirmEmailLinkAction(form({ token_hash: HASH, type: "invite" }))).rejects.toThrow("REDIRECT /login/set-password");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "invite", token_hash: HASH });
  });

  it("a used or expired link is refused", async () => {
    verifyOtp.mockResolvedValue({ error: { code: "otp_expired" } });
    await expect(confirmEmailLinkAction(form({ token_hash: HASH, type: "recovery" }))).rejects.toThrow("REDIRECT /login?error=link");
  });

  it("malformed input never reaches Supabase", async () => {
    await expect(confirmEmailLinkAction(form({ token_hash: "x", type: "invite" }))).rejects.toThrow("REDIRECT /login?error=link");
    await expect(confirmEmailLinkAction(form({ token_hash: HASH, type: "magiclink" }))).rejects.toThrow("REDIRECT /login?error=link");
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
