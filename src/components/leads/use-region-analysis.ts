"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { regionAnalysisStatusAction, startRegionAnalysisAction, type RegionAnalysisState } from "@/server/leads/actions";

/**
 * The AI analysis of a region (ort) as the browser sees it (ADR-053). The server runs the region's inboxes
 * as inbox jobs and then writes the region's combined analysis; this hook starts it, reads the progress
 * from the server and follows it while it runs. Nothing depends on the browser staying open: after a
 * reload, a lost connection or a locked phone the progress is read again. Used by the Leadanalys page
 * and the chat.
 */

export interface RegionAnalysisView {
  status: "unknown" | "idle" | "starting" | "running" | "summarising";
  state: RegionAnalysisState | null;
  error: string | null;
  /** The last start joined an analysis that was already running. */
  alreadyRunning: boolean;
  /** The server could not be reached at the last check (the analysis is not affected). */
  unreachable: boolean;
}

const POLL_MS = 4000;

type Scope = { regionId: string; preset: string; from: string; to: string };

/** Right after a start the server may not have registered the first inbox yet: inboxes still waiting then count as running. */
const SETTLING_MS = 20_000;

function statusOf(s: RegionAnalysisState, startedAt: number): RegionAnalysisView["status"] {
  if (s.running) return "running";
  if (s.summarising) return "summarising";
  return Date.now() - startedAt < SETTLING_MS && s.inboxes.some((i) => i.state === "pending") ? "running" : "idle";
}

export function useRegionAnalysis(
  scope: Scope | null,
  { checkOnMount = true, onCompleted }: { checkOnMount?: boolean; onCompleted?: (state: RegionAnalysisState) => void } = {},
) {
  const [view, setView] = useState<RegionAnalysisView>({ status: "unknown", state: null, error: null, alreadyRunning: false, unreachable: false });
  const key = scope ? `${scope.regionId}|${scope.from}|${scope.to}` : null;
  const scopeRef = useRef(scope);
  const onCompletedRef = useRef(onCompleted);
  const statusRef = useRef<RegionAnalysisView["status"]>("unknown");
  const startedRef = useRef(0);
  useEffect(() => {
    scopeRef.current = scope;
    onCompletedRef.current = onCompleted;
  });

  /** Applies the server's progress; an analysis this page followed that is now done is reported once. */
  const apply = useCallback((state: RegionAnalysisState, alreadyRunning?: boolean) => {
    const before = statusRef.current;
    const next = statusOf(state, startedRef.current);
    statusRef.current = next;
    setView((v) => ({ ...v, status: next, state, unreachable: false, alreadyRunning: alreadyRunning ?? v.alreadyRunning }));
    if ((before === "running" || before === "summarising" || before === "starting") && next === "idle") onCompletedRef.current?.(state);
  }, []);

  const check = useCallback(async () => {
    const s = scopeRef.current;
    if (!s) return;
    const result = await regionAnalysisStatusAction(s).catch(() => null);
    if (!result) return setView((v) => ({ ...v, unreachable: true }));
    if (!result.ok) return setView((v) => ({ ...v, status: v.status === "unknown" ? "idle" : v.status, unreachable: false }));
    apply(result.data);
  }, [apply]);

  // The progress as the server knows it, when the page opens (or the region/period changes).
  useEffect(() => {
    if (key && checkOnMount) void check();
  }, [key, checkOnMount, check]);

  // Follow a running analysis – or a start whose answer was lost; check at once when the user comes back.
  const following = view.status === "running" || view.status === "summarising" || (view.status === "starting" && view.unreachable);
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [following, check]);

  const start = useCallback(async () => {
    const s = scopeRef.current;
    if (!s) return;
    statusRef.current = "starting";
    startedRef.current = Date.now();
    setView((v) => ({ ...v, status: "starting", error: null, alreadyRunning: false, unreachable: false }));
    const result = await startRegionAnalysisAction(s).catch(() => null);
    if (result?.ok) return apply(result.data, result.data.alreadyRunning ?? false);
    if (result && !result.ok) {
      statusRef.current = "idle";
      return setView((v) => ({ ...v, status: "idle", error: result.error }));
    }
    // The answer was lost on the way – the analysis may well have started: ask the server.
    setView((v) => ({ ...v, unreachable: true }));
    await check();
  }, [check, apply]);

  return { view, start, check };
}
