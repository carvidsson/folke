"use client";

import { Progress } from "@/components/ui/progress";

import type { RegionAnalysisView } from "./use-region-analysis";

/**
 * How far the AI analysis of a region (ort) has come (ADR-053): "3 av 5 inkorgar" with a bar, what is
 * happening now and which inboxes could not be analysed. Shared by the Leadanalys page and the chat.
 */
export function RegionProgress({ view }: { view: RegionAnalysisView }) {
  const s = view.state;
  if (view.status === "starting") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Startar analysen av orten…
      </p>
    );
  }
  if (!s || s.total === 0) return null;
  const busy = view.status === "running" || view.status === "summarising";
  const failed = s.inboxes.filter((i) => i.state === "failed");
  const left = s.inboxes.filter((i) => i.state === "pending").length;
  return (
    <div role="status" className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-3">
        <Progress value={(s.done / s.total) * 100} className="h-1.5 max-w-xs" aria-label="Analyserade inkorgar" />
        <span className="shrink-0 tabular-nums">
          {s.done} av {s.total} inkorgar
        </span>
      </div>
      {busy && (
        <p className="text-muted-foreground">
          {view.status === "summarising"
            ? "Inkorgarna är analyserade. Folke sammanställer nu orten. "
            : view.alreadyRunning
              ? "En analys av orten för perioden pågår redan – Folke startar ingen ny, utan visar den här när den är klar. "
              : "Analysen pågår på servern, två inkorgar i taget. "}
          Du kan lämna sidan, byta app eller låsa telefonen – den fortsätter.
          {view.unreachable && " Folke når inte servern just nu och försöker igen."}
        </p>
      )}
      {!busy && left > 0 && s.done > 0 && (
        <p className="text-muted-foreground">
          {left === 1 ? "1 inkorg återstår" : `${left} inkorgar återstår`} – de analyseras när du startar analysen igen. Redan analyserade inkorgar återanvänds.
        </p>
      )}
      {failed.length > 0 && (
        <ul className="text-xs text-destructive">
          {failed.map((i) => (
            <li key={i.id}>
              {i.name}: {i.error ?? "Analysen kunde inte genomföras."}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
