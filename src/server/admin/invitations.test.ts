import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-invitations (2026-10-05): a new invitation always gets a new link, also when the earlier link was
 * used up (by an e-mail scanner), without removing anything by hand – and an account in use is never
 * replaced. Synthetic data only.
 */

const auth = {
  inviteUserByEmail: vi.fn(),
  generateLink: vi.fn(),
  deleteUser: vi.fn(),
  listUsers: vi.fn(),
  mfa: { listFactors: vi.fn() },
};
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ auth: { admin: auth } }) }));
vi.mock("@/server/env", () => ({ serverEnv: () => ({ NEXT_PUBLIC_SITE_URL: "https://folke.example" }) }));

const { authUserIdByEmail, recreateInvitation, sendInvitation, unusedInvitation } = await import("./invitations");

const EMAIL = "ny.anvandare@folke.example";

beforeEach(() => {
  for (const f of [auth.inviteUserByEmail, auth.generateLink, auth.deleteUser, auth.listUsers, auth.mfa.listFactors]) f.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("which accounts may be invited again", () => {
  it("only invited accounts that never used Folke", () => {
    expect(unusedInvitation({ status: "invited", mfa_enrolled_at: null, last_active_at: null })).toBe(true);
    expect(unusedInvitation({ status: "active", mfa_enrolled_at: "2026-10-01", last_active_at: "2026-10-02" })).toBe(false);
    expect(unusedInvitation({ status: "disabled", mfa_enrolled_at: null, last_active_at: null })).toBe(false);
    // Enabled again after an MFA reset: has used Folke.
    expect(unusedInvitation({ status: "invited", mfa_enrolled_at: null, last_active_at: "2026-10-02" })).toBe(false);
    expect(unusedInvitation({ status: "invited", mfa_enrolled_at: "2026-10-01", last_active_at: null })).toBe(false);
    expect(unusedInvitation(null)).toBe(false);
  });
});

describe("sending an invitation", () => {
  it("links to /auth/confirm and reports Supabase's refusals precisely", async () => {
    auth.inviteUserByEmail.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    expect(await sendInvitation(EMAIL, "Ny Användare")).toEqual({ ok: true, userId: "u1" });
    expect(auth.inviteUserByEmail).toHaveBeenCalledWith(EMAIL, { data: { full_name: "Ny Användare" }, redirectTo: "https://folke.example/auth/confirm" });
    auth.inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { code: "email_exists", status: 422 } });
    expect(await sendInvitation(EMAIL, null)).toEqual({ ok: false, code: "email_exists" });
    auth.inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { code: "over_email_send_rate_limit", status: 429 } });
    expect(await sendInvitation(EMAIL, null)).toEqual({ ok: false, code: "rate_limited" });
  });

  it("finds an Auth account by e-mail regardless of case", async () => {
    auth.listUsers.mockResolvedValueOnce({ data: { users: [{ id: "x", email: "annan@folke.example" }, { id: "u2", email: "Ny.Anvandare@Folke.example" }] }, error: null });
    expect(await authUserIdByEmail(EMAIL)).toBe("u2");
  });
});

describe("re-inviting an account whose link was used", () => {
  it("never removes an account that has a verified second factor", async () => {
    auth.mfa.listFactors.mockResolvedValue({ data: { factors: [{ id: "f", status: "verified" }] }, error: null });
    expect(await recreateInvitation("u1", EMAIL, null)).toEqual({ ok: false, code: "email_exists" });
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("removes the unused account and invites anew: a new account, a new link", async () => {
    auth.mfa.listFactors.mockResolvedValue({ data: { factors: [{ id: "f", status: "unverified" }] }, error: null });
    auth.deleteUser.mockResolvedValue({ error: null });
    auth.inviteUserByEmail.mockResolvedValue({ data: { user: { id: "u-new" } }, error: null });
    expect(await recreateInvitation("u1", EMAIL, "Ny Användare")).toEqual({ ok: true, userId: "u-new" });
    expect(auth.deleteUser).toHaveBeenCalledWith("u1");
    expect(auth.deleteUser.mock.invocationCallOrder[0]).toBeLessThan(auth.inviteUserByEmail.mock.invocationCallOrder[0]);
  });

  it("keeps the account (without an e-mail) when the e-mail cannot be sent, so nothing is lost", async () => {
    auth.mfa.listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    auth.deleteUser.mockResolvedValue({ error: null });
    auth.inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { code: "over_email_send_rate_limit", status: 429 } });
    auth.generateLink.mockResolvedValue({ data: { user: { id: "u-kept" } }, error: null });
    expect(await recreateInvitation("u1", EMAIL, null)).toEqual({ ok: false, code: "rate_limited", pendingUserId: "u-kept" });
    expect(auth.generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: "invite", email: EMAIL }));
  });
});
