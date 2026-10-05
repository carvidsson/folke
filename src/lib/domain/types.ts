import type { LeadTurn } from "@/lib/leads/chat";

/**
 * Core domain model for Folke.
 *
 * These types describe the product, not the storage. The future Supabase
 * schema should map onto them in the data layer (src/server/data) so UI code
 * never depends on table shapes directly.
 */

export type ID = string;
/** ISO 8601 timestamp. */
export type Timestamp = string;
/** ISO 8601 calendar date (YYYY-MM-DD). */
export type CalendarDate = string;

// ---------------------------------------------------------------------------
// Users, roles and groups
// ---------------------------------------------------------------------------

/**
 * Administrative role. Governs what a user may administer, never which
 * assistants or documents they can use – that is granted separately.
 */
export type Role = "system_admin" | "assistant_manager" | "employee";

export type UserStatus = "active" | "invited" | "disabled";

export interface User {
  id: ID;
  name: string;
  email: string;
  title: string;
  department: string;
  location: string;
  role: Role;
  status: UserStatus;
  /** Whether the user has completed TOTP enrolment. */
  mfaEnrolled: boolean;
  lastActiveAt: Timestamp | null;
}

export interface UserGroup {
  id: ID;
  name: string;
  description: string;
  memberIds: ID[];
  /** Members who may review documents owned by the group. */
  managerIds: ID[];
  /** Maintained automatically (e.g. "all employees"); not editable. */
  system?: boolean;
}

// ---------------------------------------------------------------------------
// Assistants
// ---------------------------------------------------------------------------

export type AssistantStatus = "active" | "draft" | "paused";

/** Muted visual tone used to tell assistants apart. */
export type AssistantTone = "sage" | "slate" | "sand" | "clay";

/** Stable key mapped to an icon in the UI layer. */
export type AssistantIconKey = "sales" | "analysis" | "meetings" | "warranty";

export interface Assistant {
  id: ID;
  slug: string;
  name: string;
  description: string;
  /** One-line description of what the assistant is good at. */
  tagline: string;
  icon: AssistantIconKey;
  tone: AssistantTone;
  status: AssistantStatus;
  /** Users responsible for this assistant's configuration. */
  managerIds: ID[];
  /** Knowledge collections the assistant may retrieve from. */
  collectionIds: ID[];
  suggestedPrompts: string[];
  /** Chosen AI model (validated against the server's allowlist; null = default). */
  aiModel: string | null;
  /** "lead_analysis": answers from Leadanalys instead of the knowledge base (ADR-050). Set in the database only. */
  kind: "documents" | "lead_analysis";
}

// ---------------------------------------------------------------------------
// Access grants
//
// Assistant access and document access are deliberately separate:
// being allowed to use an assistant does not grant access to every document
// the assistant can search, and vice versa. Retrieval must filter on both.
// ---------------------------------------------------------------------------

export type GrantSubject =
  | { type: "user"; userId: ID }
  | { type: "group"; groupId: ID };

