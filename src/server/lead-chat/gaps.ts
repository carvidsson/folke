import "server-only";

import type { LeadActionReference } from "@/lib/domain/types";
import type { LeadIntent } from "@/lib/leads/chat";
import { daysBetween, periodLabel } from "@/lib/leads/periods";
import type { CoverageInfo, LeadRow, Period } from "@/lib/leads/types";
import type { StoredAnalysis, StoredNeeds } from "@/server/data/leads";

import { requirements, selectionStatus, type SelectionStatus } from "./status";

/**
 * Missing lead material in the chat (ADR-050): why it is missing – the period is not fetched from
 * HubSpot, or the dialogues lack a current AI analysis – and the NEXT step the user can choose. The
 * status comes from one definition (status.ts). Folke never starts a step itself: the step is a
 * button that calls the Leadanalys actions, which check access, the selection and the cost limits
 * again; when it is done the chat continues towards the user's goal and offers the next step, if
 * any (fetch, then analysis). Pure.
 *
 * Dialogues are analysed per region (ort) or inbox, never for Alla leads (ADR-053): there the chat
 * answers from what is already analysed and points to choosing a region instead of offering a step.
 */

export interface GapInput {
  selection: string;
  scopeInboxes: { id: string; name: string }[];
  coverage: CoverageInfo;
  rows: LeadRow[];
  /** The current stored classifications (load.ts keeps only current ones); null: not read. */
  analyses: Map<string, StoredAnalysis> | null;
  /** lead-needs-1: the current stored needs; null: not read. */
  needs?: Map<string, StoredNeeds> | null;
  sellerId: string | null;
  /** The seller's name as the user sees it (fixed texts only; never sent to the model). */
  sellerName?: string | null;
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
  status: SelectionStatus;
  /** Inboxes whose period is not completely fetched. */
  fetch: string[];
  /** Inboxes with dialogues that need an analysis, and how many. */
  analyse: { inboxIds: string[]; missing: number; eligible: number; analysed: number } | null;
  /** Leads with a customer message that lack the needs analysis (lead-needs-1), and how many. */
  needs: { inboxIds: string[]; missing: number; candidates: number; analysed: number } | null;
  tooLong: boolean;
  /** The question is only about the AI classifications (patterns, examples, why). */
  analysisOnly: boolean;
  /** The next step, or null when nothing is missing (or nothing can be offered). */
  action: LeadActionReference | null;
  /** A deterministic answer when nothing useful can be said without the missing step; else null. */
  answer: string | null;
  /** For the brief: what the button under the answer offers. */
  note: string | null;
}

const ANALYSIS_ONLY: LeadIntent[] = ["patterns", "examples", "explain"];
/** A question about customer needs, possibly narrowed to a source or Virtuell: answered from the needs analysis. */
const NEEDS_ONLY: LeadIntent[] = ["needs", "examples", "explain", "source", "virtual"];

