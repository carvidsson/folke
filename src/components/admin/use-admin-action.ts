"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import type { ActionResult } from "@/server/admin/actions";

/** Runs a server action with pending state and toast feedback. */
export function useAdminAction() {
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<ActionResult>, onSuccess?: () => void) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          if (result.message) toast.success(result.message);
          onSuccess?.();
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error("Åtgärden kunde inte genomföras. Försök igen.");
      }
    });
  }

  return { pending, run };
}