export interface AssistantGrant {
  id: ID;
  assistantId: ID;
  subject: GrantSubject;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KnowledgeCollection {
  id: ID;
  name: string;
  description: string;
}

export type DocumentFileType = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "md" | "csv";

/** Processing pipeline state (upload -> extract text -> index). */
export type DocumentProcessingState = "queued" | "processing" | "ready" | "failed";

/** Review workflow. Only approved documents are used as sources. */
export type DocumentReviewStatus = "pending" | "approved" | "rejected" | "archived";

/** Derived from validity dates relative to "now". */
export type DocumentValidity = "valid" | "expiring" | "expired" | "upcoming";

export interface KnowledgeDocument {
  id: ID;
  title: string;
  fileName: string;
  fileType: DocumentFileType;
  sizeBytes: number;
  collectionId: ID;
  /** Assistants that may use this document as a source. */
  assistantIds: ID[];
  tags: string[];
  uploadedById: ID;
  uploadedAt: Timestamp;
  validFrom: CalendarDate;
  validUntil: CalendarDate | null;
  /** Group responsible for the document; its managers review it. */
  ownerGroupId: ID;
  /** Groups whose members may see the document once approved. */
  sharedGroupIds: ID[];
  reviewStatus: DocumentReviewStatus;
  reviewComment: string | null;
  processing: DocumentProcessingState;
  processingError: string | null;
  pageCount: number | null;
  /** "approved" = approved for OpenAI by a system administrator (revocable). */
  aiDataClass: DocumentAIDataClass;
  aiIndexStatus: DocumentAIIndexStatus;
  aiIndexError: string | null;
  aiApprovedAt: Timestamp | null;
}

export type DocumentAIDataClass = "internal" | "approved" | "synthetic";
export type DocumentAIIndexStatus = "none" | "pending" | "indexing" | "ready" | "failed";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface Attachment {
  id: ID;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** The stored conversation attachment (ADR-045); absent for metadata-only entries. */
  attachmentId?: ID;
  kind?: "document" | "image";
}

/** A reference from an assistant answer back to a knowledge document. */
export interface SourceReference {
  kind?: "document";
  id: ID;
  documentId: ID;
  title: string;
  excerpt: string;
  location: string | null;
}

/**
 * Leadanalys in the chat (ADR-050): one lead an answer refers to, with metadata and the
 * avidentified reason from the stored classification. Everything here comes from the server –
 * never from the model. `id` is the HubSpot thread id (used to open the original and to re-check
 * access); the HubSpot link is built from the verified template when the answer is shown.
 */
export interface LeadSourceReference {
  kind: "lead";
  id: string;
  /** "26 sep · Blocket · Volkswagen ID.4" */
  title: string;
  inbox: string;
  seller: string | null;
  /** "Tydligt stöd", "Kunde gjort mer", "Går inte att avgöra från HubSpot" … */
  label: string | null;
  reason: string | null;
  origin: "fact" | "classification";
  hubspotUrl: string | null;
}

/** A set of leads behind an aggregated statement ("Visa alla 14"), opened in the evidence sheet. */
export interface LeadSetReference {
  kind: "lead_set";
  id: string;
  title: string;
  count: number;
  threadIds: string[];
  scope: { regionId: string | null; inboxId: string | null; preset: string; from: string; to: string };
}

/** The server's description of what the answer is based on (never written by the model). */
export interface LeadBasisReference {
  kind: "lead_basis";
  id: string;
  selection: string;
  period: string;
  lines: string[];
  /**
   * Server-computed figures the answer used. Later turns get them back as verified facts, so a figure
   * is never "corrected" just because a later brief does not contain it.
   */
  facts?: VerifiedFact[];
}

/** One server-computed figure, with what it was counted among and for which selection and period. */
export interface VerifiedFact {
  label: string;
  value: string;
  of?: number;
  population: string;
  /** "Alingsås Volkswagen PB · Andreas Lindgren" – names as shown to the user. */
  selection: string;
  period: string;
  /** The ids the figure was computed for; re-checked against the user's access every turn. */
  scope: { regionId: string | null; inboxId: string | null; sellerId: string | null };
}

/**
 * A step the user can choose to fill a gap in the lead material (ADR-050): fetch from HubSpot or
 * analyse the dialogues. It only runs on the user's click, through the Leadanalys actions, which check
 * access, cost limits and the selection again. `question` is asked again when the steps are done.
 */
export interface LeadActionReference {
  kind: "lead_action";
  id: string;
  steps: { action: "sync" | "analyse"; label: string; detail: string; inboxIds: string[] }[];
  /** sellerId: a seller's selection – the analysis covers only the inboxes in the analyse step (ADR-053). */
  scope: { regionId: string | null; inboxId: string | null; sellerId?: string | null; preset: "custom"; from: string; to: string };
  question: string;
  /** When the steps were offered: an analysis job started after this belongs to them (ADR-051). */
  createdAt?: string;
  /** The conversation's pending step: when it is done, the chat continues towards the goal with it. */
  pendingId?: string;
  /** The goal question the chat continues with after the step. */
  goal?: string;
}

/**
 * Questions the user can ask next with one click (Leadanalys, "Jag vill veta mer om en säljare"): only
 * prompts the chat itself sends as the user's next message – never an action of their own.
 */
export interface LeadPromptsReference {
  kind: "lead_prompts";
  id: string;
  prompts: string[];
  /** The structured turn each prompt sends (same order): no interpretation needed for a click. */
  turns?: LeadTurn[];
}

/** Everything an assistant answer can show under it: document excerpts, or (Leadanalys) leads, lead sets, the basis, actions and suggested questions. */
export type MessageSource = SourceReference | LeadSourceReference | LeadSetReference | LeadBasisReference | LeadActionReference | LeadPromptsReference;

export function isDocumentSource(s: MessageSource): s is SourceReference {
  return s.kind === undefined || s.kind === "document";
}

export interface Message {
  id: ID;
  role: MessageRole;
  content: string;
  createdAt: Timestamp;
  attachments?: Attachment[];
  sources?: MessageSource[];
}

/** "lead": Leadanalys conversations (ADR-050). "synthetic" conversations may use an external AI provider (test data only). */
export type ConversationDataClass = "internal" | "synthetic" | "lead";

export interface Conversation {
  id: ID;
  assistantId: ID;
  ownerId: ID;
  title: string;
  dataClass: ConversationDataClass;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  messages: Message[];
}

/** Lightweight shape for lists (sidebar, start page). */
export type ConversationSummary = Omit<Conversation, "messages"> & {
  preview: string;
};
