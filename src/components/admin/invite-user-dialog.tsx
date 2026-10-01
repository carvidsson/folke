"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/domain/labels";
import type { Role } from "@/lib/domain/types";
import { inviteUserAction } from "@/server/admin/actions";

export function InviteUserDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: { id: string; name: string }[];
}) {
  const id = useId();
  const [role, setRole] = useState<Role>("employee");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    onOpenChange(false);
    setRole("employee");
    setGroupIds([]);
    setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Bjud in användare</DialogTitle>
          <DialogDescription>
            Användaren får ett e-postmeddelande med en länk för att välja lösenord och aktivera
            tvåstegsverifiering. Kontot blir aktivt efter första inloggningen.
          </DialogDescription>
        </DialogHeader>

        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            startTransition(async () => {
              const result = await inviteUserAction({
                email: String(form.get("email") ?? ""),
                fullName: String(form.get("fullName") ?? ""),
                role,
                groupIds,
              });
              if (result.ok) {
                toast.success(result.message);
                close();
              } else {
                setError(result.error);
              }
            });
          }}
        >
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/6 px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Namn</Label>
              <Input id={`${id}-name`} name="fullName" required minLength={2} maxLength={120} className="h-9" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-email`}>E-postadress</Label>
              <Input id={`${id}-email`} name="email" type="email" required className="h-9" />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-role`}>Roll</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id={`${id}-role`} className="h-9 w-full data-[size=default]:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption">{ROLE_DESCRIPTIONS[role]}</p>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Grupper</legend>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                  <Checkbox
                    checked={groupIds.includes(g.id)}
                    onCheckedChange={(c) =>
                      setGroupIds((ids) => (c ? [...ids, g.id] : ids.filter((x) => x !== g.id)))
                    }
                  />
                  {g.name}
                </label>
              ))}
              {groups.length === 0 && <p className="text-caption">Inga grupper ännu.</p>}
            </div>
          </fieldset>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Avbryt
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? "Skickar…" : "Skicka inbjudan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