/** "Mia Petterssons", "Lars" → "Lars" (Swedish genitive). */
export function genitive(name: string) {
  return /[sxz]$/i.test(name) ? name : `${name}s`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function names(list: string[]) {
  return list.length <= 2 ? list.join(" och ") : `${list.slice(0, -1).join(", ")} och ${list[list.length - 1]}`;
}

/** The period as the user named it ("senaste 30 dagarna") or as dates. */
function periodName(period: Period) {
  return period.preset === "custom" ? periodLabel(period.from, period.to) : period.label.toLowerCase();
}

/**
 * What a seller's analysis step covers: the seller, the period, how many of the seller's dialogues lack an
 * analysis and in which inboxes – and, honestly, when a whole shared inbox is analysed (ADR-053, V1).
 */
function sellerDetail(seller: string, input: GapInput, inboxIds: string[], nameOf: Map<string, string>, analyse: Gaps["analyse"], needs: Gaps["needs"]): string {
  const count = analyse
    ? analyse.missing === analyse.eligible
      ? plural(analyse.eligible, "dialog", "dialoger")
      : `${analyse.missing} av ${analyse.eligible} dialoger saknar analys`
    : `kundbehov i ${plural(needs!.missing, "lead", "leads")}`;
  const inboxes = names(inboxIds.map((id) => nameOf.get(id) ?? id));
  const others = input.rows.filter((r) => inboxIds.includes(r.inboxId) && r.status === "registered_reply" && r.sellerMessages > 0 && r.responderId !== input.sellerId).length;
  const whole = others > 0 ? ` Hela ${inboxIds.length === 1 ? "inkorgen" : "inkorgarna"} analyseras för perioden, även andra säljares dialoger.` : "";
  return `${seller} · ${periodName(input.period)} · ${count} · ${inboxes}. Aktuella analyser återanvänds.${whole}`;
}

export function findGaps(input: GapInput): Gaps {
  const { rows, period } = input;
  const nameOf = new Map(input.scopeInboxes.map((i) => [i.id, i.name]));
  const status = selectionStatus({
    rows,
    analyses: input.analyses,
    needs: input.needs ?? null,
    sellerId: input.sellerId,
    coverage: input.coverage,
    period,
    today: input.today,
    intents: input.intents,
    inboxIds: input.scopeInboxes.map((i) => i.id),
  });
  const required = requirements(input.intents);
  const notFetched = status.data.notFetched;
  const fetch = status.data.fetchInboxIds;
  const tooLong = daysBetween(period.from, period.to) > input.maxDays;
  const analysisOnly = input.intents.length > 0 && input.intents.every((i) => ANALYSIS_ONLY.includes(i)) && !input.intents.includes("response_time");

  const d = status.dialogues;
  const analyse: Gaps["analyse"] = input.analyses && required.dialogues && d.missing ? { inboxIds: d.missingInboxIds, missing: d.missing, eligible: d.relevant, analysed: d.current } : null;
  const n = status.needs;
  const needsGap: Gaps["needs"] = input.needs && required.needs && n.missing ? { inboxIds: n.missingInboxIds, missing: n.missing, candidates: n.relevant, analysed: n.current } : null;
  const needsOnly = !!input.needs && input.intents.includes("needs") && input.intents.every((i) => NEEDS_ONLY.includes(i));
  // Alla leads: no analysis step – the analysis is made per region (ADR-053). A seller's own dialogues
  // are no combined reading of the business: they can be analysed from any selection (their inboxes only).
  const perRegion = !input.scope.regionId && !input.scope.inboxId;
  const seller = input.sellerId ? (input.sellerName ?? "Säljaren") : null;
  const canAnalyse = input.canAnalyse && (!perRegion || !!seller);
  const who = seller ? `${seller} i ${input.selection}` : input.selection;

  const periodText = periodLabel(period.from, period.to);
  const steps: LeadActionReference["steps"] = [];
  if (fetch.length && input.canSync && !tooLong) {
    // The fetch comes first; whether (and what) needs an analysis is shown when it is done.
    steps.push({
      action: "sync",
      label: "Hämta underlaget",
      detail: `Hämtar ${periodText} för ${fetch.length === 1 ? nameOf.get(fetch[0]) : `${fetch.length} inkorgar`} från HubSpot. Folke läser bara från HubSpot.`,
      inboxIds: fetch,
    });
  } else if (canAnalyse && !tooLong && (analyse || needsGap)) {
    // One job analyses both the dialogues and the customer needs of an inbox (ADR-051, ADR-052).
    const inboxIds = [...new Set([...(analyse?.inboxIds ?? []), ...(needsGap?.inboxIds ?? [])])].sort();
    const label = analyse && !needsOnly ? `Analysera ${plural(analyse.missing, "dialog", "dialoger")}` : `Analysera ${plural(needsGap!.missing, "lead", "leads")}`;
    const what = needsGap && (!analyse || needsOnly) ? `Kundbehoven i ${plural(needsGap.missing, "lead", "leads")}` : `${plural(analyse!.missing, "dialog", "dialoger")}`;
    steps.push({
      action: "analyse",
      label,
      detail: seller
        ? sellerDetail(seller, input, inboxIds, nameOf, analyse, needsOnly ? needsGap : analyse ? null : needsGap)
        : input.scope.inboxId
          ? `${what} i ${names(inboxIds.map((id) => nameOf.get(id) ?? id))} analyseras med AI, med samma regler och kostnadsgränser som i Leadanalys.`
          : `${what} i ${input.selection} analyseras med AI, inkorg för inkorg, med samma regler och kostnadsgränser som i Leadanalys. Aktuella analyser återanvänds.`,
      inboxIds,
    });
  }
  const action: LeadActionReference | null = steps.length
    ? {
        kind: "lead_action",
        id: "action",
        steps,
        // A seller's selection: the analysis covers only the inboxes of the seller's dialogues (ADR-053).
        scope: { ...input.scope, ...(input.sellerId ? { sellerId: input.sellerId } : {}), preset: "custom", from: period.from, to: period.to },
        question: input.question,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      }
    : null;
  const label = steps[0]?.label;

  // --- Deterministic answers: nothing useful can be said without the step -------
  let answer: string | null = null;
  const continues = " När det är klart fortsätter jag med din fråga.";
  if (notFetched) {
    answer = tooLong
      ? `Perioden ${periodText} är inte hämtad från HubSpot för ${input.selection}, och den är för lång för att hämtas på en gång (högst ${input.maxDays} dagar). Välj en kortare period, till exempel senaste 30 dagarna.`
      : steps.some((s) => s.action === "sync")
        ? `Jag behöver först hämta underlaget för ${who}, ${periodText}, från HubSpot – det är inte hämtat ännu. Klicka på "${label}" nedan.${continues}`
        : `Perioden ${periodText} är inte hämtad från HubSpot för ${input.selection}, så det finns inget underlag att svara utifrån. Hämtning från HubSpot är inte möjlig här just nu.`;
  } else if (perRegion && !seller && input.canAnalyse && ((needsOnly && needsGap && needsGap.analysed === 0) || (analysisOnly && analyse && analyse.analysed === 0))) {
    answer = `Analysen av kunddialogerna görs per ort, och inga dialoger i ${input.selection} är analyserade för ${periodText} ännu. Välj en ort – till exempel genom att fråga om den – så kan jag analysera kundernas behov, köpsignaler och hur dialogerna hanteras där.`;
  } else if (needsOnly && needsGap && needsGap.analysed === 0) {
    const fetchFirst = steps.some((s) => s.action === "sync") ? ` Perioden behöver först hämtas från HubSpot – klicka på "${label}" nedan.${continues}` : "";
    answer = input.canAnalyse
      ? tooLong
        ? `Jag har leadstatistiken för ${periodText} i ${input.selection}, men kundbehoven är inte analyserade ännu, och perioden är för lång för en analys (högst ${input.maxDays} dagar). Välj en kortare period, till exempel senaste 30 dagarna.`
        : fetchFirst
          ? `Jag hittade ${plural(needsGap.candidates, "lead", "leads")} med meddelande från kunden för ${who}, ${periodText}, men kundbehoven är inte analyserade ännu.${fetchFirst}`
          : `Jag hittade ${plural(needsGap.candidates, "lead", "leads")} med meddelande från kunden för ${who}, ${periodText}. Kundbehoven är inte analyserade ännu, så de behöver analyseras innan jag kan svara. Klicka på "${label}" nedan – analysen körs på servern.${continues}`
      : `Jag har leadstatistiken för ${periodText} i ${input.selection}, men kundbehoven är inte analyserade, och AI-analysen av dialogerna är inte aktiverad i den här miljön.`;
  } else if (analysisOnly && analyse && analyse.analysed === 0) {
    const fetchFirst = steps.some((s) => s.action === "sync") ? ` Perioden behöver först hämtas från HubSpot – klicka på "${label}" nedan.${continues}` : "";
    const relevant = seller ? `${plural(analyse.eligible, "relevant dialog", "relevanta dialoger")} där ${seller} gav första svaret` : `${plural(analyse.eligible, "relevant dialog", "relevanta dialoger")} med säljarsvar`;
    answer = input.canAnalyse
      ? tooLong
        ? `Jag har leadstatistiken för ${periodText} i ${input.selection}, men dialogerna är inte analyserade ännu, och perioden är för lång för en analys (högst ${input.maxDays} dagar). Välj en kortare period, till exempel senaste 30 dagarna.`
        : fetchFirst
          ? `Jag hittade ${relevant} i ${input.selection}, ${periodText}, men ingen av dem är AI-analyserad ännu.${fetchFirst}`
          : seller
            ? `Jag hittade ${relevant} i ${input.selection}, ${periodText}. Ingen av ${genitive(seller)} dialoger är AI-analyserad ännu, så de behöver analyseras innan jag kan beskriva hur ${seller} kommunicerar med kunderna, vad som fungerar och vad som kan utvecklas. Klicka på "${label}" nedan – analysen körs på servern.${continues}`
            : `Jag hittade ${relevant} i ${input.selection}, ${periodText}. Ingen av dem är AI-analyserad ännu, så de behöver analyseras innan jag kan titta på återkommande styrkor och utvecklingsområden. Klicka på "${label}" nedan – analysen körs på servern.${continues}`
      : `Jag har leadstatistiken för ${periodText} i ${input.selection}, men dialogerna är inte analyserade, och AI-analysen av dialogerna är inte aktiverad i den här miljön.`;
  }

  // --- A note for the brief when Folke answers anyway -----------------------------
  const notes: string[] = [];
  if (!answer && steps.some((s) => s.action === "sync")) notes.push(`Perioden är inte hämtad i sin helhet för ${fetch.length === 1 ? nameOf.get(fetch[0]) : `${fetch.length} inkorgar`}; under svaret finns knappen "${label}".`);
  if (!answer && analyse && steps.some((s) => s.action === "analyse")) notes.push(`${analyse.missing} av ${analyse.eligible} dialoger med säljarsvar saknar aktuell AI-analys; under svaret finns knappen "${label}".`);
  if (!answer && needsGap && steps.some((s) => s.action === "analyse")) notes.push(`Kundbehoven saknar aktuell analys för ${needsGap.missing} av ${needsGap.candidates} leads med meddelande från kunden; under svaret finns knappen "${label}".`);
  if (!answer && perRegion && !seller && (analyse || needsGap)) {
    notes.push(
      `AI-analysen av dialogerna görs per ort, och bara en del av ${input.selection} är analyserad (${analyse ? `${analyse.analysed} av ${analyse.eligible} dialoger med säljarsvar` : `kundbehov för ${needsGap!.analysed} av ${needsGap!.candidates} leads`}). Säg det, beskriv det analyserade underlaget per ort och inkorg i stället för som en samlad bedömning av hela verksamheten, och hänvisa till att välja en ort för en analys av den.`,
    );
  }

  return { status, fetch, analyse, needs: needsGap, tooLong, analysisOnly, action, answer, note: notes.length ? notes.join(" ") : null };
}

/**
 * The fixed text for the next step (asked for, confirmed, or after a step that left more to do): what is
 * missing, with the server's counts, and that Folke goes on with the question when the step is done.
 */
export function nextStepText(
  status: SelectionStatus,
  step: LeadActionReference["steps"][number],
  ctx: { seller: string | null; selection: string; period: Period; afterStep: "fetch" | "analyse" | null },
): string {
  const who = ctx.seller ? `${ctx.seller} i ${ctx.selection}` : ctx.selection;
  const periodText = periodLabel(ctx.period.from, ctx.period.to);
  const goOn = " När det är klart fortsätter jag med din fråga.";
  if (step.action === "sync") return `Jag behöver först hämta underlaget för ${who}, ${periodText}, från HubSpot. Klicka på "${step.label}" nedan – det brukar ta någon minut.${goOn}`;
  const head = ctx.afterStep === "fetch" ? "Underlaget är hämtat. " : ctx.afterStep === "analyse" ? "Analysen blev inte helt klar. " : "";
  const d = status.dialogues;
  const n = status.needs;
  const dialogues = status.requires.dialogues && d.missing > 0;
  const of = ctx.seller ? ` där ${ctx.seller} gav första svaret` : "";
  const found = dialogues
    ? `Jag hittade ${plural(d.relevant, "relevant dialog", "relevanta dialoger")}${of}, ${periodText}. ${d.current ? `${d.current} är redan analyserade och ${d.missing} behöver analyseras.` : "Ingen av dem är analyserad ännu."}`
    : `Jag hittade ${plural(n.relevant, "lead", "leads")} med meddelande från kunden${ctx.seller ? ` för ${ctx.seller}` : ""}, ${periodText}. ${n.current ? `Kundbehoven är analyserade för ${n.current}, och ${n.missing} återstår.` : "Kundbehoven är inte analyserade ännu."}`;
  return `${head}${found} Klicka på "${step.label}" nedan – analysen körs på servern.${goOn}`;
}
