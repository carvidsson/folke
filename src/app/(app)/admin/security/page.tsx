import type { Metadata } from "next";
import Link from "next/link";

import { Panel } from "@/components/common/panel";
import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requireSystemAdminPage } from "@/server/auth/session";
import { listAuditLog } from "@/server/data/operations";
import { listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Säkerhetslogg" };

const CATEGORIES = {
  all: { label: "Alla", prefix: undefined },
  auth: { label: "Inloggning", prefix: "auth." },
  access: { label: "Nekad åtkomst", prefix: "access." },
  admin: { label: "Administration", prefix: undefined },
  document: { label: "Dokument", prefix: "document" },
} as const;
type Category = keyof typeof CATEGORIES;

/** Swedish labels for known actions; unknown ones are shown as-is. */
const ACTION_LABELS: Record<string, [string, StatusTone]> = {
  "auth.sign_in": ["Inloggning (lösenord)", "neutral"],
  "auth.sign_in_failed": ["Misslyckad inloggning", "warning"],
  "auth.mfa_verified": ["Tvåstegsverifiering klar", "success"],
  "auth.mfa_failed": ["Fel verifieringskod", "warning"],
  "auth.mfa_enrolled": ["Tvåstegsverifiering aktiverad", "success"],
  "auth.mfa_reset": ["Tvåstegsverifiering återställd", "warning"],
  "auth.password_set": ["Lösenord valt", "neutral"],
  "auth.password_reset_requested": ["Återställning begärd", "neutral"],
  "auth.sign_out": ["Utloggning", "neutral"],
  "auth.session_expired": ["Session utgången (7 dagar)", "neutral"],
  "auth.activated": ["Konto aktiverat", "success"],
  "access.denied": ["Åtkomst nekad", "danger"],
  "admin.user_invited": ["Användare inbjuden", "info"],
  "admin.user_reinvited": ["Ny inbjudan skickad", "info"],
  "document.uploaded": ["Dokument uppladdat", "info"],
  "document.processed": ["Dokument bearbetat", "neutral"],
  "document.downloaded": ["Dokument nedladdat", "neutral"],
  "chat.provider_error": ["Fel hos AI-leverantör", "danger"],
  "ai.model_changed": ["AI-modell ändrad", "info"],
  "ai.test_access_changed": ["AI-testbehörighet ändrad", "warning"],
  "ai.synthetic_corpus_loaded": ["Syntetiska testdokument inlästa", "info"],
  "ai.synthetic_corpus_removed": ["Syntetiska testdokument borttagna", "info"],
  "ai.embeddings_indexed": ["Embeddings skapade (syntetiska)", "info"],
  "ai.document_approved": ["Dokument godkänt för OpenAI", "warning"],
  "ai.document_revoked": ["Godkännande för OpenAI återkallat", "info"],
  "ai.instructions_changed": ["AI-instruktioner ändrade", "info"],
  "leads.report_generated": ["Leadanalys hämtad från HubSpot", "info"],
  "leads.ai_analysis_run": ["Leaddialoger analyserade med AI", "warning"],
  "leads.region_analysis_started": ["AI-analys av ort startad", "warning"],
  "leads.synced": ["Leads hämtade från HubSpot", "info"],
  "leads.config_changed": ["Leadanalysens inställningar ändrade", "info"],
  "leads.access_changed": ["Åtkomst till leadanalys ändrad", "warning"],
  "conversations.purge": ["Gallring av konversationer", "warning"],
};

const TABLE_LABELS: Record<string, string> = {
  profiles: "Användare",
  groups: "Grupp",
  group_members: "Gruppmedlemskap",
  assistants: "Assistent",
  assistant_managers: "Assistentansvarig",
  assistant_grants: "Assistentbehörighet",
  documents: "Dokument",
  document_shares: "Dokumentdelning",
  document_assistants: "Dokumentkoppling",
};
const OPS: Record<string, string> = { insert: "skapad", update: "ändrad", delete: "borttagen" };

function describe(action: string): [string, StatusTone] {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const [table, op] = action.split(".");
  if (TABLE_LABELS[table] && OPS[op]) return [`${TABLE_LABELS[table]} ${OPS[op]}`, op === "delete" ? "warning" : "info"];
  return [action, "neutral"];
}

/** Human-readable field names; anything not listed is not shown. */
const FIELD_LABELS: Record<string, string> = {
  title: "Titel",
  name: "Namn",
  full_name: "Namn",
  file_name: "Fil",
  fileType: "Filtyp",
  file_type: "Filtyp",
  sizeBytes: "Storlek (byte)",
  role: "Roll",
  status: "Status",
  is_manager: "Gruppansvarig",
  review_status: "Granskning",
  review_comment: "Kommentar",
  processing_status: "Bearbetning",
  processing_error: "Fel",
  valid_until: "Giltig till",
  instructions_changed: "Instruktioner",
  reason: "Orsak",
  email: "E-post",
  step: "Steg",
  deleted: "Borttagna",
  inactive_before: "Inaktiva före",
  chunks: "Textbitar",
  groups: "Grupper",
  ip: "IP",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function details(metadata: Record<string, unknown>) {
  return Object.entries(metadata)
    .filter(([k, v]) => k in FIELD_LABELS && v !== null && v !== undefined && typeof v !== "object" && !UUID.test(String(v)))
    .slice(0, 5)
    .map(([k, v]) => `${FIELD_LABELS[k]}: ${typeof v === "boolean" ? (v ? "ja" : "nej") : String(v)}`)
    .join(" · ");
}

export default async function SecurityLogPage({ searchParams }: PageProps<"/admin/security">) {
  await requireSystemAdminPage();
  const { category: raw } = await searchParams;
  const category: Category = typeof raw === "string" && raw in CATEGORIES ? (raw as Category) : "all";

  const [entries, users] = await Promise.all([
    listAuditLog({ limit: 300, action: CATEGORIES[category].prefix }),
    listUsers(),
  ]);
  const filtered =
    category === "admin"
      ? entries.filter((e) => !/^(auth|access|document\.|chat)\./.test(e.action) && !e.action.startsWith("document."))
      : entries;
  const userName = new Map(users.map((u) => [u.id, u.name]));

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Säkerhetslogg"
        description="Inloggningar, nekad åtkomst, administrativa ändringar och dokumenthändelser. Loggen innehåller aldrig konversationer eller dokumentinnehåll."
      />

      <nav className="mt-6 flex flex-wrap gap-1.5" aria-label="Kategori">
        {(Object.keys(CATEGORIES) as Category[]).map((c) => (
          <Link
            key={c}
            href={c === "all" ? "/admin/security" : `/admin/security?category=${c}`}
            aria-current={c === category ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
              c === category && "border-navy-300 bg-surface font-medium text-foreground",
            )}
          >
            {CATEGORIES[c].label}
          </Link>
        ))}
      </nav>

      <Panel className="mt-4">
        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Inga händelser.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tid</TableHead>
                <TableHead>Händelse</TableHead>
                <TableHead>Utförd av</TableHead>
                <TableHead className="hidden lg:table-cell">Detaljer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((e) => {
                const [label, tone] = describe(e.action);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatDate(e.occurredAt)} {formatTime(e.occurredAt)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={tone}>{label}</StatusBadge>
                    </TableCell>
                    <TableCell>{e.actorId ? (userName.get(e.actorId) ?? "Borttagen användare") : "Folke (server)"}</TableCell>
                    <TableCell className="hidden max-w-md truncate text-xs text-muted-foreground lg:table-cell">
                      {details(e.metadata)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
      <p className="text-caption mt-3">Visar de senaste 300 händelserna. Inloggningshändelser loggas även av Supabase Auth.</p>
    </PageContainer>
  );
}
