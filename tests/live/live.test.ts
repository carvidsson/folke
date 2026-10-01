/**
 * LIVE security tests against the real Supabase project (PostgREST, Auth,
 * Storage, RLS). Run with: npm run test:live
 *
 * Uses only synthetic users/groups/documents created and removed here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  assistantId,
  cleanup,
  createDocument,
  createGroup,
  createUser,
  jwtClaims,
  RUN,
  service,
  type LiveUser,
} from "./helpers";

let admin: LiveUser, managerA: LiveUser, memberA: LiveUser, memberB: LiveUser, noMfa: LiveUser;
let groupA: string, groupB: string;
let sales: string, warranty: string, analysis: string;
const docs: Record<string, { id: string; path: string }> = {};
let conversationA: string;

beforeAll(async () => {
  [sales, warranty, analysis] = await Promise.all([assistantId("salj"), assistantId("garanti"), assistantId("analys")]);
  [groupA, groupB] = await Promise.all([createGroup("A"), createGroup("B")]);

  admin = await createUser("admin", { role: "system_admin" });
  managerA = await createUser("managerA");
  memberA = await createUser("memberA");
  memberB = await createUser("memberB");
  noMfa = await createUser("nomfa", { mfa: false });

  const svc = service();
  const must = (r: { error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
  };
  must(
    await svc.from("group_members").insert([
      { group_id: groupA, user_id: managerA.id, is_manager: true },
      { group_id: groupA, user_id: memberA.id, is_manager: false },
      { group_id: groupA, user_id: noMfa.id, is_manager: false },
      { group_id: groupB, user_id: memberB.id, is_manager: false },
    ]),
    "memberships",
  );
  must(
    await svc.from("assistant_grants").insert([
      { assistant_id: sales, group_id: groupA },
      { assistant_id: warranty, group_id: groupB },
    ]),
    "grants",
  );

  const base = { ownerGroupId: groupA, uploadedBy: managerA.id, assistantIds: [sales] };
  docs.approved = await createDocument({
    ...base,
    title: "Aurora",
    chunks: [
      `${"Bakgrund och planering för året med mål och uppföljning. ".repeat(10)}Projekt Aurora har kodordet Blå Ekorre och leds av marknad. ${"Övrigt om budget och tidplan. ".repeat(10)}`,
    ],
  });
  docs.pending = await createDocument({ ...base, title: "Väntande", reviewStatus: "pending", chunks: ["Väntande dokument om kampanjvillkor Zebra."] });
  docs.expired = await createDocument({ ...base, title: "Utgånget", validUntil: "2026-02-01", chunks: ["Utgånget dokument om kampanjvillkor Zebra."] });
  docs.archived = await createDocument({ ...base, title: "Arkiverat", reviewStatus: "archived", chunks: ["Arkiverat dokument om kampanjvillkor Zebra."] });
  docs.rejected = await createDocument({ ...base, title: "Avvisat", reviewStatus: "rejected", chunks: ["Avvisat dokument om kampanjvillkor Zebra."] });
  docs.groupB = await createDocument({
    ownerGroupId: groupB,
    uploadedBy: admin.id,
    assistantIds: [warranty],
    title: "Grupp B",
    chunks: ["Garantidokument för grupp B om laddkabel Zebra."],
  });

  const { data: conv, error } = await memberA.client
    .from("conversations")
    .insert({ assistant_id: sales, title: "Privat test", user_id: memberA.id })
    .select("id")
    .single();
  if (error) throw error;
  conversationA = conv.id;
  await memberA.client.from("messages").insert({ conversation_id: conversationA, role: "user", content: "Hemlig fråga" });
}, 180_000);

afterAll(async () => {
  await cleanup();
}, 180_000);

const search = (u: LiveUser, assistant: string, q: string) =>
  u.client.rpc("search_document_chunks", { p_assistant_id: assistant, p_query: q, p_limit: 10 });

describe("sessions (real Supabase Auth)", () => {
  it("issues aal2 tokens with timestamped amr after TOTP (basis for the 7-day rule)", async () => {
    const { data } = await memberA.client.auth.getSession();
    const claims = jwtClaims(data.session!.access_token);
    expect(claims.aal).toBe("aal2");
    expect(Array.isArray(claims.amr)).toBe(true);
    expect(claims.amr.every((m: { timestamp?: number }) => typeof m.timestamp === "number")).toBe(true);
    expect(claims.amr.map((m: { method: string }) => m.method)).toEqual(expect.arrayContaining(["password", "totp"]));
  });

  it("password-only (aal1) sessions get no data", async () => {
    for (const table of ["groups", "documents", "conversations", "assistant_grants"]) {
      const { data } = await noMfa.client.from(table).select("*");
      expect(data ?? [], table).toHaveLength(0);
    }
    const { data } = await search(noMfa, sales, "Aurora");
    expect(data ?? []).toHaveLength(0);
  });

  it("anonymous requests get nothing", async () => {
    const anon = anonClient();
    for (const table of ["profiles", "documents", "conversations", "audit_log"]) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      expect(error !== null || (data ?? []).length === 0, table).toBe(true);
    }
  });
});

describe("documents and search", () => {
  it("members see approved documents of their groups only", async () => {
    const ids = (await memberA.client.from("documents").select("id")).data!.map((d) => d.id);
    expect(ids).toContain(docs.approved.id);
    expect(ids).toContain(docs.expired.id); // visible in the list, marked expired
    expect(ids).not.toContain(docs.pending.id);
    expect(ids).not.toContain(docs.groupB.id);
    const idsB = (await memberB.client.from("documents").select("id")).data!.map((d) => d.id);
    expect(idsB).toEqual([docs.groupB.id]);
  });

  it("search returns only approved, valid documents via a granted assistant, with a focused snippet", async () => {
    const { data, error } = await search(memberA, sales, "Vad är kodordet för projekt Aurora?");
    expect(error).toBeNull();
    expect(data![0].document_id).toBe(docs.approved.id);
    expect(data![0].snippet).toContain("Blå Ekorre");
    expect(data![0].snippet.startsWith("Bakgrund")).toBe(false);

    const zebra = (await search(memberA, sales, "kampanjvillkor Zebra")).data!.map((r: { document_id: string }) => r.document_id);
    expect(zebra).not.toContain(docs.pending.id);
    expect(zebra).not.toContain(docs.expired.id);
    expect(zebra).not.toContain(docs.archived.id);
    expect(zebra).not.toContain(docs.rejected.id);
  });

  it("does not leak across groups or assistants", async () => {
    expect((await search(memberA, warranty, "laddkabel Zebra")).data ?? []).toHaveLength(0);
    expect((await search(memberA, analysis, "Aurora")).data ?? []).toHaveLength(0);
    expect((await search(memberB, sales, "Aurora")).data ?? []).toHaveLength(0);
    // Even calling the function directly with another user's document terms.
    const b = (await search(memberB, warranty, "Aurora kodordet")).data ?? [];
    expect(b.map((r: { document_id: string }) => r.document_id)).not.toContain(docs.approved.id);
  });

  it("pending documents are visible to the group's reviewer, who can approve; members cannot", async () => {
    expect((await managerA.client.from("documents").select("id").eq("id", docs.pending.id)).data).toHaveLength(1);
    const member = await memberA.client.from("documents").update({ review_status: "approved" }).eq("id", docs.pending.id).select("id");
    expect(member.data ?? []).toHaveLength(0);
    const other = await memberB.client.from("documents").update({ review_status: "approved" }).eq("id", docs.pending.id).select("id");
    expect(other.data ?? []).toHaveLength(0);
  });

  it("sharing with another group takes effect immediately and can be revoked", async () => {
    await service().from("document_shares").insert({ document_id: docs.groupB.id, group_id: groupA });
    expect((await memberA.client.from("documents").select("id").eq("id", docs.groupB.id)).data).toHaveLength(1);
    // Visible, but still not searchable through an assistant memberA lacks.
    expect((await search(memberA, warranty, "laddkabel Zebra")).data ?? []).toHaveLength(0);
    await service().from("document_shares").delete().eq("document_id", docs.groupB.id).eq("group_id", groupA);
    expect((await memberA.client.from("documents").select("id").eq("id", docs.groupB.id)).data).toHaveLength(0);
  });

  it("instructions are not readable by users", async () => {
    const { error } = await memberA.client.from("assistants").select("instructions").limit(1);
    expect(error).not.toBeNull();
    const rpc = await memberA.client.rpc("get_assistant_instructions", { p_assistant_id: sales });
    expect(rpc.error).not.toBeNull();
  });
});

describe("storage (private bucket, server-only access)", () => {
  it("users cannot download, sign, list or upload directly – even for documents they may read", async () => {
    const bucket = memberA.client.storage.from("documents");
    expect((await bucket.download(docs.approved.path)).error).not.toBeNull();
    expect((await bucket.createSignedUrl(docs.approved.path, 60)).error).not.toBeNull();
    const list = await bucket.list(docs.approved.id);
    expect(list.error !== null || (list.data ?? []).length === 0).toBe(true);
    expect((await bucket.upload(`${docs.approved.id}/evil.txt`, Buffer.from("x"), { contentType: "text/plain" })).error).not.toBeNull();
    expect((await anonClient().storage.from("documents").download(docs.approved.path)).error).not.toBeNull();
  });

  it("the bucket enforces size and file-type limits even with a valid upload token", async () => {
    const svc = service();
    const big = `limits-${RUN}/big.txt`;
    const html = `limits-${RUN}/page.html`;
    const signBig = await svc.storage.from("documents").createSignedUploadUrl(big);
    const resBig = await anonClient().storage.from("documents").uploadToSignedUrl(big, signBig.data!.token, Buffer.alloc(51 * 1024 * 1024, 97), {
      contentType: "text/plain",
    });
    const signHtml = await svc.storage.from("documents").createSignedUploadUrl(html);
    const resHtml = await anonClient().storage.from("documents").uploadToSignedUrl(html, signHtml.data!.token, Buffer.from("<script>1</script>"), {
      contentType: "text/html",
    });
    await svc.storage.from("documents").remove([big, html]);
    expect(resBig.error, "51 MB accepted").not.toBeNull();
    expect(resHtml.error, "text/html accepted").not.toBeNull();
  }, 120_000);
});

describe("conversations are private", () => {
  it("other users and administrators cannot read, write or delete them", async () => {
    for (const u of [memberB, admin, managerA]) {
      expect((await u.client.from("conversations").select("id").eq("id", conversationA)).data ?? []).toHaveLength(0);
      expect((await u.client.from("messages").select("id").eq("conversation_id", conversationA)).data ?? []).toHaveLength(0);
      const ins = await u.client.from("messages").insert({ conversation_id: conversationA, role: "assistant", content: "x" });
      expect(ins.error).not.toBeNull();
      const del = await u.client.from("conversations").delete().eq("id", conversationA).select("id");
      expect(del.data ?? []).toHaveLength(0);
    }
    expect((await memberA.client.from("messages").select("content").eq("conversation_id", conversationA)).data).toEqual([
      { content: "Hemlig fråga" },
    ]);
  });

  it("users cannot start conversations with assistants they lack", async () => {
    const { error } = await memberA.client.from("conversations").insert({ assistant_id: warranty, user_id: memberA.id });
    expect(error).not.toBeNull();
  });

  it("messages are immutable", async () => {
    const { error } = await memberA.client.from("messages").update({ content: "ändrad" }).eq("conversation_id", conversationA);
    expect(error).not.toBeNull();
  });
});

describe("privilege escalation is impossible", () => {
  it("users cannot raise their own role, status or memberships", async () => {
    expect((await memberA.client.from("profiles").update({ role: "system_admin" }).eq("id", memberA.id)).error).not.toBeNull();
    expect((await memberA.client.from("profiles").update({ mfa_enrolled_at: null }).eq("id", memberA.id)).error).not.toBeNull();
    expect((await memberA.client.from("group_members").insert({ group_id: groupB, user_id: memberA.id })).error).not.toBeNull();
    expect((await memberA.client.from("group_members").update({ is_manager: true }).eq("user_id", memberA.id).select()).data ?? []).toHaveLength(0);
    expect((await memberA.client.from("assistant_grants").insert({ assistant_id: warranty, user_id: memberA.id })).error).not.toBeNull();
    expect((await memberA.client.from("ai_usage").insert({ user_id: memberA.id, provider: "x", model: "y" })).error).not.toBeNull();
    expect((await memberA.client.from("audit_log").select("id").limit(1)).data ?? []).toHaveLength(0);
    const { data: me } = await memberA.client.from("profiles").select("role").eq("id", memberA.id).single();
    expect(me!.role).toBe("employee");
  });

  it("even administrators cannot change their own role through the API", async () => {
    expect((await admin.client.from("profiles").update({ role: "employee" }).eq("id", admin.id)).error).not.toBeNull();
  });
});

describe("changes take effect for signed-in users without re-login", () => {
  it("revoking an assistant grant removes access immediately", async () => {
    const svc = service();
    expect((await memberA.client.rpc("my_assistant_ids")).data).toContain(sales);
    await svc.from("assistant_grants").delete().eq("assistant_id", sales).eq("group_id", groupA);
    expect((await memberA.client.rpc("my_assistant_ids")).data ?? []).not.toContain(sales);
    expect((await search(memberA, sales, "Aurora")).data ?? []).toHaveLength(0);
    await svc.from("assistant_grants").insert({ assistant_id: sales, group_id: groupA });
    expect((await search(memberA, sales, "Aurora")).data!.length).toBeGreaterThan(0);
  });

  it("removing a group membership removes document access immediately", async () => {
    const svc = service();
    await svc.from("group_members").delete().eq("group_id", groupA).eq("user_id", memberA.id);
    expect((await memberA.client.from("documents").select("id").eq("id", docs.approved.id)).data).toHaveLength(0);
    await svc.from("group_members").insert({ group_id: groupA, user_id: memberA.id, is_manager: false });
  });

  it("demoting an administrator removes admin access on the same token", async () => {
    const svc = service();
    expect((await admin.client.from("audit_log").select("id").limit(1)).data!.length).toBe(1);
    await svc.from("profiles").update({ role: "employee" }).eq("id", admin.id);
    expect((await admin.client.from("audit_log").select("id").limit(1)).data ?? []).toHaveLength(0);
    await svc.from("profiles").update({ role: "system_admin" }).eq("id", admin.id);
  });

  it("an MFA reset revokes access for the existing session immediately", async () => {
    const svc = service();
    expect((await managerA.client.from("documents").select("id").eq("id", docs.approved.id)).data).toHaveLength(1);
    const { data: factors } = await svc.auth.admin.mfa.listFactors({ userId: managerA.id });
    for (const f of factors!.factors) await svc.auth.admin.mfa.deleteFactor({ userId: managerA.id, id: f.id });
    await svc.from("profiles").update({ mfa_enrolled_at: null }).eq("id", managerA.id);
    expect((await managerA.client.from("documents").select("id")).data ?? []).toHaveLength(0);
    expect((await search(managerA, sales, "Aurora")).data ?? []).toHaveLength(0);
  });

  it("a disabled user loses access on the existing session and cannot refresh it", async () => {
    const svc = service();
    await svc.from("profiles").update({ status: "disabled" }).eq("id", memberB.id);
    await svc.auth.admin.updateUserById(memberB.id, { ban_duration: "876000h" });
    expect((await memberB.client.from("documents").select("id")).data ?? []).toHaveLength(0);
    expect((await search(memberB, warranty, "laddkabel")).data ?? []).toHaveLength(0);
    const refresh = await memberB.client.auth.refreshSession();
    expect(refresh.error).not.toBeNull();
    const relogin = await anonClient().auth.signInWithPassword({ email: memberB.email, password: memberB.password });
    expect(relogin.error).not.toBeNull();
    // Re-enable for completeness: ban lifted, sign-in works again.
    await svc.auth.admin.updateUserById(memberB.id, { ban_duration: "none" });
    await svc.from("profiles").update({ status: "active" }).eq("id", memberB.id);
    const again = await anonClient().auth.signInWithPassword({ email: memberB.email, password: memberB.password });
    expect(again.error).toBeNull();
  });
});

describe("retention review", () => {
  it("is admin-only, shows counts only and purges only conversations inactive > 12 months", async () => {
    const svc = service();
    expect((await memberA.client.rpc("conversation_retention_summary")).error).not.toBeNull();
    expect((await memberA.client.rpc("purge_conversations", { p_inactive_before: new Date(Date.now() - 400 * 86400e3).toISOString() })).error).not.toBeNull();

    // One synthetic conversation, 20 months old, owned by memberB.
    const old = new Date(Date.now() - 600 * 86400e3).toISOString();
    const { data: conv } = await svc.from("conversations").insert({ user_id: memberB.id, assistant_id: warranty, title: "Gammal", last_message_at: old }).select("id").single();
    await svc.from("messages").insert({ conversation_id: conv!.id, role: "user", content: "gammal", created_at: old });

    const summary = await admin.client.rpc("conversation_retention_summary");
    expect(summary.error).toBeNull();
    expect(Object.keys(summary.data![0]).sort()).toEqual(["conversations", "inactive_since", "messages"]);

    // Too recent cutoff is refused.
    const recent = await admin.client.rpc("purge_conversations", { p_inactive_before: new Date(Date.now() - 100 * 86400e3).toISOString() });
    expect(recent.error).not.toBeNull();

    // Safety: only purge if the ONLY conversation older than the cutoff is ours.
    const cutoff = new Date(Date.now() - 400 * 86400e3).toISOString();
    const { count } = await svc.from("conversations").select("id", { count: "exact", head: true }).lt("last_message_at", cutoff);
    expect(count).toBe(1);
    const purge = await admin.client.rpc("purge_conversations", { p_inactive_before: cutoff });
    expect(purge.error).toBeNull();
    expect(Number(purge.data)).toBe(1);
    expect((await svc.from("conversations").select("id").eq("id", conv!.id)).data).toHaveLength(0);
    expect((await svc.from("conversations").select("id").eq("id", conversationA)).data).toHaveLength(1);
  });
});

describe("audit log hygiene", () => {
  it("contains no passwords, tokens or secrets for the test users", async () => {
    const { data } = await service()
      .from("audit_log")
      .select("action, metadata")
      .in("actor_id", [admin.id, managerA.id, memberA.id, memberB.id]);
    const text = JSON.stringify(data);
    for (const u of [admin, managerA, memberA, memberB]) expect(text).not.toContain(u.password);
    expect(text).not.toMatch(/password"?\s*:|access_token|refresh_token|sb_secret|totp_secret/i);
  });
});
