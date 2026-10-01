"use client";

import { MoreHorizontal } from "lucide-react";
import { useState } from "react";

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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS } from "@/lib/domain/labels";
import type { Role, User } from "@/lib/domain/types";
import {
  resendInviteAction,
  resetUserMfaAction,
  setUserEnabledAction,
  setUserGroupsAction,
  setUserRoleAction,
} from "@/server/admin/actions";

import { useAdminAction } from "./use-admin-action";

export function UserActions({
  user,
  groupIds,
  groups,
  isSelf,
}: {
  user: User;
  groupIds: string[];
  groups: { id: string; name: string }[];
  isSelf: boolean;
}) {
  const { pending, run } = useAdminAction();
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [selected, setSelected] = useState(groupIds);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Åtgärder för ${user.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              setSelected(groupIds);
              setGroupsOpen(true);
            }}
          >
            Hantera grupper
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={isSelf}>Ändra roll</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="text-overline">Roll</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={user.role}
                onValueChange={(r) => run(() => setUserRoleAction(user.id, r as Role))}
              >
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {user.status === "invited" && (
            <DropdownMenuItem onSelect={() => run(() => resendInviteAction(user.id))}>
              Skicka inbjudan igen
            </DropdownMenuItem>
          )}
          {user.mfaEnrolled && !isSelf && (
            <DropdownMenuItem
              onSelect={() => {
                if (window.confirm(`Återställ tvåstegsverifieringen för ${user.name}? Användaren får registrera en ny vid nästa inloggning.`)) {
                  run(() => resetUserMfaAction(user.id));
                }
              }}
            >
              Återställ tvåstegsverifiering
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant={user.status === "disabled" ? "default" : "destructive"}
            disabled={isSelf}
            onSelect={() => run(() => setUserEnabledAction(user.id, user.status === "disabled"))}
          >
            {user.status === "disabled" ? "Återaktivera konto" : "Inaktivera konto"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">Grupper för {user.name}</DialogTitle>
            <DialogDescription>
              Grupper styr vilka assistenter och dokument användaren får tillgång till.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            {groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm">
                <Checkbox
                  checked={selected.includes(g.id)}
                  onCheckedChange={(c) =>
                    setSelected((ids) => (c ? [...ids, g.id] : ids.filter((x) => x !== g.id)))
                  }
                />
                {g.name}
              </label>
            ))}
            {groups.length === 0 && <p className="text-caption">Inga grupper ännu.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupsOpen(false)}>
              Avbryt
            </Button>
            <Button
              disabled={pending}
              onClick={() => run(() => setUserGroupsAction(user.id, selected), () => setGroupsOpen(false))}
            >
              Spara
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
