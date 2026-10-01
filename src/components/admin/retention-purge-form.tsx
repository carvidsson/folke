"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { purgeConversationsAction } from "@/server/admin/actions";

import { useAdminAction } from "./use-admin-action";

function yearAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function RetentionPurgeForm() {
  const max = yearAgo();
  const [date, setDate] = useState(max);
  const { pending, run } = useAdminAction();

  return (
    <form
      className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!window.confirm(`Ta bort alla konversationer som inte använts sedan ${date}? Det går inte att ångra.`)) return;
        run(() => purgeConversationsAction(date));
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="purge-before">Inaktiva sedan före</Label>
        <Input
          id="purge-before"
          type="date"
          value={date}
          max={max}
          onChange={(e) => setDate(e.target.value)}
          required
          className="h-9 w-48"
        />
      </div>
      <Button type="submit" variant="destructive" disabled={pending || !date || date > max}>
        Gallra konversationer
      </Button>
    </form>
  );
}
