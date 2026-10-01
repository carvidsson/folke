"use client";

import { Archive, Check, Download, Pencil, RefreshCw, RotateCcw, ShieldCheck, ShieldOff, Trash2, UsersRound, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { DetailList, DetailSection } from "@/components/common/detail-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { FILE_TYPE_LABELS } from "@/lib/domain/labels";
import type { Assistant } from "@/lib/domain/types";
import { formatBytes, formatCalendarDate, formatDate } from "@/lib/format";
import {
  deleteDocumentAction,
  getDownloadUrlAction,
  reviewDocumentAction,
} from "@/server/documents/actions";
import {
  reindexDocumentAction,
  setDocumentAIApprovalAction,
  setDocumentAssistantsAction,
} from "@/server/documents/ai-actions";
import type { KnowledgeDocumentView } from "@/server/data/documents";

import { AIBadge, ProcessingBadge, ReviewBadge, ValidityBadge } from "./document-badges";
import { DocumentIcon } from "./document-icon";
import type { GroupOption } from "./knowledge-view";

export function DocumentSheet({
  document,
  onOpenChange,
  collectionName,
  assistants,
  groups,
  canReview,
  canDelete,
  isAdmin,
  aiEnabled,
}: {
  document: KnowledgeDocumentView | null;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  assistants: Assistant[];
  groups: GroupOption[];
  canReview: boolean;
  canDelete: boolean;
  isAdmin: boolean;
  /** OpenAI is enabled for approved documents in this environment. */
  aiEnabled: boolean;
}) {
  return (
    <Sheet open={document !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {document && (
          <DocumentDetails
            key={document.id}
            document={document}
            collectionName={collectionName}
            assistants={assistants.filter((a) => document.assistantIds.includes(a.id))}
            allAssistants={assistants}
            groups={groups}
            canReview={canReview}
            canDelete={canDelete}
            isAdmin={isAdmin}
            aiEnabled={aiEnabled}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DocumentDetails({
  document: d,
  collectionName,
  assistants,
  allAssistants,
  groups,
  canReview,
  canDelete,
  isAdmin,
  aiEnabled,
  onClose,
}: {
  document: KnowledgeDocumentView;
  collectionName: string;
  assistants: Assistant[];
  allAssistants: Assistant[];
  groups: GroupOption[];
  canReview: boolean;
  canDelete: boolean;
  isAdmin: boolean;
  aiEnabled: boolean;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [editingAssistants, setEditingAssistants] = useState(false);
  const [assistantIds, setAssistantIds] = useState<string[]>(d.assistantIds);

  function run(action: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, onOk?: () => void) {
    startTransition(async () => {
      const result = await action().catch(() => ({ ok: false as const, error: "Åtgärden kunde inte genomföras." }));
      if (result.ok) {
        if (result.message) toast.success(result.message);
        onOk?.();
      } else {
        toast.error(result.error);
      }
    });
  }

  function approveForAI() {
    if (
      !window.confirm(
        `Godkänn "${d.title}" för OpenAI?\n\nDokumentets text skickas till OpenAI för indexering (embeddings) och som underlag i svar till behöriga användare. Godkännandet gäller bara det här dokumentet och kan återkallas.`,
      )
    ) {
      return;
    }
    run(() => setDocumentAIApprovalAction(d.id, true));
  }

  function revokeAI() {
    if (!window.confirm(`Återkalla godkännandet för "${d.title}"? Dokumentet används inte längre i nya AI-svar.`)) return;
    run(() => setDocumentAIApprovalAction(d.id, false));
  }
  const owner = groups.find((g) => g.id === d.ownerGroupId);
  const shared = groups.filter((g) => d.sharedGroupIds.includes(g.id));

  function review(decision: "approved" | "rejected" | "archived" | "pending") {
    startTransition(async () => {
      const result = await reviewDocumentAction(d.id, { decision, comment: comment || undefined });
      if (result.ok) {
        toast.success(result.message);
        setRejecting(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  function download() {
    startTransition(async () => {
      const result = await getDownloadUrlAction(d.id);
      if (result.ok) window.location.assign(result.url);
      else toast.error(result.error);
    });
  }

  function remove() {
    if (!window.confirm(`Ta bort "${d.title}"? Det går inte att ångra.`)) return;
    startTransition(async () => {
      const result = await deleteDocumentAction(d.id);
      if (result.ok) {
        toast.success(result.message);
        onClose();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <SheetHeader className="gap-3 p-6 pr-12">
        <DocumentIcon type={d.fileType} className="size-10" />
        <div>
          <SheetTitle className="text-lg leading-6 font-semibold">{d.title}</SheetTitle>
          <SheetDescription className="mt-1">{d.fileName}</SheetDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {d.processing !== "failed" && <ReviewBadge status={d.reviewStatus} />}
          {d.processing !== "ready" && <ProcessingBadge state={d.processing} />}
          {d.reviewStatus === "approved" && <ValidityBadge validity={d.validity} />}
          {(aiEnabled || d.aiDataClass !== "internal") && (
            <AIBadge dataClass={d.aiDataClass} indexStatus={d.aiIndexStatus} />
          )}
        </div>
      </SheetHeader>

      {d.processing === "failed" && d.processingError && (
        <p className="mx-6 mb-4 rounded-lg bg-destructive/6 px-3 py-2.5 text-sm text-destructive">{d.processingError}</p>
      )}
      {d.reviewStatus === "rejected" && d.reviewComment && (
        <p className="mx-6 mb-4 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm">
          <span className="font-medium">Avvisad:</span> {d.reviewComment}
        </p>
      )}

      {canReview && d.reviewStatus === "pending" && (
        <DetailSection title="Granskning">
          {d.processing === "failed" ? (
            <p className="text-sm text-muted-foreground">
              Texten kunde inte läsas ur filen, så dokumentet kan inte godkännas. Ta bort det och
              ladda upp en korrigerad fil.
            </p>
          ) : d.processing !== "ready" ? (
            <p className="text-sm text-muted-foreground">Dokumentet kan granskas när texten har lästs in.</p>
          ) : rejecting ? (
            <div className="flex flex-col gap-3">
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Motivering till uppladdaren"
                aria-label="Motivering"
                rows={3}
                maxLength={500}
              />
              <div className="flex gap-2">
                <Button variant="destructive" disabled={pending || !comment.trim()} onClick={() => review("rejected")}>
                  Avvisa
                </Button>
                <Button variant="outline" onClick={() => setRejecting(false)}>
                  Avbryt
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Kontrollera att dokumentet är korrekt, internt och saknar kunduppgifter. När det godkänns
                kan det användas som källa av medlemmarna i de delade grupperna.
              </p>
              <div className="flex gap-2">
                <Button disabled={pending} onClick={() => review("approved")}>
                  <Check />
                  Godkänn
                </Button>
                <Button variant="outline" disabled={pending} onClick={() => setRejecting(true)}>
                  <X />
                  Avvisa
                </Button>
              </div>
            </div>
          )}
        </DetailSection>
      )}

      {(aiEnabled || d.aiDataClass === "approved") && d.aiDataClass !== "synthetic" && (
        <DetailSection title="OpenAI">
          {d.aiDataClass === "approved" ? (
            <div className="flex flex-col gap-3 text-sm">
              <DetailList
                items={[
                  {
                    label: "Status",
                    value:
                      d.aiIndexStatus === "ready"
                        ? "Godkänt och indexerat"
                        : d.aiIndexStatus === "failed"
                          ? "Godkänt, indexeringen misslyckades"
                          : "Godkänt, indexering pågår",
                  },
                  ...(d.aiApprovedAt
                    ? [{ label: "Godkänt av", value: `${d.aiApprovedByName ?? "Okänd"}, ${formatDate(d.aiApprovedAt)}` }]
                    : []),
                ]}
              />
              {d.aiIndexStatus === "failed" && d.aiIndexError && (
                <p className="rounded-lg bg-destructive/6 px-3 py-2.5 text-destructive">{d.aiIndexError}</p>
              )}
              {d.reviewStatus !== "approved" && (
                <p className="text-muted-foreground">
                  Används först när dokumentet också är godkänt i granskningen och giltigt.
                </p>
              )}
              {isAdmin && (
                <div className="flex flex-wrap gap-2">
                  {d.aiIndexStatus !== "ready" && aiEnabled && (
                    <Button variant="outline" disabled={pending} onClick={() => run(() => reindexDocumentAction(d.id))}>
                      <RefreshCw />
                      Indexera igen
                    </Button>
                  )}
                  <Button variant="outline" className="text-destructive" disabled={pending} onClick={revokeAI}>
                    <ShieldOff />
                    Återkalla godkännande
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">
                Dokumentet är inte godkänt för OpenAI och skickas aldrig dit. Assistenterna använder det inte i AI-svar.
              </p>
              {isAdmin &&
                (d.processing === "ready" ? (
                  <div>
                    <Button disabled={pending} onClick={approveForAI}>
                      <ShieldCheck />
                      {pending ? "Godkänner och indexerar…" : "Godkänn för OpenAI"}
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Kan godkännas när texten har lästs in.</p>
                ))}
            </div>
          )}
        </DetailSection>
      )}

      <DetailSection title="Metadata">
        <DetailList
          items={[
            { label: "Samling", value: collectionName },
            { label: "Filtyp", value: FILE_TYPE_LABELS[d.fileType] },
            { label: "Storlek", value: formatBytes(d.sizeBytes) },
            { label: "Sidor", value: d.pageCount ?? "–" },
            { label: "Uppladdad av", value: d.uploadedByName },
            { label: "Uppladdad", value: formatDate(d.uploadedAt) },
            ...(d.reviewedByName && d.reviewedAt
              ? [{ label: "Granskad av", value: `${d.reviewedByName}, ${formatDate(d.reviewedAt)}` }]
              : []),
          ]}
        />
        {d.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {d.tags.map((t) => (
              <Badge key={t} variant="secondary" className="font-normal">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Giltighetsperiod">
        <DetailList
          items={[
            { label: "Giltig från", value: formatCalendarDate(d.validFrom) },
            { label: "Giltig till", value: d.validUntil ? formatCalendarDate(d.validUntil) : "Tillsvidare" },
          ]}
        />
        <p className="text-caption mt-3">
          Dokument utanför giltighetsperioden används inte som källor. Dokument som går ut inom 30 dagar markeras.
        </p>
      </DetailSection>

      <DetailSection title="Används av">
        {editingAssistants ? (
          <div className="flex flex-col gap-3">
            {allAssistants.map((a) => (
              <label key={a.id} className="flex items-center gap-2.5 text-sm">
                <Checkbox
                  checked={assistantIds.includes(a.id)}
                  onCheckedChange={(checked) =>
                    setAssistantIds((ids) => (checked ? [...ids, a.id] : ids.filter((id) => id !== a.id)))
                  }
                />
                <AssistantAvatar assistant={a} size="sm" />
                {a.name}
              </label>
            ))}
            <div className="flex gap-2">
              <Button
                disabled={pending || assistantIds.length === 0}
                onClick={() => run(() => setDocumentAssistantsAction(d.id, assistantIds), () => setEditingAssistants(false))}
              >
                Spara
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setAssistantIds(d.assistantIds);
                  setEditingAssistants(false);
                }}
              >
                Avbryt
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {assistants.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 text-sm">
                  <AssistantAvatar assistant={a} size="sm" />
                  {a.name}
                </li>
              ))}
              {assistants.length === 0 && <li className="text-sm text-muted-foreground">Ingen assistent</li>}
            </ul>
            {canReview && d.aiDataClass !== "synthetic" && (
              <Button variant="ghost" size="sm" className="mt-3 -ml-2" onClick={() => setEditingAssistants(true)}>
                <Pencil />
                Ändra assistenter
              </Button>
            )}
          </>
        )}
      </DetailSection>

      <DetailSection title="Delning">
        <div className="flex items-start gap-2.5 text-sm">
          <UsersRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p>
              Ansvarig grupp: <span className="font-medium">{owner?.name ?? "–"}</span>
            </p>
            <p className="mt-2 text-muted-foreground">Synligt för medlemmar i:</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {shared.map((g) => (
                <Badge key={g.id} variant="outline" className="font-normal">
                  {g.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </DetailSection>

      <div className="flex flex-wrap gap-2 border-t p-6">
        <Button variant="outline" onClick={download} disabled={pending}>
          <Download />
          Ladda ned
        </Button>
        {canReview && d.reviewStatus === "approved" && (
          <Button variant="outline" onClick={() => review("archived")} disabled={pending}>
            <Archive />
            Arkivera
          </Button>
        )}
        {canReview && (d.reviewStatus === "archived" || d.reviewStatus === "rejected") && (
          <Button variant="outline" onClick={() => review("pending")} disabled={pending}>
            <RotateCcw />
            Till granskning
          </Button>
        )}
        {canDelete && (
          <Button variant="ghost" className="ml-auto text-destructive" onClick={remove} disabled={pending}>
            <Trash2 />
            Ta bort
          </Button>
        )}
      </div>
    </>
  );
}
