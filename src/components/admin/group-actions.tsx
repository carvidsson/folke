"use client";

import { MoreHorizontal, Plus, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { UserAvatar } from "@/components/common/user-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { deleteGroupAction, saveGroupAction, setGroupMembersAction } from "@/server/admin/actions";

import { useAdminAction } from "./use-admin-action";

export interface GroupData {
  id: string;
  name: string;
  description: string;
  system: boolean;
  members: { userId: string; isManager: boolean }[];
}

export interface UserOption {
  id: string;
  name: string;
  email: string;
}

export function CreateGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Ny grupp
      </Button>
      <GroupDialog open={open} onOpenChange={setOpen} group={null} />
    </>
  );
}

export function CreateGroupCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-navy-200 text-sm text-muted-foreground transition-colors hover:border-navy-300 hover:bg-surface hover:text-foreground"
      >
        <Plus className="size-5" />
        Skapa grupp
      </button>
      <GroupDialog open={open} onOpenChange={setOpen} group={null} />
    </>
  );
}

export function GroupMenu({ group, users }: { group: GroupData; users: UserOption[] }) {
  const [dialog, setDialog] = useState<"edit" | "members" | "delete" | null>(null);
  const { pending, run } = useAdminAction();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Åtgärder för ${group.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog("members")} disabled={group.system}>
            Hantera medlemmar
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("edit")} disabled={group.system}>
            Redigera grupp
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")} disabled={group.system}>
            Ta bort grupp
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <GroupDialog open={dialog === "edit"} onOpenChange={(o) => setDialog(o ? "edit" : null)} group={group} />
      {dialog === "members" && (
        <MembersDialog group={group} users={users} onClose={() => setDialog(null)} />
      )}
      <Dialog open={dialog === "delete"} onOpenChange={(o) => setDialog(o ? "delete" : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">Ta bort {group.name}?</DialogTitle>
            <DialogDescription>
              Medlemmarna förlorar de assistenter och dokument de fått via gruppen. Grupper som äger
              dokument kan inte tas bort.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Avbryt
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => deleteGroupAction(group.id), () => setDialog(null))}
            >
              Ta bort
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function GroupDialog({
  open,
  onOpenChange,
  group,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupData | null;
}) {
  const id = useId();
  const { pending, run } = useAdminAction();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{group ? "Redigera grupp" : "Ny grupp"}</DialogTitle>
          <DialogDescription>
            Dokument delas som standard inom den grupp som äger dem. Gruppens ansvariga granskar
            dokumenten.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            run(
              () =>
                saveGroupAction(group?.id ?? null, {
                  name: String(form.get("name") ?? ""),
                  description: String(form.get("description") ?? ""),
                }),
              () => onOpenChange(false),
            );
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>Namn</Label>
            <Input id={`${id}-name`} name="name" defaultValue={group?.name} required maxLength={80} className="h-9" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-description`}>Beskrivning</Label>
            <Textarea id={`${id}-description`} name="description" defaultValue={group?.description} maxLength={300} rows={3} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {group ? "Spara" : "Skapa grupp"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({
  group,
  users,
  onClose,
}: {
  group: GroupData;
  users: UserOption[];
  onClose: () => void;
}) {
  const { pending, run } = useAdminAction();
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState(() => new Map(group.members.map((m) => [m.userId, m.isManager])));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)) || a.name.localeCompare(b.name, "sv"));
  }, [users, query, members]);

  const update = (fn: (m: Map<string, boolean>) => void) =>
    setMembers((current) => {
      const next = new Map(current);
      fn(next);
      return next;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Medlemmar i {group.name}</DialogTitle>
          <DialogDescription>
            Gruppansvariga kan granska och godkänna dokument som gruppen äger.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sök användare"
            aria-label="Sök användare"
            className="h-9 pl-8.5"
          />
        </div>
        <ul className="scrollbar-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {visible.map((u) => {
            const isMember = members.has(u.id);
            return (
              <li key={u.id} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
                <Checkbox
                  checked={isMember}
                  aria-label={`Medlem: ${u.name}`}
                  onCheckedChange={(c) => update((m) => (c ? m.set(u.id, false) : m.delete(u.id)))}
                />
                <UserAvatar name={u.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{u.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                </span>
                {isMember && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Ansvarig
                    <Switch
                      checked={members.get(u.id)}
                      onCheckedChange={(c) => update((m) => m.set(u.id, c))}
                      aria-label={`Gruppansvarig: ${u.name}`}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  setGroupMembersAction(
                    group.id,
                    [...members].map(([userId, isManager]) => ({ userId, isManager })),
                  ),
                onClose,
              )
            }
          >
            Spara ({members.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
