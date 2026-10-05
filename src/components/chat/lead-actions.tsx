"use client";

import { Check, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { LeadActionReference } from "@/lib/domain/types";
import {
  inboxAnalysisStatusAction,
  regionAnalysisStatusAction,
  startInboxAnalysisAction,
  startRegionAnalysisAction,
  syncLeadsAction,
  type InboxAnalysisState,
  type RegionAnalysisState,
} from "@/server/leads/actions";

import { useChatActions } from "./chat-actions";

type StepState = { status: "idle" | "running" | "done" | "error"; message: string | null; progress?: { done: number; total: number } };

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
 *
 * For a region (ort) the step analyses the whole region in one click (ADR-053): the server runs its
 * inboxes that lack a current analysis and then the region's combined analysis; the step shows how many
 * inboxes are done. Alla leads gets no analysis step.
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
  const regionScope = action.scope.regionId && !action.scope.inboxId ? { regionId: action.scope.regionId, preset: "custom", from: action.scope.from, to: action.scope.to } : null;
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
      if (regionScope) {
        void (async () => {
          const r = await regionAnalysisStatusAction(regionScope).catch(() => null);
          if (!alive.current || !r?.ok) return;
          if (r.data.running || r.data.summarising) await followRegion(i, r.data, 0);
        })();
        return;
      }
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

  /** Shows a region's progress until nothing runs any more – reading the server, never holding a request open. */
  async function followRegion(i: number, first: RegionAnalysisState | null, startedAt: number) {
    let s = first;
    for (;;) {
      if (s) {
        const left = s.inboxes.filter((x) => x.state === "pending").length;
        // Just started: the server may not have registered the first inbox yet.
        const settling = !!startedAt && Date.now() - startedAt < 20_000 && left > 0;
        if (!s.running && !s.summarising && !settling) break;
        set(i, {
          status: "running",
          progress: { done: s.done, total: s.total },
          message: s.summarising ? "Dialogerna i alla inkorgar är analyserade. Folke sammanställer nu inkorgarna och orten – strax klart." : "Analysen pågår på servern, två inkorgar i taget. Du kan lämna chatten – den fortsätter.",
        });
      } else set(i, { status: "running", message: "Folke når inte servern just nu och försöker igen." });
      await sleep(POLL_MS);
      if (!alive.current) return;
      const r = await regionAnalysisStatusAction(regionScope!).catch(() => null);
      s = r?.ok ? r.data : null;
    }
    const failed = s.inboxes.filter((x) => x.state === "failed");
    const left = s.total - s.done;
    if (failed.length && !s.done) return set(i, { status: "error", message: failed[0].error ?? "Analysen kunde inte genomföras. Försök igen." });
    set(i, {
      status: left ? "idle" : "done",
      progress: { done: s.done, total: s.total },
      message: left
        ? `${s.done} av ${s.total} inkorgar är analyserade.${failed.length ? ` Det gick inte för ${failed.map((x) => x.name).join(", ")}.` : ""} Klicka igen för att fortsätta – analyserade inkorgar återanvänds.`
        : `Ortens ${s.total === 1 ? "inkorg är analyserad" : `${s.total} inkorgar är analyserade`}.`,
    });
  }

  async function analyseRegion(i: number) {
    set(i, { status: "running", message: "Startar analysen av orten…" });
    const startedAt = Date.now();
    const started = await startRegionAnalysisAction(regionScope!).catch(() => null);
    if (!alive.current) return;
    if (started && !started.ok) return set(i, { status: "error", message: started.error });
    // A lost answer is fine: the analysis may have started – followRegion() reads the server.
    await followRegion(i, started?.ok ? started.data : null, startedAt);
  }

  async function analyse(i: number) {
    if (regionScope) return analyseRegion(i);
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
                {state.progress && state.progress.total > 0 && (
                  <div className="mt-1.5 flex items-center gap-2 text-xs">
                    <Progress value={(state.progress.done / state.progress.total) * 100} className="h-1.5 max-w-48" aria-label="Analyserade inkorgar" />
                    <span className="tabular-nums">
                      {state.progress.done} av {state.progress.total} inkorgar
                    </span>
                  </div>
                )}
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
