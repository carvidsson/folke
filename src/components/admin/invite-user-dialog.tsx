"use client";

import { useId, useState } from "react";
import { toast } from "sonner";

import { PrototypeNotice } from "@/components/common/prototype-notice";
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Bjud in användare</DialogTitle>
          <DialogDescription>
            Användaren får en inbjudan via e-post och måste aktivera tvåstegsverifiering vid
            första inloggningen.
          </DialogDescription>
        </DialogHeader>

        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            toast("Prototyp: ingen inbjudan har skickats.");
            onOpenChange(false);
          }}
        >
          <PrototypeNotice>Inga inbjudningar skickas och ingen användare skapas.</PrototypeNotice>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Namn</Label>
              <Input id={`${id}-name`} required className="h-9" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-email`}>E-postadress</Label>
              <Input id={`${id}-email`} type="email" required className="h-9" />
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
                  <Checkbox />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button type="submit" form={`${id}-form`}>
            Skicka inbjudan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
