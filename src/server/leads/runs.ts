import "server-only";

import type { AISummary, LeadAIResult, LegacyAISummary } from "@/lib/leads/types";
import { sellerNames, type StoredRun } from "@/server/data/leads";

import { renderLegacySummary, renderSummary } from "./analysis";

/** A stored run as the page shows it (seller ids replaced by current names). No AI call. */
export async function renderStoredRun(run: StoredRun): Promise<LeadAIResult> {
  const summary = run.summary;
  const isCurrent = !!summary && "findings" in summary;
  const names = await sellerNames(summary ? [...new Set(summary.sellerPatterns.map((p) => p.sellerId))] : []);
  return {
    run: {
      id: run.id,
      finishedAt: run.finishedAt,
      from: run.from,
      to: run.to,
      dialoguesAnalysed: run.dialoguesAnalysed,
      analysedNew: run.analysedNew,
      reused: run.reused,
      analysisVersion: run.analysisVersion,
      model: run.model,
      costUsd: run.costUsd,
    },
    counts: (run.counts as LeadAIResult["counts"]) ?? null,
    summary: isCurrent ? renderSummary(summary as AISummary, names) : null,
    legacySummary: summary && !isCurrent ? renderLegacySummary(summary as LegacyAISummary, names) : null,
    notAnalysed: (run.notAnalysed as LeadAIResult["notAnalysed"]) ?? [],
  };
}
