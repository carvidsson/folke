import "server-only";

import type { LeadActionReference } from "@/lib/domain/types";
import type { LeadIntent } from "@/lib/leads/chat";
import { daysBetween, periodLabel } from "@/lib/leads/periods";
import type { CoverageInfo, LeadRow, Period } from "@/lib/leads/types";
import type { StoredAnalysis } from "@/server/data/leads";

/**
 * Missing lead material in the chat (ADR-050): why it is missing – the period is not fetched from
 * HubSpot, the dialogues are not AI-analysed, or both – and the steps the user can choose, in the
 * right order. Folke never starts a step itself: the steps are buttons that call the Leadanalys
 * actions, which check access, the selection and the cost limits again. Pure.
 */

export interface GapInput {
  selection: string;
  scopeInboxes: { id: string; name: string }[];
  coverage: CoverageInfo;
  rows: LeadRow[];
  /** Null when the question does not need the AI classifications. */
  analyses: Map<string, StoredAnalysis> | null;
  sellerId: string | null;
  intents: LeadIntent[];
  period: Period;
  scope: { regionId: string | null; inboxId: string | null };
  question: string;
  canSync: boolean;
  canAnalyse: boolean;
  maxDays: number;
  /** Stockholm date: today alone not being fetched yet is not a gap worth a step. */
  today: string;
  /** ISO time the steps are offered (stored with them). */
  createdAt?: string;
}

export interface Gaps {
  /** Inboxes whose period is not completely fetched. */
  fetch: string[];
  /** Inboxes with dialogues that need an analysis, and how many. */
  analyse: { inboxIds: string[]; missing: number; eligible: number; analysed: number } | null;
  tooLong: boolean;
  /** The question is only about the AI classifications (patterns, examples, why). */
  analysisOnly: boolean;
  action: LeadActionReference | null;
  /** A deterministic answer when nothing useful can be said without the missing step; else null. */
  answer: string | null;
  /** For the brief: what the buttons under the answer offer. */
  note: string | null;
}

const ANALYSIS_ONLY: LeadIntent[] = ["patterns", "examples", "explain"];

function names(list: string[]) {
  return list.length <= 2 ? list.join(" och ") : `${list.slice(0, -1).join(", ")} och ${list[list.length - 1]}`;
}

