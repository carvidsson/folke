"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const prototypeToast = () => toast("Prototyp: grupper kan inte ändras ännu.");

export function CreateGroupButton() {
  return (
    <Button onClick={prototypeToast}>
      <Plus />
      Ny grupp
    </Button>
  );
}

export function CreateGroupCard() {
  return (
    <button
      type="button"
      onClick={prototypeToast}
      className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-navy-200 text-sm text-muted-foreground transition-colors hover:border-navy-300 hover:bg-surface hover:text-foreground"
    >
      <Plus className="size-5" />
      Skapa grupp
    </button>
  );
}

export function GroupMenu({ name, editable }: { name: string; editable: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Åtgärder för ${name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={prototypeToast}>Visa medlemmar</DropdownMenuItem>
        <DropdownMenuItem onSelect={prototypeToast} disabled={!editable}>
          Redigera grupp
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={prototypeToast}>Hantera behörigheter</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={prototypeToast} disabled={!editable}>
          Ta bort grupp
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
