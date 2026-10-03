"use client";

import { AlertTriangle, Inbox, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { DetailList } from "@/components/common/detail-list";
import { EmptyState } from "@/components/common/empty-state";
import { Panel } from "@/components/common/panel";
import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCalendarDate, formatDate, formatShortDate, formatTime } from "@/lib/format";
import {
  BEHAVIOURS,
  SMALL_SAMPLE_RELEVANT,
  type ArrivalWindow,
  type Behaviour,
  type ExclusionReason,
  type InboxOption,
  type Intent,
  type LeadAIResult,
  type LeadHistory,
  type LeadReport,
  type NotAnalysedReason,
  type PurchaseIntent,
  type ResponseStats,
  type ResponseStatus,
} from "@/lib/leads/types";
import { cn } from "@/lib/utils";
import { leadAIAnalysisAction, leadReportAction } from "@/server/leads/actions";

const number = new Intl.NumberFormat("sv-SE");
const percent = new Intl.NumberFormat("sv-SE", { style: "percent", maximumFractionDigits: 0 });

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "–";
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
  const days = Math.floor(m / 1440);
  const hours = Math.round((m % 1440) / 60);
  return `${days} d${hours ? ` ${hours} h` : ""}`;
}

/** "72 av 84 (86 %)" – the population is always visible. */
function ofTotal(part: number, total: number, { percentage = true }: { percentage?: boolean } = {}) {
  const base = `${number.format(part)} av ${number.format(total)}`;
  return percentage && total > 0 ? `${base} (${percent.format(part / total)})` : base;
}

const WINDOW_LABELS: Record<ArrivalWindow, string> = {
  business_hours: "Under kontorstid",
  weekday_off_hours: "Vardag utanför kontorstid",
  weekend: "Helg",
};

const STATUS: Record<ResponseStatus, [string, StatusTone]> = {
  registered_reply: ["Registrerat säljsvar", "success"],
  no_registered_reply: ["Inget registrerat säljsvar", "warning"],
  uncertain: ["Osäkert", "neutral"],
};

const EXCLUSIONS: Record<ExclusionReason, string> = {
  spam: "markerade som skräp",
  no_messages: "saknade meddelanden",
  starts_with_outgoing: "började med ett utgående meddelande",
  fetch_failed: "kunde inte läsas från HubSpot",
};

/** Name and the concrete definition the AI uses (shortened). */
const BEHAVIOUR_TEXT: Record<Behaviour, { label: string; relevant: string }> = {
  answered_questions: {
    label: "Besvarade kundens konkreta frågor",
    relevant: "Relevant när kunden ställde en konkret fråga och säljaren skrev efter den. Svar i en skickad offert räknas. Slutar dialogen med kundens fråga går det inte att avgöra.",
  },
  next_step: {
    label: "Lämnade ett konkret nästa steg",
    relevant: "Bedöms på säljarens senaste meddelanden när ärendet är öppet: en tid, en offert eller kalkyl, eller en fråga om det som behövs för att gå vidare – inte bara ”hör av dig”.",
  },
  needs_questions: {
    label: "Frågade efter det som behövs för ett rätt erbjudande",
    relevant: "Relevant när svaret beror på uppgifter säljaren saknar, till exempel körsträcka och avtalstid vid leasing eller uppgifter om en inbytesbil.",
  },
  visit_or_test_drive: {
    label: "Bjöd in till besök eller provkörning",
    relevant: "Relevant när kunden vill se eller provköra, är osäker på vilken bil som passar, eller är intresserad av en viss begagnad bil. Inte vid pris- och villkorsfrågor om en bil kunden redan valt.",
  },
  follow_up: {
    label: "Följde upp när kunden inte svarade",
    relevant: "Relevant när kunden inte har svarat på minst 3 dygn efter en fråga, offert eller ett förslag från säljaren. Tiden och om säljaren skrev igen räknas ut ur HubSpot.",
  },
};

const INTENT_LABELS: Record<Intent, string> = {
  price_or_offer: "Pris eller erbjudande",
  financing_or_leasing: "Finansiering eller leasing",
  trade_in: "Inbyte",
  availability: "Om bilen finns kvar",
  test_drive_or_visit: "Provkörning eller besök",
  equipment_or_facts: "Utrustning eller fakta",
  delivery: "Leverans",
  other: "Annat",
  unclear: "Oklart",
};

