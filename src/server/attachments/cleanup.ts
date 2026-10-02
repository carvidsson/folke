import "server-only";

import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Removal of attachment files (ADR-045). Database deletions (by the user,
 * the conversation cascade, the retention purge or account deletion) queue
 * the file in storage_deletion_queue via a trigger. These functions empty
 * the queue; a failed removal stays queued with its error and attempt count,
 * so it can be retried – later also by a scheduled job.
 */

export const ATTACHMENT_BUCKET = "conversation-attachments";
/** Uploads never sent with a message are removed after this long. */
const STALE_UPLOAD_HOURS = 24;

export interface QueueResult {
  removed: number;
  failed: number;
}

/** `admin` may be injected in tests; otherwise the secret-key client. */
export async function processStorageDeletionQueue(
  limit = 100,
  admin: Pick<ReturnType<typeof createSupabaseAdminClient>, "from" | "storage"> = createSupabaseAdminClient(),
): Promise<QueueResult> {
  const { data, error } = await admin
    .from("storage_deletion_queue")
    .select("id, bucket, path, attempts")
    .order("created_at")
    .limit(limit);
  if (error) {
    console.error("[attachments] could not read the deletion queue", error.message);
    return { removed: 0, failed: 0 };
  }
  const rows = (data ?? []) as { id: number; bucket: string; path: string; attempts: number }[];
  let removed = 0;
  let failed = 0;
  for (const bucket of new Set(rows.map((r) => r.bucket))) {
    const batch = rows.filter((r) => r.bucket === bucket);
    // Removing a file that is already gone is not an error.
    const { error: removeError } = await admin.storage.from(bucket).remove(batch.map((r) => r.path));
    if (removeError) {
      failed += batch.length;
      console.error("[attachments] storage removal failed", { bucket, files: batch.length, error: removeError.message });
      for (const r of batch) {
        await admin
          .from("storage_deletion_queue")
          .update({ attempts: r.attempts + 1, last_error: removeError.message.slice(0, 500), last_attempt_at: new Date().toISOString() })
          .eq("id", r.id);
      }
      continue;
    }
    await admin.from("storage_deletion_queue").delete().in("id", batch.map((r) => r.id));
    removed += batch.length;
  }
  return { removed, failed };
}

/** Deletes uploads that were never sent (their files are queued by the trigger). */
export async function deleteStaleUploads(): Promise<number> {
  const admin = createSupabaseAdminClient();
  const before = new Date(Date.now() - STALE_UPLOAD_HOURS * 3600_000).toISOString();
  const { count, error } = await admin
    .from("conversation_attachments")
    .delete({ count: "exact" })
    .is("conversation_id", null)
    .lt("created_at", before);
  if (error) console.error("[attachments] could not delete stale uploads", error.message);
  return count ?? 0;
}

/** Best-effort cleanup after deletions; never throws. */
export async function cleanUpAttachmentFiles(): Promise<void> {
  try {
    await deleteStaleUploads();
    await processStorageDeletionQueue();
  } catch (error) {
    console.error("[attachments] cleanup failed", error instanceof Error ? error.message : "unknown");
  }
}
