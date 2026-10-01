import type { Capability } from "./roles";
import type {
  AssistantStatus,
  DocumentFileType,
  DocumentProcessingState,
  DocumentReviewStatus,
  DocumentValidity,
  Role,
  UserStatus,
} from "./types";

/** Swedish, user-facing labels for domain enums. */

export const ROLE_LABELS: Record<Role, string> = {
  system_admin: "Systemadministratör",
  assistant_manager: "Assistentansvarig",
  employee: "Medarbetare",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  system_admin:
    "Hanterar användare, grupper och behörigheter för hela plattformen.",
  assistant_manager:
    "Ansvarar för en eller flera assistenters instruktioner och kunskapskällor.",
  employee: "Använder de assistenter och dokument som tilldelats.",
};

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: "Aktiv",
  invited: "Inbjuden",
  disabled: "Inaktiverad",
};

export const ASSISTANT_STATUS_LABELS: Record<AssistantStatus, string> = {
  active: "Aktiv",
  draft: "Utkast",
  paused: "Pausad",
};

export const VALIDITY_LABELS: Record<DocumentValidity, string> = {
  valid: "Giltig",
  expiring: "Går snart ut",
  expired: "Utgången",
  upcoming: "Kommande",
};

export const PROCESSING_LABELS: Record<DocumentProcessingState, string> = {
  queued: "I kö",
  processing: "Bearbetas",
  ready: "Indexerad",
  failed: "Fel vid bearbetning",
};

export const REVIEW_LABELS: Record<DocumentReviewStatus, string> = {
  pending: "Väntar på granskning",
  approved: "Godkänd",
  rejected: "Avvisad",
  archived: "Arkiverad",
};

export const FILE_TYPE_LABELS: Record<DocumentFileType, string> = {
  pdf: "PDF",
  docx: "Word",
  xlsx: "Excel",
  pptx: "PowerPoint",
  txt: "Text",
  md: "Markdown",
  csv: "CSV",
};

/** Short description of who a document is shared with. */
export function sharingLabel(
  sharedGroupIds: string[],
  groups: { id: string; name: string; system?: boolean }[],
): string {
  const shared = groups.filter((g) => sharedGroupIds.includes(g.id));
  if (shared.some((g) => g.system)) return "Alla medarbetare";
  if (shared.length === 0) return "Ej delad";
  if (shared.length === 1) return shared[0].name;
  return `${shared.length} grupper`;
}

export const CAPABILITY_LABELS: Record<Capability, string> = {
  "admin.users.manage": "Hantera användare och inbjudningar",
  "admin.groups.manage": "Hantera användargrupper",
  "admin.permissions.manage": "Tilldela behörigheter",
  "assistants.configure": "Konfigurera assistenter (instruktioner, källor)",
  "knowledge.upload": "Ladda upp dokument",
  "knowledge.manage": "Hantera dokument och giltighet",
  "chat.use": "Använda tilldelade assistenter",
};
