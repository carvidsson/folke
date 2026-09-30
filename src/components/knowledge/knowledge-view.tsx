"use client";

import { SearchX, Upload } from "lucide-react";
import { useMemo, useState } from "react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { EmptyState } from "@/components/common/empty-state";
import {
  ALL,
  ClearFiltersButton,
  FilterBar,
  FilterSelect,
  ResultCount,
  SearchInput,
} from "@/components/common/filters";
import { Panel, StatTile } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VALIDITY_LABELS, visibilityLabel } from "@/lib/domain/labels";
import type {
  Assistant,
  DocumentValidity,
  KnowledgeCollection,
  UserGroup,
} from "@/lib/domain/types";
import { formatCalendarDate, formatShortDate } from "@/lib/format";
import type { KnowledgeDocumentView } from "@/server/data/documents";

import { ProcessingBadge, ValidityBadge } from "./document-badges";
import { DocumentIcon } from "./document-icon";
import { DocumentSheet } from "./document-sheet";
import { UploadDialog } from "./upload-dialog";

export type GroupOption = Pick<UserGroup, "id" | "name">;

export function KnowledgeView({
  documents,
  collections,
  assistants,
  groups,
  canUpload,
  initialDocumentId,
}: {
  documents: KnowledgeDocumentView[];
  collections: KnowledgeCollection[];
  assistants: Assistant[];
  groups: GroupOption[];
  canUpload: boolean;
  initialDocumentId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState(ALL);
  const [assistant, setAssistant] = useState(ALL);
  const [validity, setValidity] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(initialDocumentId);
  const [uploadOpen, setUploadOpen] = useState(false);

  const collectionName = useMemo(
    () => new Map(collections.map((c) => [c.id, c.name])),
    [collections],
  );
  const assistantById = useMemo(() => new Map(assistants.map((a) => [a.id, a])), [assistants]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents.filter(
      (d) =>
        (collection === ALL || d.collectionId === collection) &&
        (assistant === ALL || d.assistantIds.includes(assistant)) &&
        (validity === ALL || d.validity === validity) &&
        (!q ||
          d.title.toLowerCase().includes(q) ||
          d.fileName.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q))),
    );
  }, [documents, query, collection, assistant, validity]);

  const counts = useMemo(() => {
    const by = (v: DocumentValidity) => documents.filter((d) => d.validity === v).length;
    return {
      expiring: by("expiring"),
      expired: by("expired"),
      processing: documents.filter((d) => d.processing !== "ready").length,
    };
  }, [documents]);

  const hasFilters = query !== "" || collection !== ALL || assistant !== ALL || validity !== ALL;
  const clearFilters = () => {
    setQuery("");
    setCollection(ALL);
    setAssistant(ALL);
    setValidity(ALL);
  };
  const toggleValidity = (v: DocumentValidity) => setValidity((cur) => (cur === v ? ALL : v));

  const openDocument = documents.find((d) => d.id === openId) ?? null;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Kunskapsbank"
        description="Dokument som assistenterna använder som källor. Behörighet till dokument styrs separat från behörighet till assistenter."
        actions={
          canUpload && (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload />
              Ladda upp dokument
            </Button>
          )
        }
      />

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Dokument totalt" value={documents.length} />
        <StatTile
          label="Går snart ut"
          value={counts.expiring}
          active={validity === "expiring"}
          onClick={() => toggleValidity("expiring")}
        />
        <StatTile
          label="Utgångna"
          value={counts.expired}
          active={validity === "expired"}
          onClick={() => toggleValidity("expired")}
        />
        <StatTile label="Under bearbetning eller fel" value={counts.processing} />
      </div>

      <FilterBar className="mt-6">
        <SearchInput value={query} onChange={setQuery} placeholder="Sök titel, filnamn eller tagg" />
        <FilterSelect
          label="Samling"
          value={collection}
          onChange={setCollection}
          allLabel="Alla samlingar"
          options={collections.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          label="Assistent"
          value={assistant}
          onChange={setAssistant}
          allLabel="Alla assistenter"
          options={assistants.map((a) => ({ value: a.id, label: a.name }))}
        />
        <FilterSelect
          label="Giltighet"
          value={validity}
          onChange={setValidity}
          allLabel="Alla statusar"
          options={Object.entries(VALIDITY_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ClearFiltersButton visible={hasFilters} onClick={clearFilters} />
        <ResultCount shown={filtered.length} total={documents.length} noun="dokument" />
      </FilterBar>

      <Panel className="mt-4">
        {filtered.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="Inga dokument matchar"
            description="Prova en annan sökning eller rensa filtren."
            action={
              <Button variant="outline" onClick={clearFilters}>
                Rensa filter
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Dokument</TableHead>
                <TableHead className="hidden md:table-cell">Samling</TableHead>
                <TableHead className="hidden lg:table-cell">Assistenter</TableHead>
                <TableHead>Giltighet</TableHead>
                <TableHead className="hidden xl:table-cell">Delning</TableHead>
                <TableHead className="hidden sm:table-cell">Uppladdad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((d) => (
                <TableRow
                  key={d.id}
                  className="cursor-pointer"
                  onClick={() => setOpenId(d.id)}
                >
                  <TableCell className="max-w-0 w-full min-w-64">
                    <div className="flex items-center gap-3">
                      <DocumentIcon type={d.fileType} />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId(d.id);
                          }}
                          className="block max-w-full truncate text-left font-medium outline-none hover:underline focus-visible:underline"
                        >
                          {d.title}
                        </button>
                        <p className="truncate text-xs text-muted-foreground">{d.fileName}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {collectionName.get(d.collectionId)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex -space-x-1">
                      {d.assistantIds.map((id) => {
                        const a = assistantById.get(id);
                        return (
                          a && (
                            <Tooltip key={id}>
                              <TooltipTrigger asChild>
                                <span>
                                  <AssistantAvatar assistant={a} size="sm" className="ring-2 ring-card" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{a.name}</TooltipContent>
                            </Tooltip>
                          )
                        );
                      })}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {d.processing === "ready" ? (
                        <ValidityBadge validity={d.validity} />
                      ) : (
                        <ProcessingBadge state={d.processing} />
                      )}
                      <span className="text-xs text-muted-foreground">
                        {d.validUntil
                          ? `t.o.m. ${formatCalendarDate(d.validUntil)}`
                          : "Tillsvidare"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground xl:table-cell">
                    {visibilityLabel(d.visibility)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatShortDate(d.uploadedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <DocumentSheet
        document={openDocument}
        onOpenChange={(open) => !open && setOpenId(null)}
        collectionName={openDocument ? collectionName.get(openDocument.collectionId) ?? "" : ""}
        assistants={assistants}
        groups={groups}
      />
      {canUpload && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          collections={collections}
          assistants={assistants}
          groups={groups}
        />
      )}
    </PageContainer>
  );
}
