"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LeadAIResult } from "@/lib/leads/types";
import { inboxAnalysisStatusAction, startInboxAnalysisAction, type InboxAnalysisState } from "@/server/leads/actions";

/**
 * The AI analysis of one inbox as the browser sees it (ADR-051). The analysis itself runs on the server
 * as a job; this hook starts it, reads its status from the server and follows it while it runs. Nothing
 * depends on the browser staying open: after a reload, a lost connection or a locked phone the status
 * is read again – the job is running, done or failed. Used by the Leadanalys page and the chat.
 */

export interface InboxAnalysisView {
  status: "unknown" | "idle" | "starting" | "running" | "completed" | "failed";
  /** The stored run when the job is done. */
  result: LeadAIResult | null;
  error: string | null;
  /** The last start joined a job that was already running. */
  alreadyRunning: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** The server could not be reached at the last check (the job is not affected). */
  unreachable: boolean;
}

const POLL_MS = 4000;

type Scope = { inboxId: string; preset: string; from: string; to: string };

function viewOf(state: InboxAnalysisState, previous?: InboxAnalysisView): InboxAnalysisView {
  const job = state.job;
  return {
    status: job ? job.status : "idle",
    result: state.result,
    error: job?.status === "failed" ? job.error : null,
    alreadyRunning: state.alreadyRunning ?? previous?.alreadyRunning ?? false,
    startedAt: job?.startedAt ?? null,
    finishedAt: job?.finishedAt ?? null,
    unreachable: false,
  };
}

export function useInboxAnalysis(
  scope: Scope | null,
  { checkOnMount = true, onCompleted }: { checkOnMount?: boolean; onCompleted?: (result: LeadAIResult) => void } = {},
) {
  const [view, setView] = useState<InboxAnalysisView>({ status: "unknown", result: null, error: null, alreadyRunning: false, startedAt: null, finishedAt: null, unreachable: false });
  const key = scope ? `${scope.inboxId}|${scope.from}|${scope.to}` : null;
  const scopeRef = useRef(scope);
  const onCompletedRef = useRef(onCompleted);
  const statusRef = useRef<InboxAnalysisView["status"]>("unknown");
  useEffect(() => {
    scopeRef.current = scope;
    onCompletedRef.current = onCompleted;
  });

  /** Applies a server state; a job this page followed that is now done is reported once. */
  const apply = useCallback((state: InboxAnalysisState) => {
    const before = statusRef.current;
    const next = state.job ? state.job.status : "idle";
    statusRef.current = next;
    setView((v) => viewOf(state, v));
    if ((before === "running" || before === "starting") && next === "completed" && state.result) onCompletedRef.current?.(state.result);
  }, []);

  const check = useCallback(async () => {
    const s = scopeRef.current;
    if (!s) return;
    const result = await inboxAnalysisStatusAction(s).catch(() => null);
    if (!result) return setView((v) => ({ ...v, unreachable: true }));
    if (!result.ok) return setView((v) => ({ ...v, status: v.status === "unknown" ? "idle" : v.status, unreachable: false }));
    apply(result.data);
  }, [apply]);

  // The status as the server knows it, when the page opens (or the inbox/period changes).
  useEffect(() => {
    if (key && checkOnMount) void check();
  }, [key, checkOnMount, check]);

  // Follow a running job – or a start whose answer was lost; check at once when the user comes back.
  useEffect(() => {
    if (view.status !== "running" && !(view.status === "starting" && view.unreachable)) return;
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [view.status, view.unreachable, check]);

  const start = useCallback(async () => {
    const s = scopeRef.current;
    if (!s) return;
    statusRef.current = "starting";
    setView((v) => ({ ...v, status: "starting", error: null, alreadyRunning: false, unreachable: false }));
    const result = await startInboxAnalysisAction(s).catch(() => null);
    if (result?.ok) {
      setView((v) => ({ ...v, alreadyRunning: result.data.alreadyRunning ?? false }));
      return apply(result.data);
    }
    if (result && !result.ok) {
      statusRef.current = "failed";
      return setView((v) => ({ ...v, status: "failed", error: result.error }));
    }
    // The answer was lost on the way – the job may well have started: ask the server.
    setView((v) => ({ ...v, unreachable: true }));
    await check();
  }, [check, apply]);

  return { view, start, check };
}
