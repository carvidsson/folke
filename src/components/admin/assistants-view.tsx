"use client";

import { FolderOpen, Settings2, User, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { DetailList, DetailSection } from "@/components/common/detail-list";
import { PrototypeNotice } from "@/components/common/prototype-notice";
import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ASSISTANT_STATUS_LABELS } from "@/lib/domain/labels";
import type { Assistant, AssistantStatus, KnowledgeCollection } from "@/lib/domain/types";

export interface AssistantRow {
  assistant: Assistant;
  managerNames: string[];
  collections: KnowledgeCollection[];
  documentCount: number;
  userCount: number;
  grants: (
    | { id: string; kind: "group"; label: string; memberCount: number }
    | { id: string; kind: "user"; label: string }
  )[];
}

const STATUS_TONES: Record<AssistantStatus, StatusTone> = {
  active: "success",
  draft: "neutral",
  paused: "warning",
};

export function AssistantsView({ rows }: { rows: AssistantRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.assistant.id === openId) ?? null;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Assistenter"
        description="Varje assistent har egna instruktioner, kunskapskällor och behörigheter men delar samma tekniska grund."
      />

      <div className="mt-8 flex flex-col gap-3">
        {rows.map((row) => {
          const { assistant: a } = row;
          return (
            <article
              key={a.id}
              className="grid gap-5 rounded-xl border bg-card p-5 shadow-xs lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center"
            >
              <div className="flex items-start gap-4">
                <AssistantAvatar assistant={a} size="lg" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-heading">{a.name}</h2>
                    <StatusBadge tone={STATUS_TONES[a.status]}>
                      {ASSISTANT_STATUS_LABELS[a.status]}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
                </div>
              </div>

              <dl className="grid grid-cols-3 gap-4 text-sm lg:border-l lg:pl-6">
                <div>
                  <dt className="text-caption">Användare</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{row.userCount}</dd>
                </div>
                <div>
                  <dt className="text-caption">Dokument</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{row.documentCount}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-caption">Ansvarig</dt>
                  <dd className="mt-0.5 truncate font-medium">{row.managerNames.join(", ")}</dd>
                </div>
              </dl>

              <Button variant="outline" onClick={() => setOpenId(a.id)} className="justify-self-start">
                <Settings2 />
                Konfigurera
              </Button>
            </article>
          );
        })}
      </div>

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {open && <AssistantConfig row={open} />}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}

function AssistantConfig({ row }: { row: AssistantRow }) {
  const { assistant: a } = row;
  return (
    <>
      <SheetHeader className="flex-row items-center gap-3.5 p-6 pr-12">
        <AssistantAvatar assistant={a} size="lg" />
        <div>
          <SheetTitle className="text-lg font-semibold">{a.name}</SheetTitle>
          <SheetDescription>{a.tagline}</SheetDescription>
        </div>
      </SheetHeader>

      <Tabs defaultValue="instructions" className="gap-0">
        <div className="border-b px-6">
          <TabsList variant="line" className="h-10">
            <TabsTrigger value="instructions">Instruktioner</TabsTrigger>
            <TabsTrigger value="knowledge">Kunskapskällor</TabsTrigger>
            <TabsTrigger value="access">Åtkomst</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="instructions">
          <DetailSection title="Systeminstruktioner" className="border-t-0">
            <Textarea defaultValue={a.instructions} rows={8} className="text-sm leading-6" />
            <p className="text-caption mt-2">
              Instruktionerna lagras och används endast på servern och visas aldrig för
              slutanvändare.
            </p>
          </DetailSection>
          <DetailSection title="Förslag i tom chatt">
            <ul className="flex flex-col gap-1.5 text-sm">
              {a.suggestedPrompts.map((p) => (
                <li key={p} className="rounded-md border bg-surface px-3 py-2">
                  {p}
                </li>
              ))}
            </ul>
          </DetailSection>
          <DetailSection title="AI-modell">
            <DetailList
              items={[
                { label: "Leverantör", value: <StatusBadge tone="neutral">Ej vald</StatusBadge> },
                { label: "Läge", value: "Mockade svar (prototyp)" },
              ]}
            />
          </DetailSection>
        </TabsContent>

        <TabsContent value="knowledge">
          <DetailSection title="Kunskapssamlingar" className="border-t-0">
            <ul className="flex flex-col gap-2">
              {row.collections.map((c) => (
                <li key={c.id} className="flex items-start gap-3 rounded-lg border p-3">
                  <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.description}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-caption mt-3">
              Assistenten söker bara i dokument som både ingår i dessa samlingar och som
              användaren själv har behörighet till.
            </p>
          </DetailSection>
        </TabsContent>

        <TabsContent value="access">
          <DetailSection title="Tilldelad till" className="border-t-0">
            <ul className="divide-y rounded-lg border">
              {row.grants.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  {g.kind === "group" ? (
                    <UsersRound className="size-4 text-muted-foreground" />
                  ) : (
                    <User className="size-4 text-muted-foreground" />
                  )}
                  <span className="flex-1">{g.label}</span>
                  <Badge variant="secondary" className="font-normal">
                    {g.kind === "group" ? `Grupp · ${g.memberCount} medlemmar` : "Individuell"}
                  </Badge>
                </li>
              ))}
            </ul>
          </DetailSection>
          <DetailSection title="Assistentansvariga">
            <p className="text-sm">{row.managerNames.join(", ")}</p>
          </DetailSection>
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-3 border-t p-6">
        <PrototypeNotice>Ändringar i konfigurationen sparas inte i prototypen.</PrototypeNotice>
        <div className="flex gap-2">
          <Button onClick={() => toast("Prototyp: ändringen sparas inte.")}>Spara ändringar</Button>
        </div>
      </div>
    </>
  );
}
