"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ATTACHMENT_LIMITS, attachmentProblem, type AttachmentKind, type AttachmentStatus } from "@/lib/attachments";
import type { Attachment } from "@/lib/domain/types";
import { uploadToSignedUrl } from "@/lib/supabase/browser-storage";
import { createAttachmentUploadAction, processAttachmentAction, removeAttachmentAction } from "@/server/attachments/actions";

export interface PendingAttachment {
  localId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  status: AttachmentStatus;
  error?: string;
  attachmentId?: string;
  /** Local object URL for image thumbnails (revoked on removal). */
  previewUrl?: string;
}

/**
 * Uploads chosen files right away (ADR-045): signed upload straight to
 * Storage, then server-side reading. The message can be sent once every
 * file is ready.
 */
export function useAttachmentUploads(conversationId: string | null) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  /** Files rejected before upload, shown in the composer (not as a toast that can cover the send button). */
  const [rejected, setRejected] = useState<string[]>([]);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });

  const update = (localId: string, fields: Partial<PendingAttachment>) =>
    setItems((all) => all.map((a) => (a.localId === localId ? { ...a, ...fields } : a)));

  const upload = useCallback(
    async (file: File, localId: string) => {
      const created = await createAttachmentUploadAction({ fileName: file.name, sizeBytes: file.size, conversationId });
      if (!created.ok) return update(localId, { status: "failed", error: created.error });
      update(localId, { attachmentId: created.attachmentId });
      try {
        await uploadToSignedUrl("conversation-attachments", created.path, created.token, file);
      } catch {
        return update(localId, { status: "failed", error: "Uppladdningen misslyckades. Försök igen." });
      }
      update(localId, { status: "processing" });
      const processed = await processAttachmentAction(created.attachmentId);
      update(localId, processed.ok ? { status: "ready" } : { status: "failed", error: processed.error });
    },
    [conversationId],
  );

  const add = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const problems: string[] = [];
      const room = ATTACHMENT_LIMITS.perMessage - itemsRef.current.length;
      const chosen = Array.from(files);
      if (chosen.length > room) problems.push(`Du kan bifoga högst ${ATTACHMENT_LIMITS.perMessage} filer per meddelande.`);
      for (const file of chosen.slice(0, Math.max(room, 0))) {
        const problem = attachmentProblem(file.name, file.size);
        if (problem) {
          problems.push(problem);
          continue;
        }
        const kind: AttachmentKind = file.type.startsWith("image/") ? "image" : "document";
        const item: PendingAttachment = {
          localId: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          kind,
          status: "uploading",
          previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        };
        setItems((all) => [...all, item]);
        void upload(file, item.localId);
      }
      setRejected(problems);
    },
    [upload],
  );

  const remove = useCallback((localId: string) => {
    const item = itemsRef.current.find((a) => a.localId === localId);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems((all) => all.filter((a) => a.localId !== localId));
    if (item?.attachmentId) void removeAttachmentAction(item.attachmentId);
  }, []);

  /** After sending: the files now belong to the message, so they are not removed. */
  const clear = useCallback(() => {
    for (const a of itemsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setItems([]);
    setRejected([]);
  }, []);

  useEffect(() => () => itemsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)), []);

  const ready: Attachment[] = items
    .filter((a) => a.status === "ready" && a.attachmentId)
    .map((a) => ({ id: a.localId, attachmentId: a.attachmentId, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, kind: a.kind }));

  return {
    items,
    rejected,
    dismissRejected: () => setRejected([]),
    ready,
    add,
    remove,
    clear,
    /** Still uploading or reading. */
    busy: items.some((a) => a.status === "uploading" || a.status === "processing"),
    hasFailed: items.some((a) => a.status === "failed"),
  };
}
