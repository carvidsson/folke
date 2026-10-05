"use client";

import { AlertTriangle, ArrowUpRight, ChevronRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Panel } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LeadChatContext } from "@/lib/leads/chat";
import { periodLabel, PRESET_LABELS } from "@/lib/leads/periods";
import type { CoverageInfo, Insight, LeadMetrics, LeadOverview, LeadRow, SellerFacts, SellerPattern } from "@/lib/leads/types";
import { cn } from "@/lib/utils";
import { syncLeadsAction } from "@/server/leads/actions";

import { AskFolkeMenu, useAskFolke } from "./ask-folke";
import { BarList, DistributionBars, DonutWithList } from "./charts";
import { CustomerNeeds } from "./customer-needs";
import { EvidenceSheet, type EvidenceRequest } from "./evidence-sheet";
import { LeadAI, type AIStateView } from "./lead-ai";
import { SellerCoaching } from "./seller-coaching";
import { change, formatDateTime, formatFreshness, formatMinutes, LoadGrid, number, ofTotal, OriginBadge, Section, STATUS, WINDOW_LABELS } from "./parts";

export interface LeadListItem extends LeadRow {
  sellerName: string | null;
  hubspotUrl: string | null;
  /** What Folke can say about the end of the dialogue (HubSpot facts and the stored AI classification). */
  context: "agreed" | "stated_other_channel" | "undetermined" | "waiting" | "customer_last" | null;
}

export interface LeadAnalysisProps {
  overview: LeadOverview;
  detail: { sellers: SellerFacts[]; leads: LeadListItem[] } | null;
  ai: AIStateView;
  aiEnabled: boolean;
  canSummariseAll: boolean;
  linkConfigured: boolean;
  maxSyncDays: number;
  today: string;
  /** The Leadanalys assistant's slug when the user may use it ("Fråga Folke", ADR-050). */
  askFolke: string | null;
}

/** Query string for a scope and period. */
function href(scope: { regionId?: string | null; inboxId?: string | null }, period: { preset: string; from: string; to: string }) {
  const p = new URLSearchParams();
  // The default period (last 7 days) is left out of the address.
  if (period.preset !== "7d") p.set("period", period.preset);
  if (period.preset === "custom") {
    p.set("from", period.from);
    p.set("to", period.to);
  }
  if (scope.inboxId) p.set("inbox", scope.inboxId);
  else if (scope.regionId) p.set("region", scope.regionId);
  const q = p.toString();
  return `/leads${q ? `?${q}` : ""}`;
}

