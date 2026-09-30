"use client";

import { Download, Globe, Lock, Pencil, UsersRound } from "lucide-react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { DetailList, DetailSection } from "@/components/common/detail-list";
import { PrototypeNotice } from "@/components/common/prototype-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FILE_TYPE_LABELS } from "@/lib/domain/labels";
import type { Assistant } from "@/lib/domain/types";
import { formatBytes, formatCalendarDate, formatDate } from "@/lib/format";
import type { KnowledgeDocumentView } from "@/server/data/documents";

import { ProcessingBadge, ValidityBadge } from "./document-badges";
import { DocumentIcon } from "./document-icon";
import type { GroupOption } from "./knowledge-view";

export function DocumentSheet({
  document,
  onOpenChange,
  collectionName,
  assistants,
  groups,
}: {
  document: KnowledgeDocumentView | null;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  assistants: Assistant[];
  groups: GroupOption[];
}) {
  return (
    <Sheet open={document !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {document && (
          <DocumentDetails
            document={document}
            collectionName={collectionName}
            assistants={assistants.filter((a) => document.assistantIds.includes(a.id))}
            groups={groups}
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
  groups,
}: {
  document: KnowledgeDocumentView;
  collectionName: string;
  assistants: Assistant[];
  groups: GroupOption[];
}) {
  const prototypeToast = () => toast("Prototyp: funktionen kopplas till backend i nästa etapp.");

  return (
    <>
      <SheetHeader className="gap-3 p-6 pr-12">
        <DocumentIcon type={d.fileType} className="size-10" />
        <div>
          <SheetTitle className="text-lg leading-6 font-semibold">{d.title}</SheetTitle>
          <SheetDescription className="mt-1">{d.fileName}</SheetDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ValidityBadge validity={d.validity} />
          <ProcessingBadge state={d.processing} />
        </div>
      </SheetHeader>

      <DetailSection title="Metadata">
        <DetailList
          items={[
            { label: "Samling", value: collectionName },
            { label: "Filtyp", value: FILE_TYPE_LABELS[d.fileType] },
            { label: "Storlek", value: formatBytes(d.sizeBytes) },
            { label: "Sidor", value: d.pageCount ?? "–" },
            { label: "Uppladdad av", value: d.uploadedByName },
            { label: "Uppladdad", value: formatDate(d.uploadedAt) },
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
          Utgångna dokument används inte som källor. Dokument som går ut inom 30 dagar markeras.
        </p>
      </DetailSection>

      <DetailSection title="Används av">
        <ul className="flex flex-col gap-2">
          {assistants.map((a) => (
            <li key={a.id} className="flex items-center gap-2.5 text-sm">
              <AssistantAvatar assistant={a} size="sm" />
              {a.name}
            </li>
          ))}
        </ul>
      </DetailSection>

      <DetailSection title="Delning">
        <Visibility document={d} groups={groups} />
      </DetailSection>

      <div className="flex flex-col gap-3 border-t p-6">
        <PrototypeNotice>Redigering och nedladdning är inte kopplade ännu.</PrototypeNotice>
        <div className="flex gap-2">
          <Button variant="outline" onClick={prototypeToast}>
            <Pencil />
            Redigera
          </Button>
          <Button variant="outline" onClick={prototypeToast}>
            <Download />
            Ladda ned
          </Button>
        </div>
      </div>
    </>
  );
}

function Visibility({ document: d, groups }: { document: KnowledgeDocumentView; groups: GroupOption[] }) {
  const v = d.visibility;
  if (v.type === "organisation") {
    return (
      <p className="flex items-start gap-2.5 text-sm">
        <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        Alla som har tillgång till någon av assistenterna ovan.
      </p>
    );
  }
  if (v.type === "restricted") {
    return (
      <p className="flex items-start gap-2.5 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        Begränsad – endast uppladdaren och assistentansvariga.
      </p>
    );
  }
  const names = groups.filter((g) => v.groupIds.includes(g.id));
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <UsersRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div>
        <p>Endast medlemmar i:</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {names.map((g) => (
            <Badge key={g.id} variant="outline" className="font-normal">
              {g.name}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
