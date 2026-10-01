"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteConversationsAction, renameConversationAction } from "@/server/chat/actions";

/** Rename one of the user's own conversations. */
export function RenameConversationDialog({
  conversation,
  onOpenChange,
  onRenamed,
}: {
  conversation: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
  onRenamed?: (title: string) => void;
}) {
  return (
    <Dialog open={conversation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {conversation && (
          <RenameForm
            key={conversation.id}
            conversation={conversation}
            onDone={(title) => {
              onRenamed?.(title);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  conversation,
  onDone,
}: {
  conversation: { id: string; title: string };
  onDone: (title: string) => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const result = await renameConversationAction(conversation.id, title).catch(() => ({
        ok: false as const,
        error: "Konversationen kunde inte byta namn.",
      }));
      if (result.ok) {
        toast.success(result.message);
        onDone(title.trim());
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Byt namn på konversationen</DialogTitle>
      </DialogHeader>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
        autoFocus
        aria-label="Namn på konversationen"
      />
      <DialogFooter>
        <Button type="submit" disabled={pending || !title.trim()}>
          Spara
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Confirms and deletes one or more of the user's own conversations. */
export function DeleteConversationsDialog({
  conversationIds,
  onOpenChange,
  onDeleted,
}: {
  conversationIds: string[] | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [pending, start] = useTransition();
  const count = conversationIds?.length ?? 0;

  function confirm() {
    if (!conversationIds?.length) return;
    start(async () => {
      const result = await deleteConversationsAction(conversationIds).catch(() => ({
        ok: false as const,
        error: "Konversationerna kunde inte tas bort.",
      }));
      if (result.ok) {
        toast.success(result.message);
        onOpenChange(false);
        onDeleted?.();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={conversationIds !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{count === 1 ? "Ta bort konversationen?" : `Ta bort ${count} konversationer?`}</DialogTitle>
          <DialogDescription>
            {count === 1 ? "Konversationen och alla dess meddelanden" : "Konversationerna och alla deras meddelanden"} tas
            bort permanent. Det går inte att ångra.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Avbryt
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {pending ? "Tar bort…" : "Ta bort"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