export function LeadAnalysis({ overview, detail, ai, aiEnabled, canSummariseAll, linkConfigured, maxSyncDays, today, askFolke }: LeadAnalysisProps) {
  const router = useRouter();
  const { scope, period, metrics, coverage, comparison } = overview;
  const scopeParams = { regionId: scope.type === "region" ? scope.regionId : null, inboxId: scope.inboxId };
  const actionScope = { ...scopeParams, preset: period.preset, from: period.from, to: period.to };
  const [evidence, setEvidence] = useState<EvidenceRequest | null>(null);
  const ask = useAskFolke(askFolke);
  const [custom, setCustom] = useState({ from: period.from, to: period.to });
  // The date fields follow the period shown (a preset chosen in the list, or a link), not only the first one.
  const [customFor, setCustomFor] = useState(`${period.from}|${period.to}`);
  if (customFor !== `${period.from}|${period.to}`) {
    setCustomFor(`${period.from}|${period.to}`);
    setCustom({ from: period.from, to: period.to });
  }
  // Until most dialogues are AI-analysed, the HubSpot facts lead the page and the observations come later.
  const observationsFirst = overview.ai.eligible > 0 && overview.ai.analysed / overview.ai.eligible >= 0.5;

  return (
    <>
      <nav aria-label="Urval" className="mb-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {scope.trail.map((t, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
            {i < scope.trail.length - 1 ? (
              <Link href={href({ regionId: t.regionId, inboxId: t.inboxId }, period)} className="underline-offset-4 hover:text-foreground hover:underline">
                {t.label}
              </Link>
            ) : (
              <span className="text-foreground" aria-current="page">
                {t.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title">{scope.type === "all" ? "Leadanalys" : scope.name}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {scope.type === "all"
              ? "Hur leads tas emot och besvaras i de inkorgar som ingår. Allt räknas fram ur data som Folke har hämtat från HubSpot."
              : scope.type === "region"
                ? "Inkorgarna i regionen. Klicka på en inkorg för detaljanalysen."
                : "Detaljanalys av inkorgen."}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <AskFolkeMenu assistantSlug={askFolke} scopeName={scope.type === "all" ? "alla leads" : scope.name} context={actionScope} />
          <Select
            value={period.preset}
            onValueChange={(v) => v !== "custom" && router.push(href(scopeParams, { preset: v, from: period.from, to: period.to }))}
          >
            <SelectTrigger className="h-9 w-48" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRESET_LABELS).map(([k, l]) => (
                <SelectItem key={k} value={k}>
                  {l}
                </SelectItem>
              ))}
              <SelectItem value="custom">Eget intervall</SelectItem>
            </SelectContent>
          </Select>
          <form
            className="flex items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              router.push(href(scopeParams, { preset: "custom", ...custom }));
            }}
          >
            <Input type="date" aria-label="Från och med" className="h-9 w-36" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <Input type="date" aria-label="Till och med" className="h-9 w-36" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            <Button type="submit" variant="outline" size="sm" className="h-9">
              Visa
            </Button>
          </form>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{period.label}</span> · {periodLabel(period.from, period.to)} · jämförs med {comparison.previous.label}
      </p>

      <Freshness coverage={coverage} scope={actionScope} period={period} previous={comparison} maxSyncDays={maxSyncDays} onDone={() => router.refresh()} />

      <SectionNav
        items={[
          { id: "oversikt", label: "Översikt" },
          ...(observationsFirst ? [{ id: "observationer", label: "Observationer" }] : []),
          { id: overview.rows.length ? "leads" : "kallor", label: "Leads" },
          ...(overview.needs && overview.needs.candidates > 0 ? [{ id: "kundbehov", label: "Kundbehov" }] : []),
          { id: "svarstider", label: "Svarstider" },
          { id: "bilar", label: "Bilar" },
          ...(!observationsFirst ? [{ id: "observationer", label: "Observationer" }] : []),
          { id: "ai", label: "AI-analys" },
          ...(detail ? [{ id: "saljare", label: "Säljare" }, { id: "alla-leads", label: "Alla leads" }] : []),
        ]}
      />

      <Section
        id="oversikt"
        title="Nyckeltal"
        origin="fact"
        description="Ett registrerat säljsvar är det första utgående meddelande en säljare själv skickat i HubSpot. Kontakt per telefon och offerter från säljsystemet syns inte. Tider räknas bland leads med registrerat säljsvar."
      >
        <KeyFigures metrics={metrics} comparison={comparison.metrics} previousLabel={comparison.previous.label} previousCoverage={comparison.coverage} />
      </Section>

      {observationsFirst && <Observations overview={overview} onEvidence={setEvidence} />}

      {overview.rows.length > 0 && (
        <Section
          id="leads"
          title={overview.rowKind === "region" ? "Leads per region och inkorg" : "Leads per inkorg"}
          origin="fact"
          description={overview.rowKind === "region" ? "Klicka på en region eller inkorg för att gå vidare. Ingen rangordning." : "Klicka på en inkorg för detaljanalysen. Ingen rangordning."}
        >
          <Panel className="px-6 py-5">
            <div className={cn("grid gap-8", overview.volumes.regions && "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
              {overview.volumes.regions && (
                <div>
                  <h3 className="text-overline mb-3">Per region</h3>
                  <BarList
                    label="Leads per region"
                    items={overview.volumes.regions.map((r) => ({ key: r.id, label: r.name, value: r.leads, valueLabel: ofTotal(r.leads, metrics.leads), href: href({ regionId: r.id }, period) }))}
                  />
                </div>
              )}
              {overview.volumes.inboxes && (
                <div>
                  <h3 className="text-overline mb-3">Per inkorg</h3>
                  <BarList
                    label="Leads per inkorg"
                    items={[...overview.volumes.inboxes]
                      .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name, "sv"))
                      .map((i) => ({ key: i.id, label: i.name, value: i.leads, valueLabel: number.format(i.leads), href: href({ inboxId: i.id }, period) }))}
                  />
                </div>
              )}
            </div>
          </Panel>
          <Panel className="mt-3">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{overview.rowKind === "region" ? "Region" : "Inkorg"}</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Registrerat säljsvar</TableHead>
                  <TableHead className="text-right">Median kontorstid</TableHead>
                  <TableHead>Hämtat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(href(overview.rowKind === "region" ? { regionId: r.id } : { inboxId: r.id }, period))}>
                    <TableCell>
                      <Link
                        href={href(overview.rowKind === "region" ? { regionId: r.id } : { inboxId: r.id }, period)}
                        className="font-medium underline-offset-4 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.name}
                      </Link>
                      {r.detail && <span className="block text-xs text-muted-foreground">{r.detail}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{number.format(r.metrics.leads)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.metrics.leads ? ofTotal(r.metrics.registeredReply, r.metrics.leads) : "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinutes(r.metrics.medianBusinessMinutes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.coverage.complete ? (r.coverage.oldestSyncAt ? formatFreshness(r.coverage.oldestSyncAt) : "–") : <StatusBadge tone="warning">Delvis</StatusBadge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </Section>
      )}

      <Section id="kallor" title="Leadskällor" origin="fact" description="Var leadsen kommer ifrån, enligt källan i leadet. Klicka på en källa för att se leadsen.">
        <Panel className="px-6 py-5">
          {metrics.leads ? (
            <DonutWithList
              label={`Leadskällor: ${overview.sources.map((s) => `${s.name} ${s.leads}`).join(", ")}`}
              items={overview.sources.map((s) => ({ name: s.name, value: s.leads }))}
              total={metrics.leads}
              onSelect={(name) => setEvidence({ title: `Källa: ${name}`, description: `Leads från ${name} i perioden.`, origin: "fact", filter: `source:${name}` })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Inga leads i perioden.</p>
          )}
        </Panel>
      </Section>

      <CustomerNeeds needs={overview.needs} onEvidence={setEvidence} onAsk={ask ? (q) => ask(q, actionScope as LeadChatContext) : null} />

      <ResponseTimes overview={overview} onEvidence={setEvidence} />

      <Section id="bilar" title="Bilar" origin="fact" description="Märke och modell när de kan fastställas ur formulärets fält, ämnesraden eller kampanjsidan. Folke gissar aldrig.">
        <Panel className="px-6 py-5">
          <p className="mb-4 text-sm">
            Märke identifierat för <span className="font-medium">{ofTotal(overview.vehicleQuality.brandIdentified, overview.vehicleQuality.leads)}</span> leads och modell för{" "}
            <span className="font-medium">{ofTotal(overview.vehicleQuality.modelIdentified, overview.vehicleQuality.leads)}</span>. Leads via e-post och sidor utan bilinformation redovisas som ej identifierade.
          </p>
          {(scope.type !== "inbox" || overview.brands.filter((b) => b.name !== "Ej identifierat märke").length > 1) && (
            <BarList
              label="Leads per märke"
              items={overview.brands.map((b) => ({ key: b.name, label: b.name, value: b.leads, valueLabel: ofTotal(b.leads, metrics.leads), muted: b.name === "Ej identifierat märke" }))}
            />
          )}
        </Panel>
        <Panel className="mt-3">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Märke och modell</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Registrerat säljsvar</TableHead>
                <TableHead className="text-right">Median kontorstid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.brands.map((b) => (
                <BrandRows key={b.name} brand={b} total={metrics.leads} />
              ))}
            </TableBody>
          </Table>
        </Panel>
        <VirtualListings overview={overview} period={period} onEvidence={setEvidence} />
      </Section>

      {!observationsFirst && <Observations overview={overview} onEvidence={setEvidence} />}

      <LeadAI
        scope={actionScope}
        scopeType={scope.type}
        analysisVersion={overview.ai.analysisVersion}
        state={ai}
        enabled={aiEnabled}
        canSummariseAll={canSummariseAll}
        onEvidence={setEvidence}
      />

      {detail && (
        <InboxDetail
          detail={detail}
          linkConfigured={linkConfigured}
          patterns={ai.current?.summary?.sellerPatterns ?? []}
          onEvidence={setEvidence}
          askFolke={askFolke}
          context={actionScope}
        />
      )}

      <Section id="inflode" title="När leadsen kommer" origin="fact" description="Alla leads i urvalet efter veckodag och tid på dygnet. Använd det för bemanning: när kommer de och när besvaras de?">
        <Panel className="px-6 py-5">
          <LoadGrid grid={overview.load.grid} bands={overview.load.bands} />
        </Panel>
        <Panel className="mt-3">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{overview.load.byGroup.length ? (scope.type === "all" ? "Region" : "Inkorg") : "Inkom"}</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Under kontorstid</TableHead>
                <TableHead className="text-right">Vardag utanför kontorstid</TableHead>
                <TableHead className="text-right">Helg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(overview.load.byGroup.length
                ? overview.load.byGroup
                : [{ name: "Alla", leads: metrics.leads, businessHours: metrics.leads - metrics.outsideBusinessHours, weekdayOffHours: 0, weekend: 0 }]
              ).map((g) => (
                <TableRow key={g.name}>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{number.format(g.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ofTotal(g.businessHours, g.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{overview.load.byGroup.length ? ofTotal(g.weekdayOffHours, g.leads) : "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">{overview.load.byGroup.length ? ofTotal(g.weekend, g.leads) : "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
        <p className="mt-2 text-xs text-muted-foreground">
          {WINDOW_LABELS.weekday_off_hours} och helg: {ofTotal(metrics.outsideBusinessHours, metrics.leads)} av alla leads.
        </p>
      </Section>

      <Section
        title="Utveckling över tid"
        origin={["fact", "stored"]}
        description="Per månad efter när leadsen kom in, ur data som Folke har hämtat. En månad som inte är helt hämtad markeras och ska inte läsas som komplett."
      >
        <Trend overview={overview} />
      </Section>

      <EvidenceSheet request={evidence} scope={actionScope} linkConfigured={linkConfigured} onClose={() => setEvidence(null)} />
    </>
  );
}

function Freshness({
  coverage,
  scope,
  period,
  previous,
  maxSyncDays,
  onDone,
}: {
  coverage: CoverageInfo;
  scope: Record<string, string | null | undefined>;
  period: { from: string; to: string };
  previous: LeadOverview["comparison"];
  maxSyncDays: number;
  onDone: () => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooLong = (new Date(period.to).getTime() - new Date(period.from).getTime()) / 86_400_000 + 1 > maxSyncDays;

  async function sync(target: Record<string, string | null | undefined>, label: string) {
    setError(null);
    let remaining: string[] | undefined;
    let done = 0;
    const total = coverage.inboxes;
    setProgress(`${label}: 0 av ${total} inkorgar…`);
    for (let round = 0; round < 30; round++) {
      const result = await syncLeadsAction(target, remaining).catch(() => null);
      if (!result?.ok) {
        setError(result && !result.ok ? result.error : "Hämtningen avbröts. Försök igen.");
        break;
      }
      done += result.data.done.length;
      remaining = result.data.remaining;
      setProgress(`${label}: ${done} av ${total} inkorgar…`);
      if (!remaining.length) break;
    }
    setProgress(null);
    onDone();
  }

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {coverage.newestSyncAt ? (
          <p>
            Hämtat från HubSpot <span className="font-medium">{formatFreshness(coverage.oldestSyncAt ?? coverage.newestSyncAt)}</span>
            {coverage.oldestSyncAt && coverage.newestSyncAt && coverage.oldestSyncAt.slice(0, 16) !== coverage.newestSyncAt.slice(0, 16) && (
              <span className="text-muted-foreground"> (äldsta inkorgen; senaste {formatFreshness(coverage.newestSyncAt)})</span>
            )}
            . {coverage.complete ? `Hela perioden finns för alla ${coverage.inboxes} inkorgar.` : `Hela perioden finns för ${coverage.completeInboxes} av ${coverage.inboxes} inkorgar.`}
          </p>
        ) : (
          <p>Folke har inte hämtat perioden från HubSpot ännu.</p>
        )}
        {!coverage.complete && (
          <p className="mt-1 flex items-start gap-1.5 text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            Siffrorna gäller bara det som är hämtat ({coverage.coveredDays} av {coverage.totalDays} dagar för alla inkorgar).
          </p>
        )}
        {progress && <p className="mt-1 text-muted-foreground" role="status">{progress}</p>}
        {error && <p className="mt-1 text-destructive">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {!previous.coverage.complete && !tooLong && (
          <Button variant="outline" size="sm" disabled={!!progress} onClick={() => sync({ ...scope, preset: "custom", from: previous.previous.from, to: previous.previous.to }, "Hämtar föregående period")}>
            Hämta föregående period
          </Button>
        )}
        <Button size="sm" disabled={!!progress || tooLong} onClick={() => sync(scope, "Hämtar")} title={tooLong ? `Högst ${maxSyncDays} dagar per hämtning` : undefined}>
          <RefreshCw className={cn(progress && "animate-spin")} />
          Uppdatera från HubSpot
        </Button>
      </div>
    </div>
  );
}

function KeyFigures({
  metrics: m,
  comparison: p,
  previousLabel,
  previousCoverage,
}: {
  metrics: LeadMetrics;
  comparison: LeadMetrics | null;
  previousLabel: string;
  previousCoverage: CoverageInfo;
}) {
  const share = (a: number, b: number) => (b ? a / b : null);
  const rows: [string, string, string, string][] = [
    ["Leads", number.format(m.leads), p ? number.format(p.leads) : "–", p ? change(m.leads, p.leads, "count") : "–"],
    [
      "Registrerat säljsvar i HubSpot",
      m.leads ? ofTotal(m.registeredReply, m.leads) : "–",
      p && p.leads ? ofTotal(p.registeredReply, p.leads) : "–",
      p ? change(share(m.registeredReply, m.leads), share(p.registeredReply, p.leads), "share", share(p.registeredReply, p.leads)) : "–",
    ],
    ["Inget registrerat säljsvar i HubSpot", m.leads ? ofTotal(m.noRegisteredReply, m.leads) : "–", p && p.leads ? ofTotal(p.noRegisteredReply, p.leads) : "–", p ? change(m.noRegisteredReply, p.noRegisteredReply, "count") : "–"],
    ["Median till första registrerade säljsvar, kontorstid", formatMinutes(m.medianBusinessMinutes), p ? formatMinutes(p.medianBusinessMinutes) : "–", p ? change(m.medianBusinessMinutes, p.medianBusinessMinutes, "minutes") : "–"],
    ["Median till första registrerade säljsvar, kalendertid", formatMinutes(m.medianCalendarMinutes), p ? formatMinutes(p.medianCalendarMinutes) : "–", p ? change(m.medianCalendarMinutes, p.medianCalendarMinutes, "minutes") : "–"],
    ["Första registrerade säljsvar inom 1 timme kontorstid", m.registeredReply ? ofTotal(m.withinOneBusinessHour, m.registeredReply) : "–", p && p.registeredReply ? ofTotal(p.withinOneBusinessHour, p.registeredReply) : "–", "–"],
  ];
  // Every lead has exactly one of the three statuses, so they always sum to the number of leads.
  if (m.uncertain || p?.uncertain) {
    rows.splice(3, 0, [
      "Annat utgående meddelande före säljsvar",
      m.leads ? ofTotal(m.uncertain, m.leads) : "–",
      p && p.leads ? ofTotal(p.uncertain, p.leads) : "–",
      // Few leads: the counts, not a percentage change.
      p ? `${number.format(p.uncertain)} → ${number.format(m.uncertain)}` : "–",
    ]);
  }
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Mått</TableHead>
            <TableHead className="text-right">Vald period</TableHead>
            <TableHead className="text-right">{previousLabel}</TableHead>
            <TableHead className="text-right">Förändring</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, now, before, diff]) => (
            <TableRow key={label}>
              <TableCell className="font-medium">{label}</TableCell>
              <TableCell className="text-right tabular-nums">{now}</TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{before}</TableCell>
              <TableCell className="text-right tabular-nums">{diff}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!p && (
        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
          Ingen jämförelse: Folke har hämtat {previousCoverage.coveredDays} av {previousCoverage.totalDays} dagar av föregående period för alla inkorgar. En ofullständig period jämförs inte.
        </p>
      )}
      {(m.uncertain > 0 || (p?.uncertain ?? 0) > 0) && (
        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
          Annat utgående meddelande före säljsvar: ett automatiskt eller systemskickat meddelande kom före säljarens första egna svar, så svarstiden räknas inte. De tre raderna om säljsvar summerar till antalet leads.
        </p>
      )}
      {p && m.leads > 0 && m.leads < 20 && <p className="border-t px-6 py-3 text-xs text-warning">Litet underlag: förändringar kan bero på enstaka leads.</p>}
    </Panel>
  );
}

function BrandRows({ brand, total }: { brand: LeadOverview["brands"][number]; total: number }) {
  const [open, setOpen] = useState(false);
  const expandable = brand.models.length > 0;
  return (
    <>
      <TableRow className={cn(expandable && "cursor-pointer")} onClick={() => expandable && setOpen(!open)}>
        <TableCell className="font-medium">
          {expandable ? (
            <button type="button" aria-expanded={open} className="inline-flex items-center gap-1" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
              {brand.name}
            </button>
          ) : (
            <span className="pl-[1.125rem] text-muted-foreground">{brand.name}</span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">{ofTotal(brand.leads, total)}</TableCell>
        <TableCell className="text-right tabular-nums">{brand.leads ? ofTotal(brand.registeredReply, brand.leads) : "–"}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMinutes(brand.medianBusinessMinutes)}</TableCell>
      </TableRow>
      {open &&
        brand.models.map((m) => (
          <TableRow key={m.name} className="bg-surface/60">
            <TableCell className={cn("pl-10", m.name.startsWith("Ej") && "text-muted-foreground")}>{m.name}</TableCell>
            <TableCell className="text-right tabular-nums">{ofTotal(m.leads, brand.leads)}</TableCell>
            <TableCell className="text-right tabular-nums">{m.leads ? ofTotal(m.registeredReply, m.leads, { percentage: m.leads >= 5 }) : "–"}</TableCell>
            <TableCell className="text-right tabular-nums">{m.leads >= 5 ? formatMinutes(m.medianBusinessMinutes) : "–"}</TableCell>
          </TableRow>
        ))}
    </>
  );
}

function Trend({ overview }: { overview: LeadOverview }) {
  const max = Math.max(1, ...overview.trend.map((t) => t.metrics.leads));
  return (
    <Panel>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Månad</TableHead>
            <TableHead className="w-[30%]">Leads</TableHead>
            <TableHead className="text-right">Registrerat säljsvar</TableHead>
            <TableHead className="text-right">Median kontorstid</TableHead>
            <TableHead className="text-right">Virtuella annonser</TableHead>
            <TableHead>Hämtat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.trend.map((t) => {
            const complete = t.coveredDays === t.totalDays;
            const none = t.coveredDays === 0;
            return (
              <TableRow key={t.month} className={cn(!complete && "text-muted-foreground")}>
                <TableCell className="font-medium tabular-nums">{t.month}</TableCell>
                <TableCell>
                  {none ? (
                    "–"
                  ) : (
                    <span className="flex items-center gap-2">
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <span
                          className={cn("block h-full rounded-full", complete ? "bg-navy-400" : "bg-[repeating-linear-gradient(45deg,var(--color-navy-300)_0_4px,transparent_4px_8px)]")}
                          style={{ width: `${(t.metrics.leads / max) * 100}%` }}
                        />
                      </span>
                      <span className="w-10 text-right tabular-nums">{number.format(t.metrics.leads)}</span>
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{none || !t.metrics.leads ? "–" : ofTotal(t.metrics.registeredReply, t.metrics.leads)}</TableCell>
                <TableCell className="text-right tabular-nums">{none ? "–" : formatMinutes(t.metrics.medianBusinessMinutes)}</TableCell>
                <TableCell className="text-right tabular-nums">{none || !t.metrics.leads ? "–" : ofTotal(t.virtual, t.metrics.leads, { percentage: true })}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {complete ? "Hela månaden" : none ? "Inte hämtad" : <StatusBadge tone="warning">{`Delvis: ${t.coveredDays} av ${t.totalDays} dagar`}</StatusBadge>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="border-t px-6 py-3 text-xs text-muted-foreground">
        Pågående månad räknas till och med i dag. Hämta äldre perioder med periodvalet och Uppdatera från HubSpot för att fylla på historiken.
      </p>
    </Panel>
  );
}

const CONTEXT: Record<NonNullable<LeadListItem["context"]>, string> = {
  agreed: "Nästa steg överenskommet",
  stated_other_channel: "Nästa steg per telefon eller annan kanal enligt dialogen",
  undetermined: "Fortsättningen går inte att avgöra från HubSpot",
  waiting: "Kunden skrev sist med fråga eller köpintention – kan vänta på svar",
  customer_last: "Kunden skrev sist",
};

function InboxDetail({
  detail,
  linkConfigured,
  patterns,
  onEvidence,
  askFolke,
  context,
}: {
  detail: NonNullable<LeadAnalysisProps["detail"]>;
  linkConfigured: boolean;
  patterns: SellerPattern[];
  onEvidence: (r: EvidenceRequest) => void;
  askFolke: string | null;
  context: { regionId: string | null; inboxId: string | null; preset: string; from: string; to: string };
}) {
  const ask = useAskFolke(askFolke);
  const patternOf = new Map(patterns.map((p) => [p.sellerId, p]));
  return (
    <>
      <Section
        id="saljare"
        title="Per säljare"
        origin={patterns.length ? ["fact", "ai"] : "fact"}
        description="Sorterat efter namn – ingen rangordning och inga poäng. Siffrorna är beräknade ur HubSpot; styrkor och det som är värt att utveckla kommer från den senaste AI-analysen av inkorgen. Tänkt som underlag för coachning."
      >
        <Panel>
          <ul className="divide-y">
            {detail.sellers.map((s) => {
              const p = patternOf.get(s.id) ?? null;
              return (
                <SellerCoaching
                  key={s.id}
                  name={s.name}
                  pattern={p}
                  onEvidence={onEvidence}
                  onAsk={ask && /^A-\d{1,20}$/.test(s.id) ? () => ask(`Hur går det för ${s.name}? Vad fungerar och vad kan utvecklas?`, { ...context, preset: context.preset as "30d", sellerId: s.id }) : undefined}
                  stats={[
                    ...(p ? [`${number.format(p.dialogues)} analyserade dialoger`] : []),
                    `${number.format(s.firstResponses)} första säljsvar`,
                    s.smallSample ? "för litet underlag för svarstid" : `median ${formatMinutes(s.response.medianBusinessMinutes)} i kontorstid`,
                    `ägare till ${number.format(s.ownedLeads)} leads`,
                  ]}
                />
              );
            })}
          </ul>
        </Panel>
      </Section>
      <Section id="alla-leads" title="Alla leads" origin="fact" description="Utan kunduppgifter. Originaldialogen läses i HubSpot.">
        <Panel>
          <div className="max-h-[32rem] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Inkom</TableHead>
                  <TableHead>Källa</TableHead>
                  <TableHead>Bil</TableHead>
                  <TableHead>I HubSpot</TableHead>
                  <TableHead>Första säljsvar</TableHead>
                  <TableHead>Säljare</TableHead>
                  <TableHead>
                    <span className="sr-only">Länk</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.leads.map((l) => (
                  <TableRow key={l.threadId}>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(l.arrivedAt)}</TableCell>
                    <TableCell>{l.source ?? <span className="text-muted-foreground">Okänd</span>}</TableCell>
                    <TableCell className="max-w-48 truncate">
                      {[l.vehicleBrand, l.vehicleModel].filter(Boolean).join(" ") || <span className="text-muted-foreground">Ej identifierad</span>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS[l.status][1]}>{STATUS[l.status][0]}</StatusBadge>
                      {l.context && <span className="mt-1 block text-xs text-muted-foreground">{CONTEXT[l.context]}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{l.status === "registered_reply" ? `${formatMinutes(l.businessMinutes)} (kontorstid)` : "–"}</TableCell>
                    <TableCell>{l.sellerName ?? "–"}</TableCell>
                    <TableCell className="text-right">
                      {l.hubspotUrl && (
                        <a href={l.hubspotUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-sm whitespace-nowrap underline-offset-4 hover:underline">
                          HubSpot
                          <ArrowUpRight className="size-3.5" aria-hidden />
                          <span className="sr-only">(öppnas i en ny flik)</span>
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!linkConfigured && <p className="border-t px-6 py-3 text-xs text-muted-foreground">Länk till HubSpot visas när en administratör har verifierat länkmönstret.</p>}
        </Panel>
      </Section>
    </>
  );
}

const TONE: Record<Insight["tone"], string> = { strength: "Styrka", opportunity: "Möjlighet", observation: "Observation" };

/** 0–5 observations that pass their thresholds (ADR-048) – none is shown just to fill the space. */
function Observations({ overview, onEvidence }: { overview: LeadOverview; onEvidence: (r: EvidenceRequest) => void }) {
  const { insights, ai } = overview;
  if (!insights.length && !ai.eligible) return <span id="observationer" />;
  return (
    <Section
      id="observationer"
      title="Observationer"
      origin={["fact", "classification"]}
      description="Det som sticker ut i urvalet: det som fungerar, möjligheter som syns i dialogerna och sådant som är värt att känna till. Bara det som har tillräckligt underlag visas."
    >
      {insights.length > 0 ? (
        <Panel>
          <ul className="divide-y">
            {insights.map((i) => (
              <li key={i.id} className="flex flex-col gap-2 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-overline mb-1">{TONE[i.tone]}</p>
                  <p className="text-sm font-medium">{i.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{i.body}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <OriginBadge origin={i.kind === "fact" ? "fact" : "classification"} />
                    Underlag: {i.basis}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onEvidence({ title: i.title, description: i.body, origin: i.kind === "fact" ? "fact" : "classification", filter: i.filter })}
                >
                  Visa underlag
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Panel className="px-6 py-5 text-sm text-muted-foreground">Inget sticker ut tillräckligt för en observation i urvalet.</Panel>
      )}
      {ai.eligible > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          AI-klassificering finns för {ofTotal(ai.analysed, ai.eligible)} dialoger med registrerat säljsvar i urvalet ({ai.analysisVersion}). Observationer ur AI-klassificeringen kräver minst 10 analyserade dialoger.
        </p>
      )}
    </Section>
  );
}

/** First registered seller reply: distribution (business time), the medians, and per inbox. */
function ResponseTimes({ overview, onEvidence }: { overview: LeadOverview; onEvidence: (r: EvidenceRequest) => void }) {
  const { response, metrics, comparison, volumes } = overview;
  // A median from fewer than 10 replies is shown but toned down; with none there is nothing to show.
  const SMALL = 10;
  const inboxes = volumes.inboxes ? [...volumes.inboxes].filter((i) => i.leads > 0).sort((a, b) => a.name.localeCompare(b.name, "sv")) : null;
  return (
    <Section
      id="svarstider"
      title="Svarstid till första registrerade säljsvar"
      origin="fact"
      description="Fördelningen gäller leads med registrerat säljsvar och räknas i kontorstid (mån–fre 09–18). Leads som kom utanför kontorstid och besvarades innan den började redovisas för sig."
    >
      <Panel className="px-6 py-5">
        {response.replied ? (
          <>
            <p className="mb-4 text-sm">
              Median <span className="font-medium">{formatMinutes(metrics.medianBusinessMinutes)}</span> i kontorstid och{" "}
              <span className="font-medium">{formatMinutes(metrics.medianCalendarMinutes)}</span> i kalendertid, bland {number.format(response.replied)} leads med registrerat säljsvar.
            </p>
            <DistributionBars
              buckets={response.buckets}
              total={response.replied}
              previous={response.previous}
              previousLabel={comparison.previous.label}
              onSelect={(id, label) =>
                onEvidence({ title: `Första registrerade säljsvar: ${label.toLowerCase()}`, description: "Leads med registrerat säljsvar i det här intervallet (kontorstid).", origin: "fact", filter: `bucket:${id}` })
              }
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Inga leads med registrerat säljsvar i perioden.</p>
        )}
      </Panel>
      {inboxes && inboxes.length > 1 && (
        <Panel className="mt-3 px-6 py-5">
          <h3 className="text-overline mb-3">Median kontorstid per inkorg</h3>
          <BarList
            label="Median kontorstid per inkorg"
            items={inboxes.map((i) => ({
              key: i.id,
              label: i.name,
              value: i.medianBusinessMinutes ?? 0,
              valueLabel: i.registeredReply ? formatMinutes(i.medianBusinessMinutes) : "inga säljsvar",
              detail: `${number.format(i.registeredReply)} säljsvar`,
              muted: i.registeredReply === 0,
              faded: i.registeredReply > 0 && i.registeredReply < SMALL ? "Litet underlag" : undefined,
            }))}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Sorterat efter namn – ingen rangordning. Inkorgar med färre än {SMALL} registrerade säljsvar är nedtonade och märkta Litet underlag: där kan enstaka leads ändra medianen mycket.
          </p>
        </Panel>
      )}
    </Section>
  );
}

/** "Virtuell" in the registration number field: counted and compared, never interpreted (ADR-048). */
function VirtualListings({ overview, period, onEvidence }: { overview: LeadOverview; period: { preset: string; from: string; to: string }; onEvidence: (r: EvidenceRequest) => void }) {
  const v = overview.virtual;
  if (!v.leads) return null;
  const rate = (n: number, of: number) => (of ? `${number.format(n)} av ${number.format(of)} (${Math.round((n / of) * 100)} %)` : "–");
  const groups = v.byRegion ?? v.byInbox;
  return (
    <div className="mt-6">
      <h3 className="text-heading mb-1 text-base">Virtuella annonser</h3>
      <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
        Leads där registreringsnumret i formuläret är &quot;Virtuell&quot;. Det förekommer ofta för annonser utan fysisk bil i lager – till exempel inkommande bilar eller bilar för beställning – men är en signal, inte en
        säker fordonsstatus.
      </p>
      <Panel className="px-6 py-5">
        <p className="text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            onClick={() => onEvidence({ title: "Virtuella annonser", description: "Leads där registreringsnumret i formuläret är Virtuell.", origin: "fact", filter: "virtual" })}
          >
            Virtuella annonser: {rate(v.virtual, v.leads)} leads
          </button>
          <span className="text-muted-foreground">
            {" "}
            · registreringsnummer {number.format(v.plate)} · annat värde {number.format(v.other)} · fältet saknas {number.format(v.missing)} (till exempel e-post och hemsidans formulär)
          </span>
        </p>
        <div className="mt-5 grid gap-8 lg:grid-cols-2">
          {groups && groups.length > 1 && (
            <div>
              <h4 className="text-overline mb-3">{v.byRegion ? "Per region" : "Per inkorg"}</h4>
              <BarList
                label={v.byRegion ? "Virtuella annonser per region" : "Virtuella annonser per inkorg"}
                items={groups
                  .filter((g) => g.leads > 0)
                  .sort((a, b) => b.virtual - a.virtual || a.name.localeCompare(b.name, "sv"))
                  .map((g) => ({
                    key: g.name,
                    label: g.name,
                    value: g.virtual,
                    valueLabel: rate(g.virtual, g.leads),
                    href: "id" in g ? href({ inboxId: (g as { id: string }).id }, period) : undefined,
                  }))}
              />
            </div>
          )}
          {v.byBrand.length > 0 && (
            <div>
              <h4 className="text-overline mb-3">Per märke</h4>
              <BarList
                label="Virtuella annonser per märke"
                items={v.byBrand.map((b) => ({
                  key: b.name,
                  label: b.name,
                  value: b.virtual,
                  valueLabel: rate(b.virtual, b.leads),
                  detail: b.models
                    .slice(0, 4)
                    .map((m) => `${m.name} ${m.virtual}`)
                    .join(" · "),
                  muted: b.name === "Ej identifierat märke",
                }))}
              />
            </div>
          )}
        </div>
      </Panel>
      {v.virtual > 0 && v.plate > 0 && (
        <Panel className="mt-3">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Registreringsnummer i formuläret</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Registrerat säljsvar</TableHead>
                <TableHead className="text-right">Median kontorstid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[v.compare.virtual, v.compare.plate].map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{number.format(r.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.leads ? ofTotal(r.registeredReply, r.leads) : "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.registeredReply >= 5 ? formatMinutes(r.medianBusinessMinutes) : "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-6 py-3 text-xs text-muted-foreground">Jämförelsen är beräknad ur HubSpot. Folke drar inga slutsatser om varför skillnader finns.</p>
        </Panel>
      )}
    </div>
  );
}

/** A quiet, sticky row of links to the main parts of the page; the current part is marked. */
function SectionNav({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const list = useRef<HTMLUListElement>(null);
  const ids = items.map((i) => i.id).join(",");
  // On narrow screens the row scrolls sideways: keep the current part in view (without moving the page).
  useEffect(() => {
    const ul = list.current;
    const link = ul?.querySelector<HTMLElement>("[aria-current]");
    if (!ul || !link) return;
    const left = link.offsetLeft - ul.offsetLeft;
    if (left < ul.scrollLeft || left + link.offsetWidth > ul.scrollLeft + ul.clientWidth) ul.scrollTo({ left: Math.max(0, left - 16), behavior: "smooth" });
  }, [active]);
  useEffect(() => {
    const els = ids.split(",").map((id) => document.getElementById(id)).filter((e): e is HTMLElement => Boolean(e));
    // The current part is the last one whose top has passed just below the sticky row. The page scrolls
    // in an inner container, so scroll events are listened for on the whole document (capture).
    let frame = 0;
    const update = () => {
      frame = 0;
      // A part counts as current once its heading is in the upper third below the sticky row (measured from
      // the row itself, so an app header above the scroll area does not matter).
      const top = list.current?.getBoundingClientRect().bottom ?? 0;
      const line = top + (window.innerHeight - top) * 0.3;
      const passed = els.filter((el) => el.getBoundingClientRect().top <= line);
      setActive((passed.at(-1) ?? els[0])?.id ?? "");
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids]);
  return (
    <nav aria-label="Delar av leadanalysen" className="sticky top-0 z-20 -mx-4 mt-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
      <ul ref={list} className="-mb-px flex gap-1 overflow-x-auto text-sm whitespace-nowrap">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              aria-current={active === i.id ? "true" : undefined}
              className={cn(
                "inline-block border-b-2 px-2.5 py-2.5 transition-colors",
                active === i.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
