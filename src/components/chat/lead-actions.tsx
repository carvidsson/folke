"use client";

import { Check, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { LeadActionReference } from "@/lib/domain/types";
import { inboxAnalysisStatusAction, startInboxAnalysisAction, syncLeadsAction, type InboxAnalysisState } from "@/server/leads/actions";

import { useChatActions } from "./chat-actions";

type StepState = { status: "idle" | "running" | "done" | "error"; message: string | null };

const POLL_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The steps that fill a gap in the lead material (ADR-050): fetch from HubSpot, then analyse the
 * dialogues. Each step runs only when the user clicks it, through the same Leadanalys actions as the
 * Leadanalys page – they check access, the selection and the cost limits again on the server.
 *
 * The analysis runs as a job on the server (ADR-051): the browser starts it and then only reads its
 * status. Leaving the chat, a reload or a lost connection does not stop it; coming back shows that it is
 * running or done, and a new click never starts a second analysis of the same inbox and period.
 */
export function LeadActions({ action }: { action: LeadActionReference }) {
  const chat = useChatActions();
  const [states, setStates] = useState<StepState[]>(() => action.steps.map(() => ({ status: "idle", message: null })));
  const set = (i: number, s: StepState) => setStates((all) => all.map((x, j) => (j === i ? s : x)));
  const running = states.some((s) => s.status === "running");
  const allDone = states.every((s) => s.status === "done");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const scopeOf = (inboxId: string) => ({ inboxId, preset: "custom", from: action.scope.from, to: action.scope.to });
  /** A job that belongs to these steps: started after they were offered. */
  const ours = (s: InboxAnalysisState | null) => !!s?.job && (!action.createdAt || s.job.startedAt >= action.createdAt);

  async function status(inboxId: string): Promise<InboxAnalysisState | null> {
    const r = await inboxAnalysisStatusAction(scopeOf(inboxId)).catch(() => null);
    return r?.ok ? r.data : null;
  }

  /** Waits until the inbox's job is no longer running – reading the server, never holding a request open. */
  async function follow(i: number, inboxId: string, label: string): Promise<InboxAnalysisState | null> {
    for (let missing = 0; ; ) {
      const s = await status(inboxId);
      if (!alive.current) return null;
      if (s && ours(s) && s.job!.status !== "running") return s;
      // The server answers but has no job of ours: the start never arrived.
      if (s && !ours(s) && ++missing >= 3) return { job: { id: "", status: "failed", startedAt: "", finishedAt: null, error: "Analysen startade inte. Försök igen." }, result: null };
      set(i, { status: "running", message: `${label}${s ? "" : " Folke når inte servern just nu och försöker igen."}` });
      await sleep(POLL_MS);
    }
  }

  // Coming back to the conversation: show what the server knows. Running jobs are followed; nothing new
  // is started without a click.
  useEffect(() => {
    action.steps.forEach((step, i) => {
      if (step.action !== "analyse") return;
      void (async () => {
        const all = await Promise.all(step.inboxIds.map(async (id) => [id, await status(id)] as const));
        if (!alive.current) return;
        const runningIds = all.filter(([, s]) => ours(s) && s!.job!.status === "running").map(([id]) => id);
        const done = all.filter(([, s]) => ours(s) && s!.job!.status === "completed").length;
        if (done === step.inboxIds.length) return set(i, { status: "done", message: "Dialogerna är analyserade." });
        if (!runningIds.length) return;
        for (const id of runningIds) await follow(i, id, "Analysen pågår på servern. Du kan lämna chatten – den fortsätter.");
        const after = await Promise.all(step.inboxIds.map(status));
        if (!alive.current) return;
        const finished = after.filter((s) => ours(s) && s!.job!.status === "completed").length;
        set(i, finished === step.inboxIds.length ? { status: "done", message: "Dialogerna är analyserade." } : { status: "idle", message: `${finished} av ${step.inboxIds.length} inkorgar är analyserade. Klicka för att fortsätta.` });
      })();
    });
    // Once per mounted message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const label = `Analyserar dialogerna${step.inboxIds.length > 1 ? ` (${n + 1} av ${step.inboxIds.length} inkorgar)` : ""} på servern. Du kan lämna chatten – den fortsätter.`;
      set(i, { status: "running", message: "Startar analysen…" });
      const current = await status(inboxId);
      let final: InboxAnalysisState | null;
      if (ours(current) && current!.job!.status === "completed") final = current;
      else if (ours(current) && current!.job!.status === "running") final = await follow(i, inboxId, label);
      else {
        const started = await startInboxAnalysisAction(scopeOf(inboxId)).catch(() => null);
        if (started && !started.ok) {
          set(i, { status: "error", message: started.error });
          return;
        }
        if (started?.ok && started.data.alreadyRunning) set(i, { status: "running", message: "En analys av samma inkorg och period pågår redan – Folke startar ingen ny utan väntar på den." });
        // A lost answer is fine: the job may have started – follow() reads the server.
        final = await follow(i, inboxId, label);
      }
      if (!final) return;
      if (final.job?.status === "failed") {
        set(i, { status: "error", message: final.job.error ?? "Analysen kunde inte genomföras. Försök igen." });
        return;
      }
      analysed += final.result?.run.dialoguesAnalysed ?? 0;
      left += (final.result?.notAnalysed ?? []).filter((x) => x.reason === "limit" || x.reason === "time_limit" || x.reason === "needs_pending").reduce((sum, x) => sum + x.count, 0);
    }
    set(i, {
      status: left ? "idle" : "done",
      message: `${analysed} ${analysed === 1 ? "dialog är analyserad" : "dialoger är analyserade"}.${left ? ` ${left} återstår – klicka igen för att fortsätta.` : ""}`,
    });
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
