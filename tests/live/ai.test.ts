/**
 * LIVE tests of the AI data guard against the DEVELOPMENT Supabase project
 * (PostgREST, RLS, triggers, pgvector). Skipped unless FOLKE_ENVIRONMENT is
 * "development" in .env.local, so they can never run against the pilot.
 *
 * No OpenAI calls are made here; vectors are synthetic unit vectors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assistantId,
  cleanup,
  createDocument,
  createGroup,
  createUser,
  isDevelopmentProject,
  service,
  type LiveUser,
} from "./helpers";

const MODEL = "text-embedding-3-small";

function vec(axis: number) {
  const v = new Array<number>(1536).fill(0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

describe.skipIf(!isDevelopmentProject)("AI data guard (live, development project)", () => {
  let tester: LiveUser, colleague: LiveUser;
  let group: string, warranty: string;
  let internalDoc: { id: string }, syntheticDoc: { id: string };

  beforeAll(async () => {
    warranty = await assistantId("garanti");
    group = await createGroup("AI");
    tester = await createUser("aitester");
    colleague = await createUser("aicolleague");
    const svc = service();
    await svc.from("group_members").insert([
      { group_id: group, user_id: tester.id, is_manager: false },
      { group_id: group, user_id: colleague.id, is_manager: false },
    ]);
    await svc.from("assistant_grants").insert({ assistant_id: warranty, group_id: group });
    await svc.from("profiles").update({ ai_test_access: true }).eq("id", tester.id);

    const base = { ownerGroupId: group, uploadedBy: tester.id, assistantIds: [warranty] };
    internalDoc = await createDocument({ ...base, title: "intern", chunks: ["Intern rutin om laddkabel Kvarnsten."] });
    syntheticDoc = await createDocument({
      ...base,
      title: "syntetisk",
      dataClass: "synthetic",
      chunks: ["Syntetisk garanti: laddkabel 24 månader, kodord Ekorre."],
    });
    const { error } = await svc
      .from("document_chunks")
      .update({ embedding: vec(5), embedding_model: MODEL, embedded_at: new Date().toISOString() })
      .eq("document_id", syntheticDoc.id);
    if (error) throw new Error(error.message);
  });

  afterAll(cleanup);

  it("users cannot reclassify documents or create synthetic ones", async () => {
    const update = await tester.client
      .from("documents")
      .update({ ai_data_class: "synthetic" })
      .eq("id", internalDoc.id)
      .select("id");
    expect(update.error).not.toBeNull();
    const { data } = await service().from("documents").select("ai_data_class").eq("id", internalDoc.id).single();
    expect(data?.ai_data_class).toBe("internal");
  });

  it("not even the server can store embeddings for internal documents", async () => {
    const { error } = await service()
      .from("document_chunks")
      .update({ embedding: vec(1), embedding_model: MODEL })
      .eq("document_id", internalDoc.id);
    expect(error?.message).toMatch(/godkända för OpenAI/);
  });

  it("users cannot grant themselves AI test access", async () => {
    const { error } = await colleague.client.from("profiles").update({ ai_test_access: true }).eq("id", colleague.id);
    expect(error).not.toBeNull();
  });

  it("only users with AI test access can start synthetic conversations", async () => {
    const denied = await colleague.client
      .from("conversations")
      .insert({ assistant_id: warranty, data_class: "synthetic" })
      .select("id");
    expect(denied.error).not.toBeNull();
    const allowed = await tester.client
      .from("conversations")
      .insert({ assistant_id: warranty, data_class: "synthetic" })
      .select("id, data_class")
      .single();
    expect(allowed.data?.data_class).toBe("synthetic");
    const change = await tester.client
      .from("conversations")
      .update({ data_class: "internal" })
      .eq("id", allowed.data!.id)
      .select("id");
    expect(change.error).not.toBeNull();
    await tester.client.from("conversations").delete().eq("id", allowed.data!.id);
  });

  it("hybrid search restricted to synthetic data never returns internal documents", async () => {
    const { data, error } = await tester.client.rpc("search_document_chunks_hybrid", {
      p_assistant_id: warranty,
      p_query: "laddkabel",
      p_embedding: vec(5),
      p_embedding_model: MODEL,
      p_data_class: "synthetic",
      p_limit: 6,
    });
    expect(error).toBeNull();
    const rows = data as { document_id: string; ai_data_class: string }[];
    expect(rows.map((r) => r.document_id)).toEqual([syntheticDoc.id]);
    expect(rows.every((r) => r.ai_data_class === "synthetic")).toBe(true);
  });

  it("hybrid search respects RLS for users without the assistant", async () => {
    const outsider = await createUser("aioutsider");
    const { data } = await outsider.client.rpc("search_document_chunks_hybrid", {
      p_assistant_id: warranty,
      p_query: "laddkabel",
      p_embedding: vec(5),
      p_embedding_model: MODEL,
      p_data_class: null,
      p_limit: 6,
    });
    expect(data ?? []).toEqual([]);
  });

  it("request limits and the request log are server-only", async () => {
    const read = await tester.client.from("ai_requests").select("id");
    expect(read.error).not.toBeNull();
    const begin = await tester.client.rpc("ai_begin_request", {
      p_user_id: tester.id,
      p_kind: "chat",
      p_max_concurrent: 100,
      p_max_per_minute: 100,
      p_user_daily_limit_usd: 100,
      p_monthly_limit_usd: 100,
    });
    expect(begin.error).not.toBeNull();
    const ok = await service().rpc("ai_begin_request", {
      p_user_id: tester.id,
      p_kind: "chat",
      p_max_concurrent: 1,
      p_max_per_minute: 100,
      p_user_daily_limit_usd: 100,
      p_monthly_limit_usd: 100000,
    });
    expect(ok.data).toMatchObject({ ok: true });
    const second = await service().rpc("ai_begin_request", {
      p_user_id: tester.id,
      p_kind: "chat",
      p_max_concurrent: 1,
      p_max_per_minute: 100,
      p_user_daily_limit_usd: 100,
      p_monthly_limit_usd: 100000,
    });
    expect(second.data).toEqual({ ok: false, reason: "concurrency" });
    await service().rpc("ai_finish_request", { p_request_id: (ok.data as { request_id: string }).request_id, p_status: "completed" });
  });

  it("assistant model choice is not writable by users", async () => {
    const { error, count } = await tester.client
      .from("assistants")
      .update({ ai_model: "gpt-6-astra" }, { count: "exact" })
      .eq("id", warranty);
    expect(error !== null || count === 0).toBe(true);
  });
});

describe.skipIf(!isDevelopmentProject)("Per-document approval for OpenAI (live, development project)", () => {
  let admin: LiveUser, member: LiveUser, outsider: LiveUser;
  let group: string, otherGroup: string, sales: string;
  let doc: { id: string }, otherDoc: { id: string };

  beforeAll(async () => {
    sales = await assistantId("salj");
    group = await createGroup("AIgodk");
    otherGroup = await createGroup("AIannan");
    admin = await createUser("aiapprover", { role: "system_admin" });
    member = await createUser("aimember");
    outsider = await createUser("aioutsider2");
    const svc = service();
    await svc.from("group_members").insert([
      { group_id: group, user_id: member.id, is_manager: false },
      { group_id: otherGroup, user_id: outsider.id, is_manager: false },
    ]);
    await svc.from("assistant_grants").insert([
      { assistant_id: sales, group_id: group },
      { assistant_id: sales, group_id: otherGroup },
    ]);
    doc = await createDocument({
      ownerGroupId: group,
      uploadedBy: admin.id,
      assistantIds: [sales],
      title: "godkänd",
      chunks: ["Prislista Kvarnhjul: modellen kostar 123 456 kr."],
    });
    otherDoc = await createDocument({
      ownerGroupId: group,
      uploadedBy: admin.id,
      assistantIds: [sales],
      title: "ej godkänd",
      chunks: ["Hemlig Kvarnhjul-bilaga: rabatt 9 procent."],
    });
  });

  afterAll(cleanup);

  const searchApproved = (client: LiveUser["client"]) =>
    client
      .rpc("search_document_chunks_hybrid", {
        p_assistant_id: sales,
        p_query: "Kvarnhjul",
        p_embedding: null,
        p_embedding_model: null,
        p_data_class: "approved",
        p_limit: 6,
      })
      .then((r) => ((r.data ?? []) as { document_id: string }[]).map((x) => x.document_id));

  it("is off by default", async () => {
    const { data } = await service().from("documents").select("ai_data_class").in("id", [doc.id, otherDoc.id]);
    expect(data?.map((d) => d.ai_data_class)).toEqual(["internal", "internal"]);
    expect(await searchApproved(member.client)).toEqual([]);
  });

  it("only system administrators can approve", async () => {
    const { error } = await member.client.rpc("set_document_ai_approval", { p_document_id: doc.id, p_approved: true });
    expect(error?.message).toMatch(/systemadministratörer/);
    const direct = await admin.client.from("documents").update({ ai_data_class: "approved" }).eq("id", doc.id).select("id");
    expect(direct.error).not.toBeNull();
  });

  it("an approved document is used, unapproved and other groups' documents are not", async () => {
    const { data, error } = await admin.client.rpc("set_document_ai_approval", { p_document_id: doc.id, p_approved: true });
    expect(error).toBeNull();
    expect(data).toBe("approved");
    const ids = await searchApproved(member.client);
    expect(ids).toEqual([doc.id]);
    expect(ids).not.toContain(otherDoc.id);
    // Same assistant, other group: the approved document stays invisible.
    expect(await searchApproved(outsider.client)).toEqual([]);
    const { data: row } = await service().from("documents").select("ai_index_status, ai_approved_by").eq("id", doc.id).single();
    expect(row).toEqual({ ai_index_status: "pending", ai_approved_by: admin.id });
  });

  it("embeddings are accepted only while approved", async () => {
    const svc = service();
    const ok = await svc.from("document_chunks").update({ embedding: vec(3), embedding_model: MODEL, embedded_at: new Date().toISOString() }).eq("document_id", doc.id);
    expect(ok.error).toBeNull();
    const denied = await svc.from("document_chunks").update({ embedding: vec(3), embedding_model: MODEL }).eq("document_id", otherDoc.id);
    expect(denied.error?.message).toMatch(/godkända för OpenAI/);
  });

  it("revocation takes effect immediately and removes embeddings", async () => {
    const { error } = await admin.client.rpc("set_document_ai_approval", { p_document_id: doc.id, p_approved: false });
    expect(error).toBeNull();
    expect(await searchApproved(member.client)).toEqual([]);
    const { count } = await service()
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", doc.id)
      .not("embedding", "is", null);
    expect(count).toBe(0);
  });

  it("conversations can only be renamed and deleted by their owner", async () => {
    const { data: conv } = await member.client.from("conversations").insert({ assistant_id: sales, title: "Min" }).select("id").single();
    const hijack = await outsider.client.from("conversations").update({ title: "Kapad" }, { count: "exact" }).eq("id", conv!.id);
    expect(hijack.count ?? 0).toBe(0);
    const adminDelete = await admin.client.from("conversations").delete({ count: "exact" }).eq("id", conv!.id);
    expect(adminDelete.count ?? 0).toBe(0);
    const rename = await member.client.from("conversations").update({ title: "Nytt namn" }, { count: "exact" }).eq("id", conv!.id);
    expect(rename.count).toBe(1);
    const del = await member.client.from("conversations").delete({ count: "exact" }).in("id", [conv!.id]);
    expect(del.count).toBe(1);
  });
});
