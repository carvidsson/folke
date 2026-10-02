"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import {
  listConversationAttachmentsAction,
  removeAttachmentAction,
  type ConversationAttachment,
} from "@/server/attachments/actions";

import { AttachmentChip } from "./attachment-chip";

/** The conversation's attachments, with removal (ADR-045). */
export function ConversationAttachmentsDialog({
  conversationId,
  open,
  onOpenChange,
  onChanged,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ConversationAttachment[] | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let active = true;
    void listConversationAttachmentsAction(conversationId).then((list) => active && setItems(list));
    return () => {
      active = false;
    };
  }, [open, conversationId]);

  function remove(item: ConversationAttachment) {
    startTransition(async () => {
      const result = await removeAttachmentAction(item.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setItems((all) => (all ?? []).filter((a) => a.id !== item.id));
      toast.success(result.message);
      onChanged();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bilagor i konversationen</DialogTitle>
          <DialogDescription>
            Bilagorna används bara i den här konversationen och syns inte för någon annan. En borttagen bilaga används inte
            längre i svaren, men tidigare svar finns kvar.
          </DialogDescription>
        </DialogHeader>
        {items === null ? (
          <p className="text-sm text-muted-foreground">Hämtar bilagor…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Konversationen har inga bilagor.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <AttachmentChip
                  className="min-w-0 flex-1"
                  attachment={a}
                  status={a.status === "ready" ? undefined : a.status}
                  thumbnailUrl={a.kind === "image" && a.status === "ready" ? `/api/attachments/${a.id}` : undefined}
                  onOpen={a.status === "ready" ? () => window.open(`/api/attachments/${a.id}`, "_blank", "noopener") : undefined}
                />
                <span className="text-caption hidden w-16 text-right sm:block">{formatBytes(a.sizeBytes)}</span>
                <Button variant="ghost" size="icon" disabled={pending} onClick={() => remove(a)} aria-label={`Ta bort ${a.name}`}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
