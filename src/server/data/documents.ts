import "server-only";

import { documentValidity } from "@/lib/domain/access";
import type {
  DocumentFileType,
  DocumentProcessingState,
  DocumentReviewStatus,
  DocumentValidity,
  ID,
  KnowledgeDocument,
} from "@/lib/domain/types";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

export type KnowledgeDocumentView = KnowledgeDocument & {
  validity: DocumentValidity;
  uploadedByName: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
};

const DOCUMENT_COLUMNS = `
  id, title, file_name, file_type, size_bytes, collection_id, owner_group_id, uploaded_by,
  review_status, review_comment, reviewed_at, processing_status, processing_error, page_count,
  valid_from, valid_until, tags, created_at,
  uploader:profiles!documents_uploaded_by_fkey(full_name, email),
  reviewer:profiles!documents_reviewed_by_fkey(full_name, email),
  document_shares(group_id),
  document_assistants(assistant_id)
`;

interface DocumentRow {
  id: string;
  title: string;
  file_name: string;
  file_type: DocumentFileType;
  size_bytes: number;
  collection_id: string;
  owner_group_id: string;
  uploaded_by: string;
  review_status: DocumentReviewStatus;
  review_comment: string | null;
  reviewed_at: string | null;
  processing_status: DocumentProcessingState;
  processing_error: string | null;
  page_count: number | null;
  valid_from: string;
  valid_until: string | null;
  tags: string[];
  created_at: string;
  uploader: { full_name: string; email: string } | null;
  reviewer: { full_name: string; email: string } | null;
  document_shares: { group_id: string }[];
  document_assistants: { assistant_id: string }[];
}

function toView(row: DocumentRow, now: Date): KnowledgeDocumentView {
  const doc: KnowledgeDocument = {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    fileType: row.file_type,
    sizeBytes: row.size_bytes,
    collectionId: row.collection_id,
    assistantIds: row.document_assistants.map((a) => a.assistant_id),
    tags: row.tags,
    uploadedById: row.uploaded_by,
    uploadedAt: row.created_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    ownerGroupId: row.owner_group_id,
    sharedGroupIds: row.document_shares.map((s) => s.group_id),
    reviewStatus: row.review_status,
    reviewComment: row.review_comment,
    processing: row.processing_status,
    processingError: row.processing_error,
    pageCount: row.page_count,
  };
  return {
    ...doc,
    validity: documentValidity(doc, now),
    uploadedByName: row.uploader?.full_name || row.uploader?.email || "Okänd",
    reviewedByName: row.reviewer ? row.reviewer.full_name || row.reviewer.email : null,
    reviewedAt: row.reviewed_at,
  };
}

/** Documents the current user may see (RLS: own uploads, review area, shared groups). */
export async function listDocuments(): Promise<KnowledgeDocumentView[]> {
  const supabase = await createSupabaseServerClient();
  const rows = unwrap(
    await supabase
      .from("documents")
      .select(DOCUMENT_COLUMNS)
      .order("created_at", { ascending: false })
      .returns<DocumentRow[]>(),
  );
  const now = new Date();
  return rows.map((r) => toView(r, now));
}

export async function getDocument(id: ID): Promise<KnowledgeDocumentView | null> {
  const supabase = await createSupabaseServerClient();
  const row = unwrap(
    await supabase.from("documents").select(DOCUMENT_COLUMNS).eq("id", id).maybeSingle<DocumentRow>(),
  );
  return row ? toView(row, new Date()) : null;
}
