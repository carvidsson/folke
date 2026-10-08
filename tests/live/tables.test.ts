/**
 * LIVE tests of structured Excel analysis (ADR-055) against the DEVELOPMENT Supabase project: a
 * recognised export is stored without text chunks or embeddings, is read only through its owner's
 * RLS, an unchanged file is not downloaded again, other workbooks keep the ordinary attachment
 * processing, and chunks from before the change are removed. Synthetic files only; no OpenAI calls
 * for the export.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { safeObjectName } from "@/lib/files";
import { buildAttachmentContext } from "@/server/attachments/context";
import { ATTACHMENT_BUCKET, processStorageDeletionQueue } from "@/server/attachments/cleanup";
import { processAttachment, type AttachmentRow } from "@/server/attachments/processing";
import { clearTableCache, loadTableDataset } from "@/server/tables/dataset";

import { buildXlsx, scaniaWorkbook } from "../fixtures/xlsx";
import { anonClient, assistantId, cleanup, createGroup, createUser, isDevelopmentProject, service, type LiveUser } from "./helpers";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe.skipIf(!isDevelopmentProject)("structured Excel analysis (live, development project)", () => {
  let owner: LiveUser;
  let colleague: LiveUser;
  let conversation: string;

  beforeAll(async () => {
    const analysis = await assistantId("analys");
    const group = await createGroup("tabeller");
    owner = await createUser("tabellagare");
    colleague = await createUser("tabellkollega", { role: "system_admin" });
    const svc = service();
    await svc.from("group_members").insert([
      { group_id: group, user_id: owner.id, is_manager: false },
      { group_id: group, user_id: colleague.id, is_manager: false },
    ]);
    await svc.from("assistant_grants").insert({ assistant_id: analysis, group_id: group });
    const { data, error } = await owner.client.from("conversations").insert({ assistant_id: analysis, title: "Syntetisk tabelltest" }).select("id").single();
    if (error) throw new Error(error.message);
    conversation = data.id;
  });

  afterAll(async () => {
    await cleanup();
    await processStorageDeletionQueue(500);
  });

  /** Mirrors createAttachmentUploadAction + the browser upload, bound to the conversation. */
  async function upload(user: LiveUser, fileName: string, bytes: Uint8Array) {
    const { data: row, error } = await user.client
      .from("conversation_attachments")
      .insert({ kind: "document", file_name: fileName, file_type: "xlsx", mime_type: XLSX_MIME, size_bytes: bytes.length })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const path = `${user.id}/${row.id}/${safeObjectName(fileName)}`;
    const admin = service();
    const { data: signed } = await admin.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path);
    await admin.from("conversation_attachments").update({ storage_path: path }).eq("id", row.id);
    const up = await anonClient().storage.from(ATTACHMENT_BUCKET).uploadToSignedUrl(path, signed!.token, bytes, { contentType: XLSX_MIME });
    if (up.error) throw new Error(up.error.message);
    const attachment: AttachmentRow = { id: row.id, user_id: user.id, kind: "document", file_type: "xlsx", size_bytes: bytes.length, storage_path: path };
    expect(await processAttachment(attachment)).toEqual({ ok: true });
    const { error: bindError } = await user.client.from("conversation_attachments").update({ conversation_id: conversation }).eq("id", row.id);
    if (bindError) throw new Error(bindError.message);
    return row.id as string;
  }

  const chunks = async (id: string) => (await service().from("conversation_attachment_chunks").select("id", { count: "exact", head: true }).eq("attachment_id", id)).count ?? 0;

  let exportId: string;

  it("stores a recognised export without text chunks or embeddings", async () => {
    const bytes = await scaniaWorkbook([
      { date: "2024-02-01", mst: 100_000, ao: "A1", hgrp: "10", ugrp: "25", labour: 1000 },
      { date: "2024-06-20", mst: 110_000, ao: "A2", hgrp: "10", ugrp: "25", labour: 3000 },
    ]);
    exportId = await upload(owner, "Syntetisk avtalsexport.xlsx", bytes);
    const { data } = await service().from("conversation_attachments").select("status, content_mode, char_count").eq("id", exportId).single();
    expect(data).toEqual({ status: "ready", content_mode: "text", char_count: 0 });
    expect(await chunks(exportId)).toBe(0);
  });

  it("other workbooks keep the ordinary processing", async () => {
    const bytes = await buildXlsx([{ name: "Prislista", rows: [["Modell", "Pris"], ["Testbil Kappa", 389_900], ["Testbil Lambda", 412_000]] }]);
    const id = await upload(owner, "Syntetisk prislista.xlsx", bytes);
    expect(await chunks(id)).toBeGreaterThan(0);
  });

  it("the owner's analysis reads the export; a colleague – even a system administrator – gets nothing", async () => {
    clearTableCache();
    const mine = await loadTableDataset(owner.client, conversation);
    expect(mine?.files).toHaveLength(1);
    expect(mine?.transactions).toHaveLength(2);
    expect(mine?.attachmentIds).toEqual([exportId]);
    expect(await loadTableDataset(colleague.client, conversation)).toBeNull();
    const { data } = await colleague.client.from("conversation_attachments").select("id").eq("id", exportId);
    expect(data).toEqual([]);
  });

  it("the ordinary attachment context gets no content from the export, only that it exists", async () => {
    const ctx = await buildAttachmentContext(owner.client, { conversationId: conversation, message: "Vad står i filerna?", currentIds: [], history: [], embed: null });
    expect(ctx.structured).toBe(1);
    expect(ctx.excerpts.every((e) => e.attachmentId !== exportId)).toBe(true);
  });

  it("removes text chunks an export got before structured analysis existed", async () => {
    const svc = service();
    await svc.from("conversation_attachment_chunks").insert({ attachment_id: exportId, chunk_index: 0, content: "Syntetisk rad", location: null });
    await svc.from("conversation_attachments").update({ char_count: 13 }).eq("id", exportId);
    clearTableCache();
    await loadTableDataset(owner.client, conversation);
    expect(await chunks(exportId)).toBe(0);
    const { data } = await svc.from("conversation_attachments").select("char_count").eq("id", exportId).single();
    expect(data?.char_count).toBe(0);
  });
});
