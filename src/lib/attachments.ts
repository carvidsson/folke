/**
 * Conversation attachments (ADR-045): supported types and limits, shared by
 * the chat UI and the server. The server and the database enforce them
 * again; the UI only gives early, friendly feedback.
 */

export type AttachmentKind = "document" | "image";
export type AttachmentFileType = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "md" | "csv" | "png" | "jpeg" | "webp" | "gif";
export type AttachmentStatus = "uploading" | "processing" | "ready" | "failed";

interface TypeInfo {
  fileType: AttachmentFileType;
  kind: AttachmentKind;
  mime: string;
}

const TYPES: Record<string, TypeInfo> = {
  pdf: { fileType: "pdf", kind: "document", mime: "application/pdf" },
  docx: { fileType: "docx", kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { fileType: "xlsx", kind: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { fileType: "pptx", kind: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  txt: { fileType: "txt", kind: "document", mime: "text/plain" },
  md: { fileType: "md", kind: "document", mime: "text/markdown" },
  csv: { fileType: "csv", kind: "document", mime: "text/csv" },
  png: { fileType: "png", kind: "image", mime: "image/png" },
  jpg: { fileType: "jpeg", kind: "image", mime: "image/jpeg" },
  jpeg: { fileType: "jpeg", kind: "image", mime: "image/jpeg" },
  webp: { fileType: "webp", kind: "image", mime: "image/webp" },
  gif: { fileType: "gif", kind: "image", mime: "image/gif" },
};

export const ATTACHMENT_LIMITS = {
  perMessage: 5,
  perConversation: 20,
  conversationBytes: 100 * 1024 * 1024,
  documentBytes: 20 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  /** Extracted text per document. */
  maxTextChars: 500_000,
  /** PDFs without a text layer (e.g. scanned) are sent as the file itself, within these limits. */
  inlinePdfBytes: 10 * 1024 * 1024,
  inlinePdfPages: 20,
} as const;

/** Short notice shown where files are attached. */
export const ATTACHMENT_NOTICE =
  "Ladda inte upp kunduppgifter, känsliga personuppgifter eller annan information som inte får delas med externa AI-tjänster.";

export const ATTACHMENT_ACCEPT = Object.keys(TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export function attachmentType(fileName: string): TypeInfo | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? null;
}

const MB = 1024 * 1024;

/** A user-facing problem with a file before upload, or null. */
export function attachmentProblem(fileName: string, sizeBytes: number): string | null {
  const info = attachmentType(fileName);
  if (!info) {
    return `${fileName}: filtypen stöds inte. Använd PDF, Word, Excel, PowerPoint, text, CSV eller bild (PNG, JPEG, WEBP, GIF).`;
  }
  if (sizeBytes <= 0) return `${fileName} är tom.`;
  const max = info.kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.documentBytes;
  if (sizeBytes > max) return `${fileName} är större än ${max / MB} MB.`;
  return null;
}
