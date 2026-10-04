"use client";

import { MessageSquareText } from "lucide-react";

import type { SellerPattern } from "@/lib/leads/types";

import type { EvidenceRequest } from "./evidence-sheet";
import { number } from "./parts";

/**
 * One seller as coaching material (ADR-049): a few figures, recurring strengths and what to develop,
 * each with avidentified examples to open. Sorted by name by the caller – no ranking, no scores.
 */
export function SellerCoaching({
  name,
  stats,
  pattern,
  onEvidence,
  onAsk,
}: {
  name: string;
  /** Short figures, e.g. ["39 analyserade dialoger", "median 5 min i kontorstid"]. */
  stats: string[];
  pattern: SellerPattern | null;
  onEvidence: (r: EvidenceRequest) => void;
  /** "Fråga Folke" about this seller (ADR-050); absent when the assistant is not available. */
  onAsk?: () => void;
}) {
  const items = pattern ? pattern.strengths.length + pattern.stalls.length : 0;
  return (
    <li className="px-6 py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-muted-foreground tabular-nums">{stats.join(" · ")}</p>
      </div>
      {onAsk && (
        <button
          type="button"
          onClick={onAsk}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <MessageSquareText className="size-3.5" aria-hidden />
          Fråga Folke om {name}
        </button>
      )}
      {pattern && items > 0 && (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Column title="Återkommande styrkor" list={pattern.strengths} seller={name} onEvidence={onEvidence} />
          <Column title="Att utveckla" list={pattern.stalls} seller={name} onEvidence={onEvidence} />
        </div>
      )}
      {pattern && items === 0 && <p className="mt-1 text-xs text-muted-foreground">För litet underlag för återkommande mönster.</p>}
    </li>
  );
}

function Column({
  title,
  list,
  seller,
  onEvidence,
}: {
  title: string;
  list: { text: string; threadIds: string[] }[];
  seller: string;
  onEvidence: (r: EvidenceRequest) => void;
}) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3">
      <p className="text-overline mb-2">{title}</p>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Inget återkommande i underlaget.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {list.map((x, i) => (
            <li key={i} className="text-sm leading-snug">
              {x.text}{" "}
              <button
                type="button"
                className="text-xs font-medium whitespace-nowrap text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => onEvidence({ title: `${seller}: ${title.toLowerCase()}`, description: x.text, origin: "ai", threadIds: x.threadIds })}
              >
                {number.format(x.threadIds.length)} exempel
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
