import "server-only";

import { chunkSections } from "@/server/documents/chunk";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

import { indexDocument } from "./indexing";
import { embeddingModel } from "./models";
import { SYNTHETIC_CORPUS, SYNTHETIC_GROUP_NAME, SYNTHETIC_TAG } from "./synthetic-corpus";

/**
 * Server operations for the synthetic AI test setup. Callers MUST have
 * verified that the user is a system administrator. Uses the secret-key
 * client for writes that users cannot make (data class, chunks, embeddings).
 */

const BUCKET = "documents";

function ignoreDuplicate(error: { code?: string; message: string } | null) {
  if (error && error.code !== "23505") throw new Error(error.message);
}

async function ensureSyntheticGroup(): Promise<string> {
  const admin = createSupabaseAdminClient();
  const { data: existing } = await admin
    .from("groups")
    .select("id")
    .eq("name", SYNTHETIC_GROUP_NAME)
    .maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("groups")
    .insert({
      name: SYNTHETIC_GROUP_NAME,
      description: "Testanvändare för AI med syntetiska testdata. Skapas och tas bort från AI-sidan.",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(error?.message ?? "group not created");
  return data.id;
}

export interface CorpusStatus {
  documents: number;
  chunks: number;
  embeddedChunks: number;
  staleEmbeddings: number;
  groupExists: boolean;
  testUsers: number;
}

export async function getSyntheticStatus(): Promise<CorpusStatus> {
  const admin = createSupabaseAdminClient();
  const model = embeddingModel().id;
  const { data: docs } = await admin.from("documents").select("id").eq("ai_data_class", "synthetic");
  const ids = (docs ?? []).map((d: { id: string }) => d.id);
  const { data: chunks } = ids.length
    ? await admin.from("document_chunks").select("embedding_model, embedded_at").in("document_id", ids)
    : { data: [] };
  const rows = (chunks ?? []) as { embedding_model: string | null; embedded_at: string | null }[];
  const { data: group } = await admin.from("groups").select("id").eq("name", SYNTHETIC_GROUP_NAME).maybeSingle();
  const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("ai_test_access", true);
  return {
    documents: ids.length,
    chunks: rows.length,
    embeddedChunks: rows.filter((r) => r.embedded_at && r.embedding_model === model).length,
    staleEmbeddings: rows.filter((r) => r.embedded_at && r.embedding_model !== model).length,
    groupExists: Boolean(group),
    testUsers: count ?? 0,
  };
}

/** Loads the synthetic corpus (idempotent: existing titles are skipped). */
export async function loadSyntheticCorpus(actorId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const groupId = await ensureSyntheticGroup();

  const { data: assistants } = await admin.from("assistants").select("id, slug");
  const assistantId = new Map((assistants ?? []).map((a: { id: string; slug: string }) => [a.slug, a.id]));
  for (const id of assistantId.values()) {
    ignoreDuplicate((await admin.from("assistant_grants").insert({ assistant_id: id, group_id: groupId })).error);
  }

  const { data: collections } = await admin.from("collections").select("id, name");
  const collectionId = new Map((collections ?? []).map((c: { id: string; name: string }) => [c.name, c.id]));
  const { data: existing } = await admin.from("documents").select("title").eq("ai_data_class", "synthetic");
  const existingTitles = new Set((existing ?? []).map((d: { title: string }) => d.title));

  let created = 0;
  for (const doc of SYNTHETIC_CORPUS) {
    if (existingTitles.has(doc.title)) continue;
    const markdown = `# ${doc.title}\n\n${doc.sections.map((s) => s.text).join("\n\n")}\n`;
    const bytes = new TextEncoder().encode(markdown);
    const chunks = chunkSections(doc.sections);
    const fileName = `${doc.key}.md`;

    const { data: row, error } = await admin
      .from("documents")
      .insert({
        title: doc.title,
        file_name: fileName,
        mime_type: "text/markdown",
        file_type: "md",
        size_bytes: bytes.length,
        collection_id: collectionId.get(doc.collection) ?? collectionId.values().next().value,
        owner_group_id: groupId,
        uploaded_by: actorId,
        internal_only_attested_at: new Date().toISOString(),
        review_status: doc.review,
        reviewed_by: doc.review === "approved" ? actorId : null,
        reviewed_at: doc.review === "approved" ? new Date().toISOString() : null,
        processing_status: "ready",
        char_count: chunks.reduce((n, c) => n + c.content.length, 0),
        valid_from: "2026-01-01",
        valid_until: doc.validUntil ?? null,
        tags: [SYNTHETIC_TAG],
        ai_data_class: "synthetic",
      })
      .select("id")
      .single<{ id: string }>();
    if (error || !row) throw new Error(error?.message ?? "document not created");

    const path = `${row.id}/${fileName}`;
    const upload = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "text/markdown" });
    if (!upload.error) await admin.from("documents").update({ storage_path: path }).eq("id", row.id);

    const { error: chunkError } = await admin.from("document_chunks").insert(
      chunks.map((c) => ({ document_id: row.id, chunk_index: c.index, content: c.content, location: c.location })),
    );
    if (chunkError) throw new Error(chunkError.message);
    const links = doc.assistants.flatMap((slug) =>
      assistantId.has(slug) ? [{ document_id: row.id, assistant_id: assistantId.get(slug) }] : [],
    );
    if (links.length) ignoreDuplicate((await admin.from("document_assistants").insert(links)).error);
    created++;
  }
  return created;
}

/** Removes all synthetic documents, their files, chunks and the test group. */
export async function removeSyntheticCorpus(): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { data: docs } = await admin
    .from("documents")
    .select("id, storage_path")
    .eq("ai_data_class", "synthetic");
  const rows = (docs ?? []) as { id: string; storage_path: string | null }[];
  const paths = rows.flatMap((d) => (d.storage_path ? [d.storage_path] : []));
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);
  if (rows.length) {
    const { error } = await admin.from("documents").delete().in("id", rows.map((d) => d.id));
    if (error) throw new Error(error.message);
  }
  await admin.from("groups").delete().eq("name", SYNTHETIC_GROUP_NAME);
  await admin.from("profiles").update({ ai_test_access: false }).eq("ai_test_access", true);
  return rows.length;
}

/** Grants or revokes AI test access (and membership in the synthetic test group). */
export async function setAITestAccess(userId: string, enabled: boolean) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("profiles").update({ ai_test_access: enabled }).eq("id", userId);
  if (error) throw new Error(error.message);
  if (enabled) {
    const groupId = await ensureSyntheticGroup();
    ignoreDuplicate((await admin.from("group_members").insert({ group_id: groupId, user_id: userId, is_manager: false })).error);
  } else {
    const { data: group } = await admin.from("groups").select("id").eq("name", SYNTHETIC_GROUP_NAME).maybeSingle<{ id: string }>();
    if (group) await admin.from("group_members").delete().eq("group_id", group.id).eq("user_id", userId);
  }
}

/** Creates embeddings for all synthetic documents (see ./indexing.ts). */
export async function indexSyntheticEmbeddings(actorId: string): Promise<{ chunks: number; tokens: number }> {
  const admin = createSupabaseAdminClient();
  const { data: docs } = await admin.from("documents").select("id").eq("ai_data_class", "synthetic");
  let chunks = 0;
  let tokens = 0;
  for (const doc of (docs ?? []) as { id: string }[]) {
    const result = await indexDocument(doc.id, actorId);
    if (result.status === "failed") throw new Error(result.error ?? "Indexeringen misslyckades.");
    chunks += result.chunks;
    tokens += result.tokens;
  }
  return { chunks, tokens };
}
