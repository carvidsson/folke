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

describe.skipIf(!isDevelopmentProject)("AI instructions and preferences (live, development project)", () => {
  let admin: LiveUser, employee: LiveUser, other: LiveUser;

  beforeAll(async () => {
    admin = await createUser("instradmin", { role: "system_admin" });
    employee = await createUser("instremployee");
    other = await createUser("instrother");
  });

  afterAll(cleanup);

  it("shared instructions are readable by administrators, not by employees", async () => {
    const asAdmin = await admin.client.from("organization_instructions").select("content");
    expect(asAdmin.data).toHaveLength(1);
    const asEmployee = await employee.client.from("organization_instructions").select("content");
    expect(asEmployee.data ?? []).toEqual([]);
    const revisions = await employee.client.from("instruction_revisions").select("id");
    expect(revisions.data ?? []).toEqual([]);
  });

  it("employees cannot change shared or assistant instructions (no-op, nothing written)", async () => {
    const shared = await employee.client.from("organization_instructions").update({ content: "Kapat" }, { count: "exact" }).eq("id", true);
    expect(shared.count ?? 0).toBe(0);
    const assistant = await employee.client.from("assistants").update({ instructions: "Kapat kapat kapat kapat" }, { count: "exact" }).eq("slug", "salj");
    expect(assistant.error !== null || (assistant.count ?? 0) === 0).toBe(true);
    const revision = await admin.client.from("instruction_revisions").insert({ scope: "organization", content: "x" });
    expect(revision.error).not.toBeNull();
  });

  it("personal preferences are private to the user", async () => {
    const created = await employee.client
      .from("user_ai_preferences")
      .insert({ answer_length: "short", writing_options: ["no_emojis"] })
      .select("user_id")
      .single();
    expect(created.data?.user_id).toBe(employee.id);
    for (const viewer of [admin, other]) {
      const { data } = await viewer.client.from("user_ai_preferences").select("user_id").eq("user_id", employee.id);
      expect(data ?? []).toEqual([]);
    }
    const bad = await other.client.from("user_ai_preferences").insert({ user_id: employee.id });
    expect(bad.error).not.toBeNull();
  });
});

describe.skipIf(!isDevelopmentProject)("Instruction drafts (live, development project)", () => {
  let adminA: LiveUser, adminB: LiveUser, employee: LiveUser;
  let sales: string;

  beforeAll(async () => {
    sales = await assistantId("salj");
    adminA = await createUser("draftadmina", { role: "system_admin" });
    adminB = await createUser("draftadminb", { role: "system_admin" });
    employee = await createUser("draftemployee");
  });

  afterAll(async () => {
    // Drafts created here only (no publishing in the shared project).
    await service().from("instruction_drafts").delete().in("updated_by", [adminA.id, adminB.id]);
    await cleanup();
  });

  it("saving a draft leaves the published text unchanged, and employees cannot see it", async () => {
    const { data: before } = await service().from("assistants").select("instructions").eq("id", sales).single();
    const saved = await adminA.client.rpc("save_instruction_draft", {
      p_scope: "assistant",
      p_assistant_id: sales,
      p_content: `${before!.instructions} Livetest-utkast.`,
      p_expected_updated_at: null,
    });
    expect(saved.error).toBeNull();
    const { data: after } = await service().from("assistants").select("instructions").eq("id", sales).single();
    expect(after!.instructions).toBe(before!.instructions);
    const peek = await employee.client.from("instruction_drafts").select("content");
    expect(peek.data ?? []).toEqual([]);
    const write = await employee.client.rpc("save_instruction_draft", {
      p_scope: "assistant",
      p_assistant_id: sales,
      p_content: "Kapat utkast med tillräckligt lång text",
      p_expected_updated_at: saved.data,
    });
    expect(write.error).not.toBeNull();
  });

  it("two administrators cannot silently overwrite each other's draft", async () => {
    const { data: draft } = await adminA.client.from("instruction_drafts").select("updated_at").eq("target", sales).single();
    const first = await adminB.client.rpc("save_instruction_draft", {
      p_scope: "assistant",
      p_assistant_id: sales,
      p_content: "Administratör B:s ändring med tillräckligt lång text",
      p_expected_updated_at: draft!.updated_at,
    });
    expect(first.error).toBeNull();
    // Administrator A still holds the old version.
    const stale = await adminA.client.rpc("save_instruction_draft", {
      p_scope: "assistant",
      p_assistant_id: sales,
      p_content: "Administratör A:s ändring",
      p_expected_updated_at: draft!.updated_at,
    });
    expect(stale.error?.code).toBe("PT409");
    expect(stale.error?.message).toMatch(/ändrats av någon annan/);
    const publishStale = await adminA.client.rpc("publish_instruction_draft", {
      p_scope: "assistant",
      p_assistant_id: sales,
      p_expected_updated_at: draft!.updated_at,
    });
    expect(publishStale.error?.code).toBe("PT409");
    const { data: kept } = await service().from("instruction_drafts").select("content").eq("target", sales).single();
    expect(kept!.content).toBe("Administratör B:s ändring med tillräckligt lång text");
  });
});

describe.skipIf(!isDevelopmentProject)("Personal AI preferences (live, version 2)", () => {
  let owner: LiveUser, other: LiveUser, admin: LiveUser;

  beforeAll(async () => {
    owner = await createUser("prefowner");
    other = await createUser("prefother");
    admin = await createUser("prefadmin", { role: "system_admin" });
    const r = await owner.client
      .from("user_ai_preferences")
      .upsert({ user_id: owner.id, answer_length: "short", extra_notes: "Privat önskemål" }, { onConflict: "user_id" });
    if (r.error) throw new Error(r.error.message);
  });

  afterAll(cleanup);

  it("are invisible to other users and administrators", async () => {
    for (const viewer of [other, admin]) {
      const { data } = await viewer.client.from("user_ai_preferences").select("extra_notes").eq("user_id", owner.id);
      expect(data ?? []).toEqual([]);
    }
  });

  it("cannot be changed by others through manipulated API calls", async () => {
    const upsert = await other.client
      .from("user_ai_preferences")
      .upsert({ user_id: owner.id, answer_length: "detailed" }, { onConflict: "user_id" });
    expect(upsert.error).not.toBeNull();
    const update = await other.client.from("user_ai_preferences").update({ answer_length: "detailed" }, { count: "exact" }).eq("user_id", owner.id);
    expect(update.count ?? 0).toBe(0);
    const del = await admin.client.from("user_ai_preferences").delete({ count: "exact" }).eq("user_id", owner.id);
    expect(del.count ?? 0).toBe(0);
    const { data } = await service().from("user_ai_preferences").select("answer_length, extra_notes").eq("user_id", owner.id).single();
    expect(data).toEqual({ answer_length: "short", extra_notes: "Privat önskemål" });
  });

  it("users cannot offer the onboarding to someone else", async () => {
    const { count } = await other.client.from("profiles").update({ onboarding_offered: true }, { count: "exact" }).eq("id", owner.id);
    expect(count ?? 0).toBe(0);
  });
});
