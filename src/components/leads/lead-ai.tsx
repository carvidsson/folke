"use client";

import { AlertTriangle, History, RefreshCw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Panel } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { periodLabel } from "@/lib/leads/periods";
import {
  BEHAVIOURS,
  type AICounts,
  type Intent,
  type LeadAIResult,
  type Progress,
  type PurchaseIntent,
  type RunSummaryInfo,
} from "@/lib/leads/types";
import {
  openRunAction,
  summariseScopeAction,
} from "@/server/leads/actions";

import type { EvidenceRequest } from "./evidence-sheet";
import { SellerCoaching } from "./seller-coaching";
import { useInboxAnalysis } from "./use-inbox-analysis";
import {
  Bars,
  BehaviourRow,
  formatDateTime,
  INTENT_LABELS,
  MODEL_LABELS,
  NOT_ANALYSED,
  number,
  ofTotal,
  PROGRESS_LABELS,
  PURCHASE_INTENT_LABELS,
  Section,
} from "./parts";

export interface AIStateView {
  current: LeadAIResult | null;
  runs: (RunSummaryInfo & { current: boolean })[];
  eligible: number;
  upToDate: number;
  counts: AICounts | null;
  needs: { candidates: number; current: number };
}

/**
 * The AI layer of the lead analysis (ADR-048). A stored analysis opens
 * directly from Folke. "Uppdatera" only sends changed dialogues to the model
 * (versioned, fingerprinted). Results from other analysis versions open as
 * they were and are never compared with the current method.
 */
