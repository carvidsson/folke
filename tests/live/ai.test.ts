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
    expect(error?.message).toMatch(/syntetiska/);
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