const PURCHASE_INTENT_LABELS: Record<PurchaseIntent, string> = {
  clear: "Tydlig köpintention",
  interested: "Intresserad av en viss bil",
  information_only: "Bara information",
  unclear: "Går inte att avgöra",
};

const NOT_ANALYSED: Record<NotAnalysedReason, string> = {
  no_registered_reply: "utan registrerat säljsvar i HubSpot",
  redaction_check: "stoppade av avidentifieringskontrollen",
  failed: "kunde inte analyseras",
  limit: "över gränsen per körning",
  time_limit: "hann inte analyseras i den här körningen – kör analysen igen för att fortsätta",
};

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

function Section({ title, kind, description, children }: { title: string; kind?: "fact" | "ai" | "ai-summary" | "history"; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-heading">{title}</h2>
        {kind === "fact" && <StatusBadge tone="info">Beräknat ur HubSpot</StatusBadge>}
        {kind === "history" && <StatusBadge tone="info">Sparat i Folke</StatusBadge>}
        {kind === "ai" && <StatusBadge tone="brand">AI-klassificering</StatusBadge>}
        {kind === "ai-summary" && <StatusBadge tone="brand">AI:s sammanvägda bedömning</StatusBadge>}
      </div>
      {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Horizontal bars for small counts – a reading aid, not a dashboard. */
function Bars({ items, total }: { items: { label: string; count: number }[]; total: number }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_6.5rem] items-center gap-3 text-sm">
          <span className="truncate">{item.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="block h-full rounded-full bg-navy-300" style={{ width: `${total ? (item.count / total) * 100 : 0}%` }} />
          </span>
          <span className="text-right text-muted-foreground tabular-nums">{ofTotal(item.count, total)}</span>
        </li>
      ))}
    </ul>
  );
}