export function LeadAI({
  scope,
  scopeType,
  analysisVersion,
  state,
  enabled,
  canSummariseAll,
  onEvidence,
}: {
  scope: Record<string, string | null | undefined>;
  scopeType: "all" | "region" | "inbox";
  analysisVersion: string;
  state: AIStateView;
  enabled: boolean;
  canSummariseAll: boolean;
  onEvidence: (r: EvidenceRequest) => void;
}) {
  const [shown, setShown] = useState<LeadAIResult | null>(state.current);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [openingRun, setOpeningRun] = useState<string | null>(null);
  // True only when the user opened an earlier run; a run made just now is the latest.
  const [viewingEarlier, setViewingEarlier] = useState(false);
  const router = useRouter();
  const historical = Boolean(shown) && viewingEarlier;
  // The inbox analysis runs as a job on the server (ADR-051): its status survives reloads and leaving the page.
  const analysis = useInboxAnalysis(
    scopeType === "inbox" && scope.inboxId && scope.from && scope.to ? { inboxId: scope.inboxId, preset: "custom", from: scope.from, to: scope.to } : null,
    {
      // A job that finishes while the page is open: show its result and refresh the figures.
      onCompleted: (result) => {
        setShown(result);
        setViewingEarlier(false);
        router.refresh();
      },
    },
  );
  const job = analysis.view;
  const jobBusy = job.status === "starting" || job.status === "running";
  const outdated = state.eligible - state.upToDate;
  const needsOutdated = state.needs.candidates - state.needs.current;

  function run() {
    setError(null);
    if (scopeType === "inbox") {
      void analysis.start();
      return;
    }
    start(async () => {
      const result = await summariseScopeAction(scope).catch(() => null);
      if (result?.ok) {
        setShown(result.data);
        setViewingEarlier(false);
        // Key figures, insights and the list of earlier runs are rendered on the server.
        router.refresh();
      } else
        setError(
          result && !result.ok
            ? result.error
            : "AI-analysen kunde inte genomföras. Försök igen.",
        );
    });
  }

  function open(id: string) {
    setError(null);
    setOpeningRun(id);
    start(async () => {
      const result = await openRunAction(id).catch(() => null);
      setOpeningRun(null);
      if (result?.ok) {
        setShown(result.data);
        setViewingEarlier(result.data.run.id !== state.current?.run.id);
      } else setError("Analysen kunde inte öppnas.");
    });
  }

  const actionLabel =
    scopeType === "inbox"
      ? shown || state.upToDate
        ? "Uppdatera analys"
        : "Analysera dialogerna"
      : shown
        ? "Gör ny sammanvägning"
        : "Gör sammanvägning";
  const allowed = enabled && (scopeType !== "all" || canSummariseAll);

  return (
    <Section
      title="AI-analys av dialogerna"
      origin="classification"
      id="ai"
      description={
        scopeType === "inbox"
          ? "Dialoger med registrerat säljsvar avidentifieras innan de skickas till OpenAI. AI förstår först vad kunden ville och bedömer sedan om säljaren förde affären framåt. Sparade analyser återanvänds; bara ändrade dialoger skickas igen."
          : "Sammanvägningen bygger på de AI-analyser som redan finns sparade för inkorgarna i urvalet – inga dialoger skickas på nytt. Analysera inkorgarna först för en fullständig bild."
      }
    >
      <Panel className="px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="text-sm">
            {shown ? (
              <>
                <p>
                  <span className="font-medium">
                    {historical ? "Tidigare analys" : "Senast analyserad"}{" "}
                    {formatDateTime(shown.run.finishedAt)}
                  </span>{" "}
                  · {number.format(shown.run.dialoguesAnalysed)} dialoger ·{" "}
                  {shown.run.analysisVersion} ·{" "}
                  {MODEL_LABELS[shown.run.model] ?? shown.run.model}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Period {periodLabel(shown.run.from, shown.run.to)}.
                  {scopeType === "inbox" &&
                    ` ${number.format(shown.run.analysedNew)} nya och ${number.format(shown.run.reused)} återanvända analyser.`}{" "}
                  Kostnad ca{" "}
                  {shown.run.costUsd.toLocaleString("sv-SE", {
                    maximumFractionDigits: 3,
                  })}{" "}
                  USD.
                  {shown.notAnalysed.length > 0 && (
                    <>
                      {" "}
                      Inte analyserade:{" "}
                      {shown.notAnalysed
                        .map(
                          (x) =>
                            `${number.format(x.count)} ${NOT_ANALYSED[x.reason]}`,
                        )
                        .join(", ")}
                      .
                    </>
                  )}
                </p>
                {historical && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Du ser en tidigare analys.{" "}
                    {shown.run.analysisVersion !== analysisVersion &&
                      "Den gjordes med en tidigare analysmetod och ska inte jämföras med dagens resultat. "}
                    {state.current && (
                      <button
                        type="button"
                        className="font-medium text-foreground underline underline-offset-4"
                        onClick={() => {
                          setShown(state.current);
                          setViewingEarlier(false);
                        }}
                      >
                        Visa senaste
                      </button>
                    )}
                  </p>
                )}
              </>
            ) : (
              <p>
                {scopeType === "inbox"
                  ? `${number.format(state.eligible)} dialoger med registrerat säljsvar i perioden. Ingen sparad analys för perioden med nuvarande analysmetod.`
                  : `AI-analys finns sparad för ${ofTotal(state.upToDate, state.eligible)} dialoger med registrerat säljsvar i urvalet. Ingen sammanvägning för perioden ännu.`}
              </p>
            )}
            {!historical && scopeType === "inbox" && state.eligible > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {outdated === 0
                  ? "Alla dialoger i perioden har en aktuell analys."
                  : `${ofTotal(outdated, state.eligible, { percentage: false })} dialoger har ändrats eller saknar analys sedan dess – de analyseras vid uppdatering.`}
              </p>
            )}
            {!historical && scopeType === "inbox" && state.needs.candidates > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {needsOutdated === 0
                  ? "Kundbehoven är analyserade för alla leads med meddelande från kunden."
                  : `Kundbehoven saknas eller har ändrats för ${ofTotal(needsOutdated, state.needs.candidates, { percentage: false })} leads med meddelande från kunden – de analyseras i samma körning.`}
              </p>
            )}
          </div>
          {allowed && (
            <Button
              onClick={run}
              disabled={pending || jobBusy}
              className="shrink-0"
              variant={shown && outdated === 0 && needsOutdated === 0 ? "outline" : "default"}
            >
              {shown ? <RefreshCw /> : <Sparkles />}
              {(pending && !openingRun) || jobBusy ? "Analyserar…" : actionLabel}
            </Button>
          )}
        </div>
        {scopeType === "inbox" && job.status === "starting" && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Startar analysen…
          </p>
        )}
        {scopeType === "inbox" && job.status === "running" && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            {job.alreadyRunning ? "En analys av samma inkorg och period pågår redan – Folke startar ingen ny, utan visar den här när den är klar. " : "Analysen pågår på servern. "}
            Du kan lämna sidan, byta app eller låsa telefonen – den fortsätter, och resultatet visas här när du kommer tillbaka.
            {job.unreachable && " Folke når inte servern just nu och försöker igen."}
          </p>
        )}
        {!enabled && (
          <p className="mt-3 text-xs text-muted-foreground">
            AI-analysen är avstängd i den här miljön.
          </p>
        )}
        {enabled && scopeType === "all" && !canSummariseAll && (
          <p className="mt-3 text-xs text-muted-foreground">
            Sammanvägning för alla regioner kräver åtkomst till alla regioner.
          </p>
        )}
      </Panel>

      {(error || (scopeType === "inbox" && job.status === "failed" && job.error)) && (
        <Alert variant="destructive" className="mt-4">
          <AlertTriangle />
          <AlertDescription>{error ?? job.error}</AlertDescription>
        </Alert>
      )}

      {shown?.summary && <Findings result={shown} onEvidence={onEvidence} showSellers={scopeType !== "inbox"} />}
      {shown?.legacySummary && <Legacy result={shown} />}
      {shown?.counts && (
        <Classifications
          counts={shown.counts}
          total={shown.run.dialoguesAnalysed}
          onEvidence={onEvidence}
        />
      )}

      {state.runs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-overline mb-2 flex items-center gap-1.5">
            <History className="size-3.5" aria-hidden />
            Tidigare analyser
          </h3>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Gjord</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Dialoger</TableHead>
                  <TableHead>Metod</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDateTime(r.finishedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {periodLabel(r.from, r.to)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {number.format(r.dialoguesAnalysed)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.analysisVersion} · {MODEL_LABELS[r.model] ?? r.model}
                      {!r.current && (
                        <StatusBadge tone="neutral" className="ml-2">
                          Tidigare metod
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => open(r.id)}
                        disabled={pending || shown?.run.id === r.id}
                      >
                        {shown?.run.id === r.id
                          ? "Visas"
                          : openingRun === r.id
                            ? "Öppnar…"
                            : "Öppna"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <p className="mt-2 text-xs text-muted-foreground">
            Analyser med olika metod (version eller modell) jämförs inte med
            varandra.
          </p>
        </div>
      )}
    </Section>
  );
}

const KIND_LABEL = {
  working: "Fungerar",
  opportunity: "Möjlighet",
  undetermined: "Går inte att avgöra från HubSpot",
  other: "Återkommande mönster",
  // lead-ai-3 only (earlier analysis method).
  stalling: "Tappar fart (tidigare analysmetod)",
} as const;

function Findings({
  result,
  onEvidence,
  showSellers,
}: {
  result: LeadAIResult;
  onEvidence: (r: EvidenceRequest) => void;
  /** On an inbox page the seller observations are shown with the seller figures instead. */
  showSellers: boolean;
}) {
  const s = result.summary!;
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-heading text-base">
          AI:s tolkning – återkommande mönster
        </h3>
        <StatusBadge tone="brand">AI:s sammanvägda bedömning</StatusBadge>
      </div>
      {s.findings.length === 0 ? (
        <Panel className="px-6 py-5 text-sm text-muted-foreground">AI fann inga tydliga återkommande mönster i underlaget.</Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {s.findings.map((f, i) => (
            <Panel key={i} className="flex flex-col px-6 py-5">
              <span className="text-overline mb-1.5">{KIND_LABEL[f.kind]}</span>
              <p className="text-sm font-medium">{f.title}</p>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{f.text}</p>
              <button
                type="button"
                onClick={() => onEvidence({ title: f.title, description: f.text, origin: "ai", threadIds: f.threadIds })}
                className="mt-3 w-fit text-sm font-medium underline underline-offset-4"
              >
                Visa de {number.format(f.threadIds.length)} dialogerna bakom
              </button>
            </Panel>
          ))}
        </div>
      )}
      <AboutMaterial limits={s.limits} caveats={s.caveats} />

      {showSellers && s.sellerPatterns.length > 0 && (
        <div className="mt-6">
          <h3 className="text-overline mb-2">Per säljare – underlag för coachning, ingen rangordning</h3>
          <Panel>
            <ul className="divide-y">
              {[...s.sellerPatterns]
                .sort((a, b) => a.name.localeCompare(b.name, "sv"))
                .map((p) => (
                  <SellerCoaching key={p.sellerId} name={p.name} pattern={p} onEvidence={onEvidence} stats={[`${number.format(p.dialogues)} analyserade dialoger`]} />
                ))}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}

/** One short line about what the assessment rests on; the details behind "Om underlaget". */
function AboutMaterial({ limits, caveats }: { limits: string; caveats: string[] }) {
  return (
    <div className="mt-3 text-sm text-muted-foreground">
      <p>Bedömningen gäller bara det som syns i HubSpot.</p>
      {(limits || caveats.length > 0) && (
        <details className="mt-1 max-w-3xl">
          <summary className="w-fit cursor-pointer text-xs font-medium underline underline-offset-4">Om underlaget</summary>
          <div className="mt-2 flex flex-col gap-2 text-xs">
            {limits && <p>{limits}</p>}
            {caveats.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function Legacy({ result }: { result: LeadAIResult }) {
  const s = result.legacySummary!;
  return (
    <Panel className="mt-6 px-6 py-5 text-sm">
      <p className="text-xs text-muted-foreground">
        Gjord med analysmetoden {result.run.analysisVersion} och visas som den
        var.
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-overline mb-2">Återkommande styrkor</h3>
          <ul className="list-disc pl-5">
            {s.strengths.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-overline mb-2">Förbättringsområden</h3>
          <ul className="list-disc pl-5">
            {s.improvements.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

const BEHAVIOUR_FILTER: Partial<Record<(typeof BEHAVIOURS)[number], string>> = {
  answered_questions: "unanswered_questions",
  next_step: "next_step_missing",
  follow_up: "follow_up_missing",
};

function Classifications({
  counts,
  total,
  onEvidence,
}: {
  counts: AICounts;
  total: number;
  onEvidence: (r: EvidenceRequest) => void;
}) {
  const q = counts.questions;
  return (
    <div className="mt-6">
      <h3 className="text-overline mb-2">
        Klassificering av de {number.format(total)} analyserade dialogerna
      </h3>
      {counts.progress && (
        <Panel className="mb-4 px-6 py-5">
          <h4 className="mb-3 text-sm font-medium">Fördes affären framåt?</h4>
          <Bars
            items={counts.progress.map((p) => ({
              label: PROGRESS_LABELS[p.label as Progress] ?? p.label,
              count: p.count,
            }))}
            total={total}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            {q
              ? `Kunderna ställde ${number.format(q.asked)} konkreta frågor: ${number.format(q.answered)} besvarades, ${number.format(q.partly)} delvis, ${number.format(q.unanswered)} saknade synligt svar och ${number.format(q.notDue)} kom utan senare säljarmeddelande. `
              : ""}
            {counts.continuation?.not_determinable
              ? `Fortsättningen går inte att avgöra från HubSpot i ${number.format(counts.continuation.not_determinable)} dialoger${counts.continuation.stated_other_channel ? `, och i ${number.format(counts.continuation.stated_other_channel)} säger dialogen att nästa steg sker per telefon eller i annan kanal` : ""}. `
              : ""}
            {counts.missedOpportunities
              ? `AI bedömde en tydlig missad möjlighet, synlig i dialogen, i ${number.format(counts.missedOpportunities)} dialoger.`
              : ""}
            {counts.missedOpportunities ? (
              <>
                {" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={() =>
                    onEvidence({
                      title: "Möjliga missade affärsmöjligheter",
                      description:
                        "Dialoger där AI bedömde att en tydlig möjlighet inte togs tillvara i den synliga dialogen – säljaren skrev efter signalen.",
                      origin: "classification",
                      filter: "missed_opportunity",
                    })
                  }
                >
                  Visa
                </button>
              </>
            ) : null}
          </p>
        </Panel>
      )}
      <Panel>
        <div className="border-b px-6 py-3">
          <h4 className="text-sm font-medium">
            Säljarens agerande, där det var relevant
          </h4>
        </div>
        <div className="divide-y">
          {BEHAVIOURS.map((b) => (
            <div key={b}>
              <BehaviourRow
                behaviour={b}
                counts={counts.behaviours[b]}
                total={total}
              />
              {BEHAVIOUR_FILTER[b] && counts.behaviours[b].missing > 0 && (
                <div className="-mt-2 flex justify-end px-6 pb-3">
                  <button
                    type="button"
                    className="text-xs font-medium underline underline-offset-4"
                    onClick={() =>
                      onEvidence({
                        title: `Saknades: ${b === "answered_questions" ? "svar på konkreta frågor" : b === "next_step" ? "konkret nästa steg" : "uppföljning"}`,
                        description:
                          "Dialoger där beteendet var relevant men saknades i texten.",
                        origin: "classification",
                        filter: BEHAVIOUR_FILTER[b],
                      })
                    }
                  >
                    Visa underlag
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
          Stickprovskontrollerade mot manuell läsning av avidentifierade
          dialoger. Behovsfrågor är den osäkraste bedömningen. Uppföljning
          räknas ut ur HubSpot; AI avgör bara om säljarens meddelande väntade på
          svar.
        </p>
      </Panel>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Panel className="px-6 py-5">
          <h4 className="text-overline mb-3">Kundens huvudsakliga ärende</h4>
          <Bars
            items={counts.intent.map((i) => ({
              label: INTENT_LABELS[i.label as Intent] ?? i.label,
              count: i.count,
            }))}
            total={total}
          />
        </Panel>
        <Panel className="px-6 py-5">
          <h4 className="text-overline mb-3">Köpintention enligt texten</h4>
          <Bars
            items={counts.purchaseIntent.map((i) => ({
              label:
                PURCHASE_INTENT_LABELS[i.label as PurchaseIntent] ?? i.label,
              count: i.count,
            }))}
            total={total}
          />
          {counts.carSold > 0 && (
            <p className="mt-4 text-sm">
              I {ofTotal(counts.carSold, total, { percentage: false })} dialoger
              var bilen såld eller reserverad. Alternativ erbjöds i{" "}
              {number.format(counts.soldWithAlternative)} och inte i{" "}
              {number.format(counts.soldWithoutAlternative)}.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
