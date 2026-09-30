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
  /** Users with the assistant_manager role responsible for this assistant. */
  managerIds: ID[];
  /** Knowledge collections the assistant may retrieve from. */
  collectionIds: ID[];
  /** System instructions. Server-side only once a backend exists. */
  instructions: string;
  suggestedPrompts: string[];
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

export type DocumentVisibility =
  /** Everyone with access to one of the linked assistants. */
  | { type: "organisation" }
  /** Only the listed groups. */
  | { type: "groups"; groupIds: ID[] }
  /** Only the uploader and assistant managers. */
  | { type: "restricted" };

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KnowledgeCollection {
  id: ID;
  name: string;
  description: string;
}

export type DocumentFileType = "pdf" | "docx" | "xlsx" | "pptx" | "txt";

/** Processing pipeline state (upload -> parse -> embed). */
export type DocumentProcessingState = "ready" | "processing" | "failed";

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
  visibility: DocumentVisibility;
  processing: DocumentProcessingState;
  pageCount: number | null;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface Attachment {
  id: ID;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** A reference from an assistant answer back to a knowledge document. */
export interface SourceReference {
  id: ID;
  documentId: ID;
  title: string;
  excerpt: string;
  location: string | null;
}

export interface Message {
  id: ID;
  role: MessageRole;
  content: string;
  createdAt: Timestamp;
  attachments?: Attachment[];
  sources?: SourceReference[];
}

export interface Conversation {
  id: ID;
  assistantId: ID;
  ownerId: ID;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  messages: Message[];
}

/** Lightweight shape for lists (sidebar, start page). */
export type ConversationSummary = Omit<Conversation, "messages"> & {
  preview: string;
};