export function findGaps(input: GapInput): Gaps {
  const { coverage, rows, analyses, period } = input;
  const nameOf = new Map(input.scopeInboxes.map((i) => [i.id, i.name]));
  const notFetched = coverage.coveredDays === 0 && rows.length === 0;
  // Inboxes missing more than today (a period ending today is incomplete until someone fetches today).
  const allowed = coverage.totalDays - (period.to === input.today ? 1 : 0);
  const fetch = coverage.complete ? [] : coverage.missing.filter((m) => m.coveredDays < allowed).map((m) => m.inboxId).filter((id) => nameOf.has(id));
  const tooLong = daysBetween(period.from, period.to) > input.maxDays;
  const analysisOnly = input.intents.length > 0 && input.intents.every((i) => ANALYSIS_ONLY.includes(i)) && !input.intents.includes("response_time");

  let analyse: Gaps["analyse"] = null;
  if (analyses) {
    const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0 && (!input.sellerId || r.responderId === input.sellerId));
    const missingRows = eligible.filter((r) => !analyses.has(r.threadId));
    if (missingRows.length) {
      analyse = { inboxIds: [...new Set(missingRows.map((r) => r.inboxId))].sort(), missing: missingRows.length, eligible: eligible.length, analysed: eligible.length - missingRows.length };
    }
  }
  // Nothing fetched yet: whether the dialogues need an analysis is only known afterwards.
  const analyseAfterFetch = notFetched && !!analyses && input.canAnalyse;

  const periodText = periodLabel(period.from, period.to);
  const steps: LeadActionReference["steps"] = [];
  if (fetch.length && input.canSync && !tooLong) {
    steps.push({
      action: "sync",
      label: "Uppdatera från HubSpot",
      detail: `Hämtar ${periodText} för ${fetch.length === 1 ? nameOf.get(fetch[0]) : `${fetch.length} inkorgar`}. Folke läser bara från HubSpot.`,
      inboxIds: fetch,
    });
  }
  if (input.canAnalyse && !tooLong && (analyse || analyseAfterFetch)) {
    const inboxIds = analyse ? analyse.inboxIds : input.scopeInboxes.map((i) => i.id);
    steps.push({
      action: "analyse",
      label: "Analysera dialogerna",
      detail: analyse
        ? `${analyse.missing} ${analyse.missing === 1 ? "dialog" : "dialoger"} i ${names(analyse.inboxIds.map((id) => nameOf.get(id) ?? id))} analyseras med AI, med samma regler och kostnadsgränser som i Leadanalys.`
        : `Dialogerna i ${input.selection} analyseras med AI när perioden är hämtad, med samma regler och kostnadsgränser som i Leadanalys.`,
      inboxIds,
    });
  }
  const action: LeadActionReference | null = steps.length
    ? { kind: "lead_action", id: "action", steps, scope: { ...input.scope, preset: "custom", from: period.from, to: period.to }, question: input.question, ...(input.createdAt ? { createdAt: input.createdAt } : {}) }
    : null;

  // --- Deterministic answers: nothing useful can be said without the step -------
  let answer: string | null = null;
  const order = steps.length > 1 ? " Stegen nedan står i den ordning de behöver göras." : "";
  if (notFetched) {
    answer = tooLong
      ? `Perioden ${periodText} är inte hämtad från HubSpot för ${input.selection}, och den är för lång för att hämtas på en gång (högst ${input.maxDays} dagar). Välj en kortare period, till exempel senaste 30 dagarna.`
      : steps.some((s) => s.action === "sync")
        ? `Perioden ${periodText} är inte hämtad från HubSpot för ${input.selection} ännu, så jag har inget underlag att svara utifrån. Vill du hämta den? Det brukar ta någon minut.${steps.some((s) => s.action === "analyse") ? " Därefter kan dialogerna analyseras, så att jag kan titta på styrkor och utvecklingsområden." : ""}${order}`
        : `Perioden ${periodText} är inte hämtad från HubSpot för ${input.selection}, så det finns inget underlag att svara utifrån. Hämtning från HubSpot är inte möjlig här just nu.`;
  } else if (analysisOnly && analyses && analyse && analyse.analysed === 0) {
    const fetchFirst = steps.some((s) => s.action === "sync") ? " Perioden är inte heller hämtad i sin helhet från HubSpot, så den uppdateras först." : "";
    answer = input.canAnalyse
      ? tooLong
        ? `Jag har leadstatistiken för ${periodText} i ${input.selection}, men dialogerna är inte analyserade ännu, och perioden är för lång för en analys (högst ${input.maxDays} dagar). Välj en kortare period, till exempel senaste 30 dagarna.`
        : `Jag har leadstatistiken för ${periodText} i ${input.selection}, men dialogerna är inte analyserade ännu (${analyse.eligible} ${analyse.eligible === 1 ? "dialog" : "dialoger"} med säljarsvar). Vill du analysera dem så att jag kan titta på återkommande styrkor och utvecklingsområden?${fetchFirst}${order}`
      : `Jag har leadstatistiken för ${periodText} i ${input.selection}, men dialogerna är inte analyserade, och AI-analysen av dialogerna är inte aktiverad i den här miljön.`;
  }

  // --- A note for the brief when Folke answers anyway -----------------------------
  const notes: string[] = [];
  if (!answer && steps.some((s) => s.action === "sync")) notes.push(`Perioden är inte hämtad i sin helhet för ${fetch.length === 1 ? nameOf.get(fetch[0]) : `${fetch.length} inkorgar`}; under svaret finns knappen "Uppdatera från HubSpot".`);
  if (!answer && analyse && steps.some((s) => s.action === "analyse")) notes.push(`${analyse.missing} av ${analyse.eligible} dialoger med säljarsvar är inte AI-analyserade; under svaret finns knappen "Analysera dialogerna".`);

  return { fetch, analyse, tooLong, analysisOnly, action, answer, note: notes.length ? notes.join(" ") : null };
}
