"use client";

import { MessagesSquare, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { EmptyState } from "@/components/common/empty-state";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Assistant, ConversationSummary } from "@/lib/domain/types";
import { formatShortDate } from "@/lib/format";

import { DeleteConversationsDialog, RenameConversationDialog } from "./conversation-dialogs";

/** All of the user's own conversations: rename, select and delete. */
export function ConversationHistory({
  conversations,
  assistants,
}: {
  conversations: ConversationSummary[];
  assistants: Assistant[];
}) {
  const router = useRouter();
  const byId = new Map(assistants.map((a) => [a.id, a]));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);

  const visibleIds = conversations.map((c) => c.id);
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedIds.length === visibleIds.length;

  function toggle(id: string, checked: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Konversationer"
        description="Dina egna konversationer. Ingen annan, inte heller administratörer, kan läsa eller ändra dem."
        actions={
          <Button variant="destructive" disabled={selectedIds.length === 0} onClick={() => setDeleting(selectedIds)}>
            <Trash2 />
            {selectedIds.length ? `Ta bort valda (${selectedIds.length})` : "Ta bort valda"}
          </Button>
        }
      />

      <Panel className="mt-6">
        {conversations.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="Inga konversationer" description="Starta en ny chatt för att komma igång." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected ? true : selectedIds.length ? "indeterminate" : false}
                    onCheckedChange={(checked) => setSelected(checked ? new Set(visibleIds) : new Set())}
                    aria-label="Markera alla"
                  />
                </TableHead>
                <TableHead>Konversation</TableHead>
                <TableHead className="hidden sm:table-cell">Senast aktiv</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Åtgärder</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations.map((c) => {
                const assistant = byId.get(c.assistantId);
                return (
                  <TableRow key={c.id} data-state={selected.has(c.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(checked) => toggle(c.id, checked === true)}
                        aria-label={`Markera ${c.title}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/chat/${c.id}`} className="flex min-w-0 items-center gap-2.5 font-medium hover:underline">
                        {assistant && <AssistantAvatar assistant={assistant} size="sm" />}
                        <span className="truncate">{c.title}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {formatShortDate(c.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Byt namn på ${c.title}`}
                        onClick={() => setRenaming({ id: c.id, title: c.title })}
                      >
                        <Pencil />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      <RenameConversationDialog
        conversation={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
        onRenamed={() => router.refresh()}
      />
      <DeleteConversationsDialog
        conversationIds={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => {
          setSelected(new Set());
          router.refresh();
        }}
      />
    </PageContainer>
  );
}