function Columns({ values, labels, title }: { values: number[]; labels: string[]; title: string }) {
  const max = Math.max(1, ...values);
  return (
    <figure>
      <figcaption className="text-caption mb-2">{title}</figcaption>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`${title}: ${values.map((v, i) => `${labels[i]} ${v}`).join(", ")}`}>
        {values.map((v, i) => (
          <span key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
            <span className={cn("w-full rounded-sm", v ? "bg-navy-300" : "bg-muted")} style={{ height: `${Math.max(4, (v / max) * 80)}px` }} />
          </span>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-[0.6875rem] text-muted-foreground" aria-hidden>
        {labels.map((l, i) => (
          <span key={i} className="flex-1 text-center">
            {l}
          </span>
        ))}
      </div>
    </figure>
  );
}

function responseSummary(r: ResponseStats) {
  if (r.n === 0) return "Inga leads med registrerat säljsvar";
  return `${formatMinutes(r.medianBusinessMinutes)} inom kontorstid · ${formatMinutes(r.medianCalendarMinutes)} kalendertid`;
}

export function LeadAnalysisView({
  inboxes,
  loadError,
  defaultFrom,
  defaultTo,
  maxPeriodDays,
  ai,
}: {
  inboxes: InboxOption[];
  loadError: boolean;
  defaultFrom: string;
  defaultTo: string;
  maxPeriodDays: number;
  ai: { enabled: boolean; model: string; maxDialogues: number };
}) {
  const [inboxId, setInboxId] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [report, setReport] = useState<LeadReport | null>(null);
  const [aiResult, setAIResult] = useState<LeadAIResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAIError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [analysing, startAnalysing] = useTransition();

  function fetchReport() {
    setError(null);
    setAIError(null);
    startLoading(async () => {
      try {
        const result = await leadReportAction({ inboxId, from, to });
        if (result.ok) {
          setReport(result.data);
          setAIResult(null);
        } else setError(result.error);
      } catch {
        setError("Det gick inte att hämta leads. Försök igen.");
      }
    });
  }

  function runAI() {
    if (!report) return;
    setAIError(null);
    startAnalysing(async () => {
      try {
        const result = await leadAIAnalysisAction({ inboxId: report.inbox.id, from: report.period.from, to: report.period.to });
        if (result.ok) {
          setReport(result.data.report);
          setAIResult(result.data.ai);
        } else setAIError(result.error);
      } catch {
        setAIError("AI-analysen kunde inte genomföras. Försök igen.");
      }
    });
  }

  if (loadError || inboxes.length === 0) {
    return (
      <Panel className="mt-8">
        <EmptyState
          icon={Inbox}
          title={loadError ? "Inkorgarna kunde inte hämtas" : "Inga inkorgar"}
          description={loadError ? "HubSpot svarade inte som väntat. Ladda om sidan om en stund." : "Servicenyckeln ser inga inkorgar i HubSpot."}
        />
      </Panel>
    );
  }

  return (
    <>
      <form
        className="mt-8 flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs sm:flex-row sm:flex-wrap sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          fetchReport();
        }}
      >
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <Label htmlFor="lead-inbox">Inkorg</Label>
          <Select value={inboxId} onValueChange={setInboxId} disabled={loading || analysing}>
            <SelectTrigger id="lead-inbox" className="h-9 w-full">
              <SelectValue placeholder="Välj inkorg" />
            </SelectTrigger>
            <SelectContent>
              {inboxes.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="lead-from">Från och med</Label>
          <Input id="lead-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required className="h-9 w-44" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="lead-to">Till och med</Label>
          <Input id="lead-to" type="date" value={to} min={from} max={defaultTo} onChange={(e) => setTo(e.target.value)} required className="h-9 w-44" />
        </div>
        <Button type="submit" disabled={!inboxId || !from || !to || loading || analysing}>
          {loading ? "Hämtar från HubSpot…" : "Hämta leads"}
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          Högst {maxPeriodDays} dagar. Dialogerna läses direkt från HubSpot. Folke sparar bara beräknade fakta och analysresultat – aldrig meddelandetexter eller kunduppgifter.
        </p>
      </form>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {report && <Report report={report} />}

      {report && report.dataset.leads > 0 && (
        <AISection report={report} ai={ai} result={aiResult} error={aiError} pending={analysing} onRun={runAI} />
      )}

      {report?.history && <History history={report.history} />}

      {report && (
        <Section title="Begränsningar">
          <ul className="flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
            {report.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Report({ report }: { report: LeadReport }) {
  const { facts, dataset } = report;
  const excluded = dataset.excluded.filter((e) => e.count > 0);
  const replied = facts.status.registered_reply;

  return (
    <>
      <Section title="Underlag" kind="fact">
        <Panel className="px-6 py-5">
          <p className="text-sm">
            <span className="font-medium">{number.format(dataset.leads)} leads</span> kom in till {report.inbox.name} mellan{" "}
            {formatCalendarDate(report.period.from)} och {formatCalendarDate(report.period.to)}.{" "}
            {dataset.outsidePeriod > 0 && (
              <>{number.format(dataset.outsidePeriod)} äldre trådar hade aktivitet i perioden men räknas inte som nya leads. </>
            )}
            {excluded.length > 0 && <>Uteslutna: {excluded.map((e) => `${number.format(e.count)} ${EXCLUSIONS[e.reason]}`).join(", ")}.</>}
          </p>
          {!dataset.complete && (
            <p className="mt-3 flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Underlaget är ofullständigt. Se begränsningarna längst ned.
            </p>
          )}
          {facts.smallSample && dataset.leads > 0 && (
            <p className="mt-3 flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Litet underlag. Andelar och medianer kan ändras mycket av enstaka leads.
            </p>
          )}
        </Panel>
      </Section>

      {dataset.leads === 0 ? (
        <Panel className="mt-6">
          <EmptyState icon={Inbox} title="Inga leads i perioden" description="Välj en annan period eller inkorg." />
        </Panel>
      ) : (
        <>
          <Section
            title="Säljsvar i HubSpot"
            kind="fact"
            description="Ett registrerat säljsvar är det första utgående meddelande som en säljare själv har skickat i HubSpot. Tilldelningar, systemhändelser och interna kommentarer räknas inte. Kontakt per telefon syns inte."
          >
            <Panel className="px-6 py-5">
              <DetailList
                className="grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
                items={[
                  { label: "Registrerat säljsvar i HubSpot", value: `${ofTotal(replied, facts.leads)} leads` },
                  {
                    label: "Inget registrerat säljsvar i HubSpot",
                    value: `${ofTotal(facts.status.no_registered_reply, facts.leads)} leads – tråden är öppen i ${number.format(facts.noReplyOpen)} och stängd i ${number.format(facts.noReplyClosed)}`,
                  },
                  ...(facts.status.uncertain
                    ? [
                        {
                          label: "Osäkert",
                          value: `${ofTotal(facts.status.uncertain, facts.leads)} leads – ett utgående meddelande som inte kunde klassas kom först`,
                        },
                      ]
                    : []),
                  {
                    label: "Tid till första registrerade säljsvar (median)",
                    value: replied ? `${responseSummary(facts.response)} – bland de ${number.format(facts.response.n)} leads som har ett registrerat säljsvar` : "–",
                  },
                  {
                    label: "Första registrerade säljsvar inom kontorstid",
                    value: replied
                      ? `Inom 1 timme i ${ofTotal(facts.response.withinOneBusinessHour, facts.response.n)}, inom 4 timmar i ${ofTotal(facts.response.withinFourBusinessHours, facts.response.n)} av leadsen med registrerat säljsvar`
                      : "–",
                  },
                  {
                    label: "Kunden skrev sist",
                    value: replied
                      ? `${ofTotal(facts.customerWroteLast.total, replied)} leads med registrerat säljsvar slutar med ett meddelande från kunden utan senare registrerat säljsvar (tråden öppen i ${number.format(facts.customerWroteLast.open)}, stängd i ${number.format(facts.customerWroteLast.closed)}). Svaret kan ha gått per telefon eller e-post utanför HubSpot.`
                      : "–",
                  },
                  {
                    label: "Ägare och första svarare",
                    value:
                      facts.owner.different === 0
                        ? `Samma person i alla ${number.format(facts.owner.same)} leads med registrerat säljsvar${facts.owner.noOwner ? ` (${facts.owner.noOwner} utan ägare)` : ""}`
                        : `Samma person i ${number.format(facts.owner.same)}, olika i ${number.format(facts.owner.different)}${facts.owner.noOwner ? `, utan ägare i ${facts.owner.noOwner}` : ""} av ${number.format(replied)} leads med registrerat säljsvar`,
                  },
                ]}
              />
            </Panel>
          </Section>

          <Section
            title="När leadsen kom in"
            kind="fact"
            description="Svensk tid. Tiden räknas från att leadet kom in till HubSpot. 0 min inom kontorstid betyder att det registrerade säljsvaret kom innan kontorstiden började."
          >
            <Panel>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Inkom</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Med registrerat säljsvar</TableHead>
                    <TableHead>Median till första registrerade säljsvar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(Object.keys(WINDOW_LABELS) as ArrivalWindow[]).map((w) => (
                    <TableRow key={w}>
                      <TableCell className="font-medium">{WINDOW_LABELS[w]}</TableCell>
                      <TableCell className="text-right tabular-nums">{number.format(facts.byArrivalWindow[w])}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {ofTotal(facts.responseByArrivalWindow[w].n, facts.byArrivalWindow[w], { percentage: false })}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{responseSummary(facts.responseByArrivalWindow[w])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <div className="mt-4 grid gap-6 rounded-xl border bg-card px-6 py-5 shadow-xs md:grid-cols-[2fr_1fr]">
              <Columns title="Alla leads per timme" values={facts.byHour} labels={facts.byHour.map((_, h) => (h % 3 === 0 ? String(h).padStart(2, "0") : ""))} />
              <Columns title="Alla leads per veckodag" values={facts.byWeekday} labels={WEEKDAYS} />
            </div>
          </Section>

          <Section title="Källor" kind="fact" description={`Källa enligt formuläret, av alla ${number.format(facts.leads)} leads. Leads utan källfält visas som e-post eller okänd källa.`}>
            <Panel className="px-6 py-5">
              <Bars items={facts.bySource} total={facts.leads} />
            </Panel>
          </Section>

          <Section
            title="Per säljare"
            kind="fact"
            description="Leads i perioden, sorterat efter namn – ingen rangordning. Svarstider säger inget om kvaliteten i svaren, och telefonkontakt syns inte."
          >
            <Panel>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Säljare</TableHead>
                    <TableHead className="text-right">Nuvarande ägare till</TableHead>
                    <TableHead className="text-right">Första registrerade säljsvar</TableHead>
                    <TableHead>Median till första registrerade säljsvar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.sellers.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{number.format(s.ownedLeads)}</TableCell>
                      <TableCell className="text-right tabular-nums">{number.format(s.firstResponses)}</TableCell>
                      <TableCell className={cn(s.smallSample && "text-muted-foreground")}>
                        {s.smallSample ? (
                          <span>
                            {s.firstResponses > 0 ? `${formatMinutes(s.response.medianBusinessMinutes)} inom kontorstid · ` : ""}
                            för litet underlag för slutsatser
                          </span>
                        ) : (
                          responseSummary(s.response)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </Section>

          <Section title="Alla leads" kind="fact" description="Utan kunduppgifter. Bil enligt formulärets ämnesrad när den går att läsa ut.">
            <Panel>
              <div className="max-h-[28rem] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Inkom</TableHead>
                      <TableHead>Källa</TableHead>
                      <TableHead>Bil</TableHead>
                      <TableHead>I HubSpot</TableHead>
                      <TableHead>Tid till första säljsvar</TableHead>
                      <TableHead>Säljare som svarade</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.leads.map((l) => (
                      <TableRow key={l.threadId}>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatShortDate(l.arrivedAt)} {formatTime(l.arrivedAt)}
                        </TableCell>
                        <TableCell>{l.source ?? <span className="text-muted-foreground">Okänd</span>}</TableCell>
                        <TableCell className="max-w-56 truncate">{l.vehicle ?? <span className="text-muted-foreground">–</span>}</TableCell>
                        <TableCell>
                          <StatusBadge tone={STATUS[l.status][1]}>{STATUS[l.status][0]}</StatusBadge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {l.status === "registered_reply" ? `${formatMinutes(l.businessMinutes)} (kontorstid)` : "–"}
                        </TableCell>
                        <TableCell>{l.responderId ? (report.sellers.find((s) => s.id === l.responderId)?.name ?? "Okänd användare") : "–"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Panel>
          </Section>
        </>
      )}
    </>
  );
}

function AISection({
  report,
  ai,
  result,
  error,
  pending,
  onRun,
}: {
  report: LeadReport;
  ai: { enabled: boolean; model: string; maxDialogues: number };
  result: LeadAIResult | null;
  error: string | null;
  pending: boolean;
  onRun: () => void;
}) {
  const replied = report.facts.status.registered_reply;
  return (
    <>
      <Section
        title="AI-analys av dialogerna"
        kind="ai"
        description="Dialoger med registrerat säljsvar avidentifieras – namn, e-post, telefonnummer, personnummer, registreringsnummer och signaturer tas bort och säljarna får pseudonymer – innan de skickas till OpenAI. Varje beteende bedöms bara där det var relevant. Resultatet är en bedömning av texten i HubSpot, inte ett facit, och innehåller inga poäng."
      >
        {!ai.enabled ? (
          <Panel className="px-6 py-5 text-sm text-muted-foreground">AI-analysen är avstängd i den här miljön.</Panel>
        ) : !result ? (
          <Panel className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {number.format(Math.min(replied, ai.maxDialogues))} dialoger med registrerat säljsvar kan analyseras med {ai.model}.
              {replied > ai.maxDialogues && ` De ${ai.maxDialogues} senaste analyseras.`} Dialoger som redan är analyserade och inte har ändrats återanvänds.
            </p>
            <Button onClick={onRun} disabled={pending || replied === 0} className="shrink-0">
              <Sparkles />
              {pending ? "Analyserar…" : "Analysera dialogerna"}
            </Button>
          </Panel>
        ) : (
          <AIResult result={result} />
        )}
        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Section>
      {result?.summary && <AISummarySection result={result} />}
    </>
  );
}

function BehaviourRow({ behaviour, counts, total }: { behaviour: Behaviour; counts: Record<"done" | "missing" | "not_relevant" | "unclear", number>; total: number }) {
  const relevant = counts.done + counts.missing;
  const text = BEHAVIOUR_TEXT[behaviour];
  return (
    <div className="grid gap-3 px-6 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div>
        <p className="text-sm font-medium">{text.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{text.relevant}</p>
      </div>
      <div className="text-sm">
        <p>
          Relevant i <span className="font-medium">{ofTotal(relevant, total, { percentage: false })}</span> analyserade dialoger.
          {relevant > 0 && (
            <>
              {" "}
              Gjort i {number.format(counts.done)} och saknades i {number.format(counts.missing)}
              {relevant >= SMALL_SAMPLE_RELEVANT ? ` (gjort i ${percent.format(counts.done / relevant)} av de relevanta)` : " – för få för en andel"}.
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Inte relevant i {number.format(counts.not_relevant)}
          {counts.unclear ? ` · går inte att avgöra i ${number.format(counts.unclear)}` : ""}.
        </p>
        {relevant > 0 && (
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="h-full bg-success" style={{ width: `${(counts.done / relevant) * 100}%` }} />
            <span className="h-full bg-warning" style={{ width: `${(counts.missing / relevant) * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function AIResult({ result }: { result: LeadAIResult }) {
  const n = result.dialoguesAnalysed;
  const notAnalysed = result.notAnalysed.filter((x) => x.count > 0);
  const c = result.counts;
  const soldUnknown = c.carSold - c.soldWithAlternative - c.soldWithoutAlternative;
  return (
    <>
      <Panel className="px-6 py-5">
        <p className="text-sm">
          <span className="font-medium">{number.format(n)} dialoger</span> med registrerat säljsvar är analyserade med {result.model} (analysversion{" "}
          {result.analysisVersion}): {number.format(result.analysedNew)} i den här körningen och {number.format(result.reused)} återanvända från tidigare analyser.
          Kostnad för körningen: ca {result.costUsd.toLocaleString("sv-SE", { maximumFractionDigits: 3 })} USD.
          {notAnalysed.length > 0 && <> Inte analyserade: {notAnalysed.map((x) => `${number.format(x.count)} ${NOT_ANALYSED[x.reason]}`).join(", ")}.</>}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">Alla siffror nedan gäller de {number.format(n)} analyserade dialogerna.</p>
        {n > 0 && n < 10 && (
          <p className="mt-3 flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            Få dialoger. Se mönstren som exempel, inte som slutsatser.
          </p>
        )}
      </Panel>

      {n > 0 && (
        <>
          <Panel className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-6 py-3">
              <h3 className="text-overline">Säljarens agerande, där det var relevant</h3>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-success" aria-hidden />
                  Gjort
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-warning" aria-hidden />
                  Saknades
                </span>
              </span>
            </div>
            <div className="divide-y">
              {BEHAVIOURS.map((b) => (
                <BehaviourRow key={b} behaviour={b} counts={c.behaviours[b]} total={n} />
              ))}
            </div>
            <p className="border-t px-6 py-3 text-xs text-muted-foreground">
              Bedömningarna är stickprovskontrollerade mot manuell läsning av avidentifierade dialoger: omkring 9 av 10 stämde. Behovsfrågor är den
              osäkraste bedömningen. Uppföljning räknas ut ur HubSpot; AI avgör bara om säljarens meddelande väntade på svar.
            </p>
          </Panel>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Panel className="px-6 py-5">
              <h3 className="text-overline mb-3">Kundens huvudsakliga ärende</h3>
              <Bars items={c.intent.map((i) => ({ label: INTENT_LABELS[i.label as Intent] ?? i.label, count: i.count }))} total={n} />
              <h3 className="text-overline mt-6 mb-3">Köpintention enligt texten</h3>
              <Bars items={c.purchaseIntent.map((i) => ({ label: PURCHASE_INTENT_LABELS[i.label as PurchaseIntent] ?? i.label, count: i.count }))} total={n} />
            </Panel>
            <Panel className="px-6 py-5">
              <h3 className="text-overline mb-3">Såld eller reserverad bil</h3>
              <p className="text-sm">
                I {ofTotal(c.carSold, n, { percentage: false })} analyserade dialoger framgick att den efterfrågade bilen var såld eller reserverad.
                {c.carSold > 0 && (
                  <>
                    {" "}
                    Ett alternativ erbjöds i {number.format(c.soldWithAlternative)} av dem och inte i{" "}
                    <span className="font-medium">{number.format(c.soldWithoutAlternative)}</span>
                    {soldUnknown > 0 ? `; i ${number.format(soldUnknown)} går det inte att avgöra` : ""}.
                  </>
                )}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Ett alternativ är en annan konkret bil, en liknande modell eller ett erbjudande att bevaka eller söka åt kunden.
              </p>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function AISummarySection({ result }: { result: LeadAIResult }) {
  const s = result.summary!;
  return (
    <Section
      title="Sammanvägd analys"
      kind="ai-summary"
      description="AI:s tolkning av mönstren i klassificeringarna ovan. Läs den som underlag för samtal, inte som en bedömning av enskilda personer."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="px-6 py-5">
          <h3 className="text-overline mb-3">Återkommande styrkor</h3>
          <List items={s.strengths} empty="Inga tydliga mönster." />
        </Panel>
        <Panel className="px-6 py-5">
          <h3 className="text-overline mb-3">Förbättringsområden</h3>
          <List items={s.improvements} empty="Inga tydliga mönster." />
        </Panel>
      </div>
      {s.soldCars && (
        <Panel className="mt-4 px-6 py-5">
          <h3 className="text-overline mb-3">Såld eller reserverad bil</h3>
          <p className="text-sm">{s.soldCars}</p>
        </Panel>
      )}
      {s.sellerPatterns.length > 0 && (
        <Panel className="mt-4">
          <div className="divide-y">
            {s.sellerPatterns.map((p) => (
              <div key={p.sellerId} className="grid gap-2 px-6 py-4 md:grid-cols-[14rem_minmax(0,1fr)]">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{number.format(p.dialogues)} analyserade dialoger</p>
                </div>
                <List items={p.observations} empty="Inga iakttagelser." />
              </div>
            ))}
          </div>
        </Panel>
      )}
      {s.caveats.length > 0 && (
        <div className="mt-4">
          <h3 className="text-overline mb-2">AI:s förbehåll</h3>
          <List items={s.caveats} muted />
        </div>
      )}
    </Section>
  );
}

function History({ history }: { history: LeadHistory }) {
  if (history.months.length === 0 && history.runs.length === 0) return null;
  return (
    <Section
      title="Utveckling över tid"
      kind="history"
      description="Bygger på de perioder som har hämtats till Folke för inkorgen, senaste tolv månaderna. En månad som bara delvis har hämtats visar bara de leads som finns sparade."
    >
      {history.months.length > 0 && (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Månad (ankomst)</TableHead>
                <TableHead className="text-right">Sparade leads</TableHead>
                <TableHead className="text-right">Registrerat säljsvar</TableHead>
                <TableHead>Median till första registrerade säljsvar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell className="font-medium tabular-nums">{m.month}</TableCell>
                  <TableCell className="text-right tabular-nums">{number.format(m.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ofTotal(m.registeredReply, m.leads)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.registeredReply
                      ? `${formatMinutes(m.medianBusinessMinutes)} inom kontorstid · ${formatMinutes(m.medianCalendarMinutes)} kalendertid`
                      : "–"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {history.runs.length > 0 && (
        <>
          <h3 className="text-overline mt-6 mb-2">Tidigare AI-analyser</h3>
          <p className="mb-3 text-xs text-muted-foreground">Resultat från olika analysversioner eller modeller jämförs inte med varandra.</p>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Körd</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Dialoger</TableHead>
                  <TableHead>Nya · återanvända</TableHead>
                  <TableHead>Analysversion · modell</TableHead>
                  <TableHead className="text-right">Kostnad</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.runs.map((r) => (
                  <TableRow key={r.finishedAt}>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(r.finishedAt)} {formatTime(r.finishedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatCalendarDate(r.from)} – {formatCalendarDate(r.to)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{number.format(r.dialoguesAnalysed)}</TableCell>
                    <TableCell className="tabular-nums">
                      {number.format(r.analysedNew)} · {number.format(r.reused)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.analysisVersion} · {r.model}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.costUsd.toLocaleString("sv-SE", { maximumFractionDigits: 3 })} USD</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </>
      )}
    </Section>
  );
}

function List({ items, empty, muted }: { items: string[]; empty?: string; muted?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className={cn("flex list-disc flex-col gap-1.5 pl-5 text-sm", muted && "text-muted-foreground")}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
