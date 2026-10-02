/**
 * LIVE tests of conversation attachments (ADR-045) against the DEVELOPMENT
 * Supabase project: signed upload to the private bucket, server-side
 * reading, owner-only RLS through PostgREST, search within the
 * conversation, and file removal through the deletion queue. Synthetic
 * files only. No OpenAI calls (embeddings are skipped when attachments may
 * not go to the provider).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { safeObjectName } from "@/lib/files";
import { ATTACHMENT_BUCKET, deleteStaleUploads, processStorageDeletionQueue } from "@/server/attachments/cleanup";
import { processAttachment, type AttachmentRow } from "@/server/attachments/processing";

import { anonClient, assistantId, cleanup, createGroup, createUser, isDevelopmentProject, service, type LiveUser } from "./helpers";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

describe.skipIf(!isDevelopmentProject)("conversation attachments (live, development project)", () => {
  let owner: LiveUser;
  let colleague: LiveUser;
  let conversation: string;

  beforeAll(async () => {
    const sales = await assistantId("salj");
    const group = await createGroup("bilagor");
    owner = await createUser("bilagaagare");
    colleague = await createUser("bilagakollega", { role: "system_admin" });
    const svc = service();
    await svc.from("group_members").insert([
      { group_id: group, user_id: owner.id, is_manager: false },
      { group_id: group, user_id: colleague.id, is_manager: false },
    ]);
    await svc.from("assistant_grants").insert({ assistant_id: sales, group_id: group });
    const { data, error } = await owner.client
      .from("conversations")
      .insert({ assistant_id: sales, title: "Syntetisk bilagetest" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    conversation = data.id;
  });

  afterAll(async () => {
    await cleanup();
    // Deleted users cascade to their attachments; their files are queued.
    await processStorageDeletionQueue(500);
  });

  /** Mirrors createAttachmentUploadAction + the browser upload. */
  async function upload(user: LiveUser, fileName: string, fileType: string, kind: "document" | "image", mime: string, bytes: Buffer) {
    const { data: row, error } = await user.client
      .from("conversation_attachments")
      .insert({ kind, file_name: fileName, file_type: fileType, mime_type: mime, size_bytes: bytes.length })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const path = `${user.id}/${row.id}/${safeObjectName(fileName)}`;
    const admin = service();
    const { data: signed } = await admin.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
    await admin.from("conversation_attachments").update({ storage_path: path }).eq("id", row.id);
    const up = await anonClient().storage.from(ATTACHMENT_BUCKET).uploadToSignedUrl(path, signed!.token, bytes, { contentType: mime });
    if (up.error) throw new Error(up.error.message);
    const attachment: AttachmentRow = { id: row.id, user_id: user.id, kind, file_type: fileType as AttachmentRow["file_type"], size_bytes: bytes.length, storage_path: path };
    return { attachment, path };
  }

  const fileExists = async (path: string) => {
    const { data } = await service().storage.from(ATTACHMENT_BUCKET).download(path);
    return Boolean(data);
  };

  it("uploads, reads and searches a text attachment for the owner only", async () => {
    const text = "Syntetisk offert för Testbil Kappa.\n\nPris 389 900 kr. Leverans vecka 48. Gäller till 2026-11-30.";
    const { attachment } = await upload(owner, "Syntetisk offert.txt", "txt", "document", "text/plain", Buffer.from(text));
    expect(await processAttachment(attachment)).toEqual({ ok: true });

    const bind = await owner.client.from("conversation_attachments").update({ conversation_id: conversation }).eq("id", attachment.id).select("id");
    expect(bind.data).toHaveLength(1);

    const own = await owner.client.from("conversation_attachments").select("status, content_mode, char_count").eq("id", attachment.id).single();
    expect(own.data).toMatchObject({ status: "ready", content_mode: "text" });
    const chunks = await owner.client.from("conversation_attachment_chunks").select("content").eq("attachment_id", attachment.id);
    expect(chunks.data?.[0].content).toContain("Testbil Kappa");
    const hits = await owner.client.rpc("search_conversation_attachments", { p_conversation_id: conversation, p_query: "Testbil Kappa leverans" });
    expect(hits.error).toBeNull();
    expect(hits.data?.[0]).toMatchObject({ file_name: "Syntetisk offert.txt", fts_match: true });

    // A colleague – here a system administrator – sees nothing.
    expect((await colleague.client.from("conversation_attachments").select("id").eq("id", attachment.id)).data).toEqual([]);
    expect((await colleague.client.from("conversation_attachment_chunks").select("id").eq("attachment_id", attachment.id)).data).toEqual([]);
    const theirs = await colleague.client.rpc("search_conversation_attachments", { p_conversation_id: conversation, p_query: "Testbil Kappa" });
    expect(theirs.data ?? []).toEqual([]);
    const steal = await colleague.client.from("conversation_attachments").delete().eq("id", attachment.id).select("id");
    expect(steal.data ?? []).toEqual([]);
  });

  it("accepts a real image and rejects a file that only pretends to be one", async () => {
    const real = await upload(owner, "syntetisk.png", "png", "image", "image/png", PNG_1X1);
    expect(await processAttachment(real.attachment)).toEqual({ ok: true });
    const { data } = await owner.client.from("conversation_attachments").select("content_mode").eq("id", real.attachment.id).single();
    expect(data?.content_mode).toBe("image");

    const fake = await upload(owner, "fejk.png", "png", "image", "image/png", Buffer.from("<html>inte en bild</html>"));
    const result = await processAttachment(fake.attachment);
    expect(result).toEqual({ ok: false, error: "Filen är inte en giltig bild av den angivna typen." });
  });

  it("users cannot mark their own upload as ready or point it at another file", async () => {
    const { attachment } = await upload(owner, "x.txt", "txt", "document", "text/plain", Buffer.from("Syntetisk text."));
    const ready = await owner.client.from("conversation_attachments").update({ status: "ready" }).eq("id", attachment.id);
    expect(ready.error).not.toBeNull();
    const path = await owner.client.from("conversation_attachments").update({ storage_path: "annan/fil.txt" }).eq("id", attachment.id);
    expect(path.error).not.toBeNull();
    // The storage bucket itself is closed to end users.
    const direct = await owner.client.storage.from(ATTACHMENT_BUCKET).download(`${owner.id}/${attachment.id}/x.txt`);
    expect(direct.data).toBeNull();
  });

  it("removing an attachment removes its file via the queue", async () => {
    const { attachment, path } = await upload(owner, "ta-bort.txt", "txt", "document", "text/plain", Buffer.from("Syntetisk text att ta bort."));
    expect(await fileExists(path)).toBe(true);
    const del = await owner.client.from("conversation_attachments").delete().eq("id", attachment.id).select("id");
    expect(del.data).toHaveLength(1);
    const { data: queued } = await service().from("storage_deletion_queue").select("id").eq("path", path);
    expect(queued).toHaveLength(1);
    await processStorageDeletionQueue();
    expect(await fileExists(path)).toBe(false);
    expect((await service().from("storage_deletion_queue").select("id").eq("path", path)).data).toEqual([]);
  });

  it("deleting the conversation removes all its attachment files", async () => {
    const { attachment, path } = await upload(owner, "i-konversation.csv", "csv", "document", "text/csv", Buffer.from("Modell;Pris\nTestbil Lambda;3 995"));
    expect(await processAttachment(attachment)).toEqual({ ok: true });
    await owner.client.from("conversation_attachments").update({ conversation_id: conversation }).eq("id", attachment.id);
    const del = await owner.client.from("conversations").delete().eq("id", conversation).select("id");
    expect(del.data).toHaveLength(1);
    await processStorageDeletionQueue();
    expect(await fileExists(path)).toBe(false);
    expect((await service().from("conversation_attachments").select("id").eq("id", attachment.id)).data).toEqual([]);
  });

  it("uploads never sent are removed after 24 hours", async () => {
    const { attachment, path } = await upload(owner, "osänd.txt", "txt", "document", "text/plain", Buffer.from("Syntetisk osänd fil."));
    await service()
      .from("conversation_attachments")
      .update({ created_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
      .eq("id", attachment.id);
    expect(await deleteStaleUploads()).toBeGreaterThanOrEqual(1);
    await processStorageDeletionQueue();
    expect(await fileExists(path)).toBe(false);
  });

  it("a queued file that is already gone is cleared without error (removal can be repeated)", async () => {
    const svc = service();
    const path = `${owner.id}/${crypto.randomUUID()}/finns-inte.txt`;
    const { data } = await svc
      .from("storage_deletion_queue")
      .insert({ bucket: ATTACHMENT_BUCKET, path, reason: "live_test" })
      .select("id")
      .single();
    const result = await processStorageDeletionQueue();
    expect(result.failed).toBe(0);
    expect((await svc.from("storage_deletion_queue").select("id").eq("id", data!.id)).data).toEqual([]);
  });
});
