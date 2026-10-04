"use client";

import { Check, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { LeadActionReference } from "@/lib/domain/types";
import { analyseInboxAction, syncLeadsAction } from "@/server/leads/actions";

import { useChatActions } from "./chat-actions";

type StepState = { status: "idle" | "running" | "done" | "error"; message: string | null };

/**
 * The steps that fill a gap in the lead material (ADR-050): fetch from HubSpot, then analyse the
 * dialogues. Each step runs only when the user clicks it, through the same Leadanalys actions as the
 * Leadanalys page – they check access, the selection and the cost limits again on the server. The chat
 * stays usable while a step runs; when all are done the question can be asked again in the same
 * conversation.
 */
export function LeadActions({ action }: { action: LeadActionReference }) {
  const chat = useChatActions();
  const [states, setStates] = useState<StepState[]>(() => action.steps.map(() => ({ status: "idle", message: null })));
  const set = (i: number, s: StepState) => setStates((all) => all.map((x, j) => (j === i ? s : x)));
  const running = states.some((s) => s.status === "running");
  const allDone = states.every((s) => s.status === "done");

  async function sync(i: number) {
    const step = action.steps[i];
    let remaining: string[] | undefined = step.inboxIds;
    let done = 0;
    set(i, { status: "running", message: `Hämtar från HubSpot: 0 av ${step.inboxIds.length} inkorgar…` });
    for (let round = 0; round < 30 && remaining?.length; round++) {
      const result: Awaited<ReturnType<typeof syncLeadsAction>> | null = await syncLeadsAction(action.scope, remaining).catch(() => null);
      if (!result?.ok) {
        set(i, { status: "error", message: result && !result.ok ? result.error : "Hämtningen avbröts. Försök igen." });
        return;
      }
      done += result.data.done.length;
      remaining = result.data.remaining;
      set(i, { status: "running", message: `Hämtar från HubSpot: ${done} av ${step.inboxIds.length} inkorgar…` });
    }
    set(i, { status: "done", message: `Perioden är hämtad för ${done} ${done === 1 ? "inkorg" : "inkorgar"}.` });
  }

  async function analyse(i: number) {
    const step = action.steps[i];
    let analysed = 0;
    let left = 0;
    for (const [n, inboxId] of step.inboxIds.entries()) {
      set(i, { status: "running", message: `Analyserar dialogerna${step.inboxIds.length > 1 ? ` (${n + 1} av ${step.inboxIds.length} inkorgar)` : ""}… Det kan ta ett par minuter. Du kan fortsätta chatta under tiden.` });
      const result = await analyseInboxAction({ inboxId, preset: "custom", from: action.scope.from, to: action.scope.to }).catch(() => null);
      if (!result?.ok) {
        set(i, { status: "error", message: result && !result.ok ? result.error : "Analysen kunde inte genomföras. Försök igen." });
        return;
      }
      analysed += result.data.run.dialoguesAnalysed;
      left += result.data.notAnalysed.filter((x) => x.reason === "limit" || x.reason === "time_limit").reduce((sum, x) => sum + x.count, 0);
    }
    set(i, {
      status: "done",
      message: `${analysed} ${analysed === 1 ? "dialog är analyserad" : "dialoger är analyserade"}.${left ? ` ${left} återstår – klicka igen för att fortsätta.` : ""}`,
    });
    if (left) setStates((all) => all.map((x, j) => (j === i ? { ...x, status: "idle" } : x)));
  }

  return (
    <div className="rounded-lg border bg-surface px-3.5 py-3">
      <ol className="flex flex-col gap-3">
        {action.steps.map((step, i) => {
          const state = states[i];
          const blocked = action.steps.slice(0, i).some((_, j) => states[j].status !== "done");
          return (
            <li key={`${step.action}-${i}`} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {action.steps.length > 1 && `${i + 1}. `}
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground">{step.detail}</p>
                {state.message && (
                  <p role="status" className={state.status === "error" ? "mt-1 text-xs text-destructive" : "mt-1 text-xs text-muted-foreground"}>
                    {state.message}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={i === 0 || !blocked ? "default" : "outline"}
                className="shrink-0"
                disabled={running || blocked || state.status === "done"}
                onClick={() => void (step.action === "sync" ? sync(i) : analyse(i))}
              >
                {state.status === "running" ? <Loader2 className="size-4 animate-spin" /> : state.status === "done" ? <Check className="size-4" /> : null}
                {state.status === "done" ? "Klart" : step.label}
              </Button>
            </li>
          );
        })}
      </ol>
      {allDone && chat && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground">Underlaget är uppdaterat.</span>
          <Button size="sm" variant="outline" disabled={chat.busy} onClick={() => chat.ask(action.question)}>
            <RefreshCw className="size-4" />
            Ställ frågan igen
          </Button>
        </div>
      )}
    </div>
  );
}
