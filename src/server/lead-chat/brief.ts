import "server-only";

import type { LeadBasisReference, LeadSetReference, LeadSourceReference, VerifiedFact } from "@/lib/domain/types";
import type { LeadChatState, LeadIntent } from "@/lib/leads/chat";
import { periodLabel } from "@/lib/leads/periods";
import {
  OPPORTUNITY_TYPES,
  SMALL_SAMPLE_SELLER,
  STRENGTH_TYPES,
  type CoverageInfo,
  type EvidenceFilter,
  type LeadRow,
  type OpportunityType,
  type Period,
  type StrengthType,
} from "@/lib/leads/types";
import type { StoredAnalysis } from "@/server/data/leads";
import { stockholmTime } from "@/server/leads/business-hours";
import { buildInsights, leadMetrics, matches, RESPONSE_BUCKETS, responseBucket, sourceRows, threadUrl, UNKNOWN_SOURCE } from "@/server/leads/overview";
import { median } from "@/server/leads/stats";

import { currentFacts, earlierFactsSection } from "./facts";
import type { ExampleRequest } from "./intent";
import { formatMinutes, MetricRegistry, POPULATIONS, renderMetric, type Metric } from "./metrics";
import { aliasSellerTokens, neutralizeStoredAliases, type Pseudonyms } from "./pseudonyms";

/**
 * The lead brief (ADR-050): a small, deterministic material for one question, built from data stored
 * in Folke – never a new analysis. Modules are chosen by intent and only what they need is loaded;
 * every number comes with its population, every example lead with its origin and number for [n]
 * citations. Seller names appear only as aliases, and no thread ids, links or customer data are
 * included. The same input always gives the same brief.
 */

export type ModuleId = "header" | "keyFigures" | "responseTimes" | "sources" | "virtual" | "comparison" | "seller" | "observations" | "patterns" | "examples";

/** Below this many leads a group's median is marked as a small sample (as on the Leadanalys page). */
const SMALL_GROUP = 10;
/** Below this many AI-analysed dialogues no pattern should be drawn. */
const MIN_ANALYSED = 10;
const PATTERN_EXAMPLES = 2;

export function modulesFor(intents: LeadIntent[], seller: boolean): Set<ModuleId> {
  const m = new Set<ModuleId>(["header"]);
  for (const intent of intents) {
    switch (intent) {
      case "overview":
        m.add("keyFigures").add("observations");
        break;
      case "response_time":
        m.add("keyFigures").add("responseTimes");
        break;
      case "source":
        m.add("sources");
        break;
      case "virtual":
        m.add("virtual");
        break;
      case "comparison":
        m.add("keyFigures").add("comparison");
        break;
      case "patterns":
        m.add("keyFigures").add("patterns");
        break;
      case "examples":
        m.add("examples");
        break;
      case "meeting":
        m.add("keyFigures").add("responseTimes").add("observations").add("patterns").add("examples");
        break;
      case "explain":
        m.add("observations").add("patterns");
        break;
    }
  }
  if (seller) m.add("seller");
  return m;
}

export function needsAnalyses(modules: Set<ModuleId>) {
  return modules.has("observations") || modules.has("patterns") || modules.has("examples");
}

export const STRENGTH_LABELS: Record<StrengthType, string> = {
  interest_to_next_step: "Kundens intresse ledde till ett konkret nästa steg",
  visit_booked: "Besök eller provkörning bokades",
  questions_answered: "Kundens frågor besvarades",
  alternative_offered: "Ett alternativ erbjöds",
};

export const OPPORTUNITY_LABELS: Record<OpportunityType, string> = {
  unanswered_questions: "Konkreta frågor utan synligt svar",
  competitor_offer: "Konkurrerande erbjudande utan synligt motförslag",
  visit_interest: "Besöksintresse som inte plockades upp",
  sold_without_alternative: "Såld bil utan erbjudet alternativ",
  purchase_signal: "Köpsignal som inte togs vara på",
};

/**
 * How an answer refers to a pattern or an observation without a [n] citation. Used with the figure
 * ("13 av 82") to give the user the leads behind what the answer says – deterministically, on the server.
 */
const MENTIONS: Record<string, RegExp> = {
  "strength:interest_to_next_step": /intresse\S*[^.]{0,50}(ledde|omsattes|blev)[^.]{0,40}nästa steg/i,
  "strength:visit_booked": /(besök|provkörning)\S*[^.]{0,40}(bokades|bekräftades|bokad)/i,
  "strength:questions_answered": /frågor\S*[^.]{0,30}besvarades/i,
  "strength:alternative_offered": /alternativ[^.]{0,30}erbj/i,
  "opportunity:unanswered_questions": /frågor[^.]{0,50}(utan (ett )?synligt svar|saknade (ett )?synligt svar|obesvarade|inte besvarades|utan att alla)/i,
  "opportunity:competitor_offer": /konkurrer/i,
  "opportunity:visit_interest": /besöksintresse/i,
  "opportunity:sold_without_alternative": /såld[^.]{0,50}alternativ/i,
  "opportunity:purchase_signal": /köpsignal/i,
  undetermined: /går inte att avgöra|inte (gick|går) att avgöra/i,
  waiting_customer: /vänta på svar|kunden (skrev|hade skrivit) sist/i,
  no_reply_open: /öppna leads utan|tråden är (fortfarande )?öppen/i,
};

const CONTINUATION_LABELS = {
  visible: "fortsättningen syns i HubSpot",
  not_determinable: "fortsättningen går inte att avgöra från HubSpot",
  stated_other_channel: "säljaren angav telefon, möte eller annat system – det som hände där syns inte",
} as const;

export interface BriefInput {
  state: LeadChatState;
  intents: LeadIntent[];
  examples: ExampleRequest | null;
  /** "Region Alingsås", "Alingsås Volkswagen PB", "Alla leads du har tillgång till". */
  selection: string;
  /**
   * The selection the previous answer was about, when this question widened it ("resten", "övriga").
   * It is always part of the new selection, so its figures come from the same rows – nothing more is loaded.
   */
  widenedFrom?: { label: string; sellerId: string | null; inboxIds: string[] } | null;
  /** The selection's type: what a widening question would mean. */
  scopeType: "all" | "region" | "inbox";
  inboxes: { id: string; name: string }[];
  seller: { id: string; name: string } | null;
  period: Period;
  previous: Period | null;
  rows: LeadRow[];
  /** Null when the previous period is not needed (no comparison). */
  prevRows: LeadRow[] | null;
  coverage: CoverageInfo;
  prevCoverage: CoverageInfo | null;
  /** Null when no module needs the AI classifications. */
  analyses: Map<string, StoredAnalysis> | null;
  analysisVersion: string;
  /** Facts earlier answers in the conversation used (names, not aliases), still visible to the user. */
  earlierFacts?: VerifiedFact[];
  /** A short note that the user can fill a gap with a button under the answer (never started by Folke). */
  actionNote?: string | null;
  /** Findings of a stored combined analysis for exactly this selection and period, if any. */
  runFindings: { title: string; text: string; kind: string; threadIds: string[] }[] | null;
  pseudonyms: Pseudonyms;
  threadUrlTemplate: string | null;
  now: Date;
}

export interface Brief {
  text: string;
  /** Numbered leads: leads[n - 1] is [n] in the brief. */
  leads: (LeadSourceReference & { types: string[] })[];
  /**
   * `quote`: the figure as the brief states it ("13 av 82"); `mention`: how an answer names it. An
   * answer that uses either gets the set ("Visa alla N"), whether or not it cites a lead.
   */
  sets: (LeadSetReference & { types: string[]; quote: string | null; mention: RegExp | null })[];
  /** Every figure in the brief, as a fact with its selection and period (an answer's are stored with it). */
  facts: VerifiedFact[];
  basis: LeadBasisReference;
  metrics: readonly Metric[];
  modules: ModuleId[];
  /** Deterministic answer from the figures (AI off, or as a fallback). */
  fallback: string;
  stats: { rows: number; prevRows: number; analyses: number; leads: number; chars: number; approxTokens: number };
}

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

function dateLabel(iso: string) {
  const t = stockholmTime(new Date(iso));
  return `${t.day} ${SHORT_MONTHS[t.month - 1]}`;
}

function isoDate(iso: string) {
  const t = stockholmTime(new Date(iso));
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function attr(value: string) {
  return value.replace(/["<>\n]/g, " ").trim();
}

/** Stored texts are data: they may not open or close tags in the brief. */
function data(text: string, { keepSellerTokens = false }: { keepSellerTokens?: boolean } = {}) {
  // A combined analysis stores sellers as {{A-…}}: kept here and mapped to the chat's aliases by the caller.
  return (keepSellerTokens ? text.replace(/Säljare \d+/g, "säljaren") : neutralizeStoredAliases(text)).replace(/<\s*\/?\s*(lead|underlag|mått)/gi, "($1").replace(/\s+/g, " ").trim();
}

function vehicleOf(r: LeadRow) {
  return [r.vehicleBrand, r.vehicleModel].filter(Boolean).join(" ") || null;
}

function handledBy(sellerId: string) {
  return (r: LeadRow) => r.ownerId === sellerId || r.responderId === sellerId;
}

function repliedRows(rows: LeadRow[]) {
  return rows.filter((r) => r.status === "registered_reply" && r.businessMinutes !== null && r.calendarMinutes !== null);
}

/** Dialogues the analysis could classify: a registered reply and at least one seller message. */
function eligibleRows(rows: LeadRow[]) {
  return rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0);
}

type Candidate = { row: LeadRow; a: StoredAnalysis; types: string[]; kind: "good" | "improve" };

function goodTypes(a: StoredAnalysis, focus: Set<string> | null): StrengthType[] {
  const s = a.classification.assessment;
  if (!s || s.continuation === "not_determinable") return [];
  return (s.strengths ?? []).filter((t) => !focus || focus.has(t));
}

function improveTypes(a: StoredAnalysis, focus: Set<string> | null): string[] {
  const s = a.classification.assessment;
  if (!s || s.continuation === "not_determinable") return [];
  const types: string[] = [...(s.opportunities ?? [])];
  if (!types.length && s.missedOpportunity === "yes") types.push("missed_opportunity");
  return types.filter((t) => !focus || focus.has(t));
}

/** Newest first, then by id – the same leads every time. At most two per seller and inbox when wider than one seller. */
function pick<T extends { row: LeadRow; types: string[] }>(list: T[], count: number, spread: boolean): T[] {
  const sorted = [...list].sort((x, y) => y.types.length - x.types.length || y.row.arrivedAt.localeCompare(x.row.arrivedAt) || x.row.threadId.localeCompare(y.row.threadId));
  if (!spread) return sorted.slice(0, count);
  const perSeller = new Map<string, number>();
  const perInbox = new Map<string, number>();
  const out: T[] = [];
  for (const c of sorted) {
    if (out.length >= count) break;
    const s = c.row.responderId ?? c.row.ownerId ?? "-";
    if ((perSeller.get(s) ?? 0) >= 2 || (perInbox.get(c.row.inboxId) ?? 0) >= 2) continue;
    perSeller.set(s, (perSeller.get(s) ?? 0) + 1);
    perInbox.set(c.row.inboxId, (perInbox.get(c.row.inboxId) ?? 0) + 1);
    out.push(c);
  }
  // Too few after spreading: fill up in the same order.
  for (const c of sorted) if (out.length < count && !out.includes(c)) out.push(c);
  return out;
}

export function buildBrief(input: BriefInput): Brief {
  const { rows, pseudonyms, seller, inboxes, period } = input;
  const modules = modulesFor(input.intents, !!seller);
  const reg = new MetricRegistry();
  const sections: string[] = [];
  const leads: Brief["leads"] = [];
  const sets: Brief["sets"] = [];
  const inboxName = new Map(inboxes.map((i) => [i.id, i.name]));
  const aliasOf = (id: string | null) => (id ? (pseudonyms.aliasOf.get(id) ?? "okänd säljare") : null);
  const nameOf = (id: string | null) => (id ? (pseudonyms.nameOf.get(pseudonyms.aliasOf.get(id) ?? "") ?? "Okänd användare") : null);
  const scopeForSets = { regionId: input.state.regionId, inboxId: input.state.inboxId, preset: "custom", from: period.from, to: period.to };
  const focus = input.state.focus.length ? new Set(input.state.focus) : null;
  const sellerAlias = seller ? aliasOf(seller.id)! : null;
  const sellerRows = seller ? rows.filter(handledBy(seller.id)) : null;
  const firstRows = seller ? rows.filter((r) => r.responderId === seller.id) : null;
  const leadNumber = new Map<string, number>();

  const addLead = (row: LeadRow, kind: "good" | "improve" | "fact", types: string[], reason: string | null, label: string) => {
    const existing = leadNumber.get(row.threadId);
    if (existing) return existing;
    const nr = leads.length + 1;
    leadNumber.set(row.threadId, nr);
    leads.push({
      kind: "lead",
      id: row.threadId,
      title: [dateLabel(row.arrivedAt), row.source ?? UNKNOWN_SOURCE, vehicleOf(row)].filter(Boolean).join(" · "),
      inbox: inboxName.get(row.inboxId) ?? "",
      seller: nameOf(row.responderId ?? row.ownerId),
      label,
      reason: reason ? data(reason) : null,
      origin: kind === "fact" ? "fact" : "classification",
      hubspotUrl: threadUrl(input.threadUrlTemplate, row.threadId),
      types,
    });
    return nr;
  };

  const leadTag = (nr: number, row: LeadRow, extra: Record<string, string | null>, reason: string | null) => {
    const attrs: [string, string | null][] = [
      ["nr", String(nr)],
      ["inkom", isoDate(row.arrivedAt)],
      ["inkorg", inboxName.get(row.inboxId) ?? null],
      ["källa", row.source ?? UNKNOWN_SOURCE],
      ["bil", vehicleOf(row)],
      ["säljare", aliasOf(row.responderId ?? row.ownerId)],
      ...Object.entries(extra),
    ];
    const a = attrs.filter((x): x is [string, string] => !!x[1]).map(([k, v]) => `${k}="${attr(v)}"`).join(" ");
    return `<lead ${a}>${reason ? data(reason) : ""}</lead>`;
  };

  // --- Header (always) ------------------------------------------------------
  const cov = input.coverage;
  const todayOnly = !cov.complete && period.to === isoDate(input.now.toISOString()) && cov.missing.every((m) => m.coveredDays >= cov.totalDays - 1);
  const coverageLine = cov.complete
    ? `Hela perioden är hämtad från HubSpot för alla ${cov.inboxes} inkorgar i urvalet.`
    : todayOnly
      ? "Hela perioden utom i dag är hämtad från HubSpot. Leads som kommit in i dag kan saknas; nämn det bara om det spelar roll för frågan."
    : `OBS: perioden är inte hämtad i sin helhet – ${cov.completeInboxes} av ${cov.inboxes} inkorgar har hela perioden (${cov.coveredDays} av ${cov.totalDays} dagar för alla). Siffrorna kan vara ofullständiga; säg det och dra inga slutsatser om förändringar.`;
  sections.push(
    [
      "## Urval",
      `- Urval: ${input.selection}${input.scopeType !== "inbox" ? ` (${inboxes.length} ${inboxes.length === 1 ? "inkorg" : "inkorgar"})` : ""}`,
      seller ? `- Säljare: ${sellerAlias}` : null,
      `- Period: ${period.from} – ${period.to} (${period.label})`,
      input.widenedFrom
        ? `- Urvalet har vidgats: det tidigare svaret gällde ${input.widenedFrom.label}, det här underlaget gäller ${input.selection}${seller ? ` och ${sellerAlias}` : ""}. En fråga som "är det samma för resten?" betyder: gäller samma mått och mönster i det nya urvalet som i det tidigare? Svara direkt på det genom att jämföra måtten för det nya urvalet med samma mått för det tidigare urvalet (längre ned). Ange populationen för varje siffra och blanda dem inte.`
        : null,
      `- ${coverageLine}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // --- Key figures (HubSpot facts) -------------------------------------------
  const keyFigures = (list: LeadRow[], title: string) => {
    const m = leadMetrics(list);
    const lines = [
      reg.add({ label: "Leads", value: m.leads, population: POPULATIONS.leads, origin: "fakta" }),
      reg.add({ label: "Leads med registrerat säljsvar", value: m.registeredReply, of: m.leads, population: POPULATIONS.leads, origin: "fakta" }),
      reg.add({ label: "Leads utan registrerat säljsvar i HubSpot", value: m.noRegisteredReply, of: m.leads, population: POPULATIONS.leads, origin: "fakta", definition: "svaret kan ha skett per telefon eller i annat system" }),
      m.uncertain ? reg.add({ label: "Leads där säljsvaret inte kunde avgöras", value: m.uncertain, of: m.leads, population: POPULATIONS.leads, origin: "fakta" }) : null,
      reg.add({ label: "Median svarstid, arbetstid", value: formatMinutes(m.medianBusinessMinutes), population: POPULATIONS.replied, origin: "fakta", definition: "tid till första registrerade säljsvar, räknat i kontorstid" }),
      reg.add({ label: "Median svarstid, kalendertid", value: formatMinutes(m.medianCalendarMinutes), population: POPULATIONS.replied, origin: "fakta" }),
      reg.add({ label: "Första registrerade säljsvar inom 1 arbetstimme", value: m.withinOneBusinessHour, of: m.registeredReply, population: POPULATIONS.replied, origin: "fakta" }),
      reg.add({ label: "Leads som kom in utanför kontorstid", value: m.outsideBusinessHours, of: m.leads, population: POPULATIONS.leads, origin: "fakta" }),
    ].filter((x): x is Metric => !!x);
    return `## ${title} (HubSpot-fakta)\n${lines.map(renderMetric).join("\n")}`;
  };
  if (modules.has("keyFigures")) sections.push(keyFigures(rows, seller ? `Nyckeltal för hela urvalet (referens, inte bara ${sellerAlias})` : "Nyckeltal"));

  // --- Seller (HubSpot facts) -----------------------------------------------
  if (seller && sellerRows && firstRows) {
    const replied = repliedRows(firstRows);
    const med = median(replied.map((r) => r.businessMinutes!));
    const lines = [
      reg.add({ label: `Leads där ${sellerAlias} är nuvarande ägare i HubSpot`, value: rows.filter((r) => r.ownerId === seller.id).length, of: rows.length, population: POPULATIONS.leads, origin: "fakta" }),
      reg.add({ label: `Leads där ${sellerAlias} gav det första registrerade säljsvaret`, value: firstRows.length, of: rows.length, population: POPULATIONS.leads, origin: "fakta" }),
      reg.add({ label: `Median svarstid, arbetstid, för ${sellerAlias}`, value: formatMinutes(med), population: POPULATIONS.firstResponder, origin: "fakta", definition: `n = ${replied.length}` }),
      reg.add({ label: `Första svar inom 1 arbetstimme för ${sellerAlias}`, value: replied.filter((r) => r.businessMinutes! <= 60).length, of: replied.length, population: POPULATIONS.firstResponder, origin: "fakta" }),
    ];
    const note =
      firstRows.length < SMALL_SAMPLE_SELLER
        ? `\n- Litet underlag: färre än ${SMALL_SAMPLE_SELLER} första svar för ${sellerAlias}. Visa siffrorna men dra inga slutsatser om svarstid eller mönster.`
        : "";
    const ownerOnly = rows.filter((r) => r.ownerId === seller.id && r.responderId && r.responderId !== seller.id).length;
    const ownerNote = ownerOnly ? `\n- ${ownerOnly} av leadsen där ${sellerAlias} är ägare fick sitt första registrerade säljsvar från någon annan.` : "";
    sections.push(`## ${sellerAlias} (HubSpot-fakta)\n${lines.map(renderMetric).join("\n")}${note}${ownerNote}\n- Ägare kan ha ändrats i efterhand; ägarskap och första svar är olika populationer och ska inte blandas.`);
  }

  // --- Response times (HubSpot facts) ---------------------------------------
  if (modules.has("responseTimes")) {
    const base = firstRows ?? rows;
    const population = seller ? POPULATIONS.firstResponder : POPULATIONS.replied;
    const replied = repliedRows(base);
    const buckets = RESPONSE_BUCKETS.map((b) => `${b.label}: ${replied.filter((r) => responseBucket(r) === b.id).length}`).join(" · ");
    const windows = (
      [
        ["inom kontorstid", "business_hours"],
        ["vardag utanför kontorstid", "weekday_off_hours"],
        ["helg", "weekend"],
      ] as const
    ).map(([label, w]) => {
      const list = replied.filter((r) => r.arrivalWindow === w);
      return `${label}: median ${formatMinutes(median(list.map((r) => r.businessMinutes!)))} arbetstid (n = ${list.length}${list.length < SMALL_GROUP ? ", litet underlag" : ""})`;
    });
    const lines = [
      `- Fördelning av första registrerade säljsvar (arbetstid; population: ${population}, n = ${replied.length}): ${buckets}`,
      `- "Besvarat före kontorstid" betyder att leadet kom utanför kontorstid och fick svar innan kontorstiden började (0 arbetsminuter).`,
      `- Median per tidpunkt när leadet kom in: ${windows.join("; ")}`,
    ];
    if (!seller && input.scopeType !== "inbox") {
      const perInbox = inboxes.map((i) => {
        const list = replied.filter((r) => r.inboxId === i.id);
        reg.add({ label: `Median svarstid, arbetstid, i ${i.name}`, value: formatMinutes(median(list.map((r) => r.businessMinutes!))), population: `leads med registrerat säljsvar i ${i.name}`, origin: "fakta", definition: `n = ${list.length}` });
        return `${i.name}: median ${formatMinutes(median(list.map((r) => r.businessMinutes!)))} (n = ${list.length}${list.length < SMALL_GROUP ? ", litet underlag" : ""})`;
      });
      lines.push(`- Median svarstid arbetstid per inkorg (population: ${POPULATIONS.replied}): ${perInbox.join("; ")}`);
    }
    if (!seller) {
      const open = rows.filter((r) => r.status === "no_registered_reply" && r.threadOpen).length;
      lines.push(renderMetric(reg.add({ label: "Öppna leads utan registrerat säljsvar", value: open, of: rows.length, population: POPULATIONS.leads, origin: "fakta" })));
    }
    // Slowest replies as examples when the question asks for them (facts, not classifications).
    if (modules.has("examples") && input.intents.includes("response_time")) {
      const slow = [...replied].sort((a, b) => b.businessMinutes! - a.businessMinutes! || a.threadId.localeCompare(b.threadId)).slice(0, input.examples?.count ?? 3);
      lines.push("- Exempel på de längsta svarstiderna:");
      for (const r of slow) {
        const label = `Svarstid ${formatMinutes(r.businessMinutes)} arbetstid`;
        const nr = addLead(r, "fact", [], null, label);
        lines.push(`  ${leadTag(nr, r, { svarstid: formatMinutes(r.businessMinutes), ursprung: "fakta" }, null)}`);
      }
    }
    sections.push(`## Svarstider${seller ? ` för ${sellerAlias}` : ""} (HubSpot-fakta)\n${lines.join("\n")}`);
  }

  // --- Sources (HubSpot facts) -----------------------------------------------
  if (modules.has("sources")) {
    const base = sellerRows ?? rows;
    const population = seller ? `leads där ${sellerAlias} är ägare eller gav första svaret` : POPULATIONS.leads;
    const lines = sourceRows(base).map((s) => {
      const list = base.filter((r) => (r.source ?? UNKNOWN_SOURCE) === s.name);
      const replied = repliedRows(list);
      const registered = list.filter((r) => r.status === "registered_reply").length;
      reg.add({ label: `Leads från ${s.name}`, value: s.leads, of: base.length, population, origin: "fakta" });
      reg.add({ label: `Leads från ${s.name} med registrerat säljsvar`, value: registered, of: s.leads, population: `leads från ${s.name}`, origin: "fakta" });
      reg.add({ label: `Median svarstid, arbetstid, för leads från ${s.name}`, value: formatMinutes(median(replied.map((r) => r.businessMinutes!))), population: `leads från ${s.name} med registrerat säljsvar`, origin: "fakta" });
      return `- ${s.name}: ${s.leads} av ${base.length} leads; registrerat säljsvar ${registered} av ${s.leads}; median svarstid arbetstid ${formatMinutes(median(replied.map((r) => r.businessMinutes!)))} (n = ${replied.length}${replied.length < SMALL_GROUP ? ", litet underlag" : ""})`;
    });
    sections.push(`## Leadskällor (HubSpot-fakta; population: ${population})\n${lines.join("\n") || "- Inga leads."}`);
  }

  // --- Virtuell (HubSpot facts) ----------------------------------------------
  if (modules.has("virtual")) {
    const base = sellerRows ?? rows;
    const virtual = base.filter((r) => r.regnrKind === "virtual");
    const plate = base.filter((r) => r.regnrKind === "plate");
    const v = repliedRows(virtual);
    const p = repliedRows(plate);
    const lines = [
      renderMetric(reg.add({ label: 'Leads med registreringsnummer "Virtuell" i formuläret', value: virtual.length, of: base.length, population: POPULATIONS.leads, origin: "fakta", definition: "förekommer ofta för annonser utan fysisk bil i lager, men är en signal, inte en säker fordonsstatus" })),
      `- Median svarstid arbetstid: Virtuell ${formatMinutes(median(v.map((r) => r.businessMinutes!)))} (n = ${v.length}), riktigt registreringsnummer ${formatMinutes(median(p.map((r) => r.businessMinutes!)))} (n = ${p.length}); population: ${POPULATIONS.replied}`,
    ];
    if (input.scopeType !== "inbox" && !seller) {
      lines.push(`- Per inkorg: ${inboxes.map((i) => `${i.name} ${virtual.filter((r) => r.inboxId === i.id).length} av ${base.filter((r) => r.inboxId === i.id).length}`).join("; ")}`);
    }
    const byModel = new Map<string, number>();
    for (const r of virtual) byModel.set(vehicleOf(r) ?? "Ej identifierad bil", (byModel.get(vehicleOf(r) ?? "Ej identifierad bil") ?? 0) + 1);
    const top = [...byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "sv")).slice(0, 6);
    if (top.length) lines.push(`- Vanligaste bilar bland Virtuell: ${top.map(([n, c]) => `${n} ${c}`).join("; ")}`);
    sections.push(`## Virtuella annonser (HubSpot-fakta)\n${lines.join("\n")}`);
  }

  // --- Comparison with the previous period (HubSpot facts) -------------------
  if (modules.has("comparison") && input.previous) {
    const prev = input.previous;
    if (!input.prevCoverage?.complete || !input.prevRows) {
      sections.push(
        `## Jämförelse med föregående period (${prev.from} – ${prev.to})\n- Föregående period är inte hämtad från HubSpot i sin helhet. Ingen jämförelse kan göras; säg det och föreslå att perioden hämtas i Leadanalys.`,
      );
    } else {
      const now = seller ? repliedRows(input.rows.filter((r) => r.responderId === seller.id)) : null;
      const before = seller ? repliedRows(input.prevRows.filter((r) => r.responderId === seller.id)) : null;
      const a = leadMetrics(input.rows);
      const b = leadMetrics(input.prevRows);
      const lines = seller
        ? [
            `- ${sellerAlias}, första registrerade säljsvar: ${before!.length} → ${now!.length}`,
            `- ${sellerAlias}, median svarstid arbetstid (population: ${POPULATIONS.firstResponder}): ${formatMinutes(median(before!.map((r) => r.businessMinutes!)))} → ${formatMinutes(median(now!.map((r) => r.businessMinutes!)))}`,
            `- ${sellerAlias}, inom 1 arbetstimme: ${before!.filter((r) => r.businessMinutes! <= 60).length} av ${before!.length} → ${now!.filter((r) => r.businessMinutes! <= 60).length} av ${now!.length}`,
          ]
        : [
            `- Leads: ${b.leads} → ${a.leads} (population: ${POPULATIONS.leads})`,
            `- Leads med registrerat säljsvar: ${b.registeredReply} av ${b.leads} → ${a.registeredReply} av ${a.leads}`,
            `- Median svarstid arbetstid (population: ${POPULATIONS.replied}): ${formatMinutes(b.medianBusinessMinutes)} → ${formatMinutes(a.medianBusinessMinutes)}`,
            `- Median svarstid kalendertid: ${formatMinutes(b.medianCalendarMinutes)} → ${formatMinutes(a.medianCalendarMinutes)}`,
            `- Första svar inom 1 arbetstimme: ${b.withinOneBusinessHour} av ${b.registeredReply} → ${a.withinOneBusinessHour} av ${a.registeredReply}`,
          ];
      const prevLabel = `${periodLabel(prev.from, prev.to)} (föregående period)`;
      if (seller) {
        const med = (l: LeadRow[]) => formatMinutes(median(l.map((r) => r.businessMinutes!)));
        reg.add({ label: `Median svarstid, arbetstid, för ${sellerAlias}`, value: med(before!), population: POPULATIONS.firstResponder, origin: "fakta", period: prevLabel });
        reg.add({ label: `Första svar inom 1 arbetstimme för ${sellerAlias}`, value: before!.filter((r) => r.businessMinutes! <= 60).length, of: before!.length, population: POPULATIONS.firstResponder, origin: "fakta", period: prevLabel });
      } else {
        reg.add({ label: "Leads", value: b.leads, population: POPULATIONS.leads, origin: "fakta", period: prevLabel });
        reg.add({ label: "Leads med registrerat säljsvar", value: b.registeredReply, of: b.leads, population: POPULATIONS.leads, origin: "fakta", period: prevLabel });
        reg.add({ label: "Median svarstid, arbetstid", value: formatMinutes(b.medianBusinessMinutes), population: POPULATIONS.replied, origin: "fakta", period: prevLabel });
        reg.add({ label: "Första registrerade säljsvar inom 1 arbetstimme", value: b.withinOneBusinessHour, of: b.registeredReply, population: POPULATIONS.replied, origin: "fakta", period: prevLabel });
      }
      const small = (seller ? Math.min(now!.length, before!.length) : Math.min(a.leads, b.leads)) < SMALL_GROUP;
      sections.push(
        `## Jämförelse: föregående period ${prev.from} – ${prev.to} → vald period (HubSpot-fakta)\n${lines.join("\n")}${small ? "\n- Litet underlag i minst en av perioderna: beskriv förändringen försiktigt." : ""}\n- Hela föregående period är hämtad.`,
      );
    }
  }

  // --- AI classifications ------------------------------------------------------
  const analyses = input.analyses;
  const scopeAnalysed = (list: LeadRow[]) => (analyses ? eligibleRows(list).filter((r) => analyses.has(r.threadId)) : []);
  const analysedRows = scopeAnalysed(firstRows ?? rows);
  const analysedPopulation = seller ? POPULATIONS.analysedSeller : POPULATIONS.analysed;
  const eligibleCount = eligibleRows(firstRows ?? rows).length;
  const shownTypes: { type: string; label: string; kind: "good" | "improve" }[] = [];

  if (modules.has("observations") && analyses) {
    const insights = buildInsights(sellerRows ?? rows, analyses, input.now);
    for (const i of insights) {
      if (!i.filter || sets.some((x) => x.id === i.filter)) continue;
      const ids = (sellerRows ?? rows).filter((r) => matches(i.filter as EvidenceFilter, r, analyses.get(r.threadId), input.now)).map((r) => r.threadId);
      if (ids.length) {
        sets.push({ kind: "lead_set", id: i.filter, title: i.title, count: ids.length, threadIds: ids.slice(0, 300), scope: scopeForSets, types: [], quote: /^(\d+ av \d+)/.exec(i.basis ?? "")?.[1] ?? null, mention: MENTIONS[i.filter] ?? null });
      }
    }
    const lines = insights.map((i) => `- [${i.kind === "fact" ? "HubSpot-fakta" : "AI-klassificering"}] ${i.title}: ${data(i.body)}`);
    sections.push(`## Observationer från Leadanalys\n${lines.join("\n") || "- Inga observationer passerar Leadanalys trösklar för urvalet."}`);
  }

  if (modules.has("patterns") && analyses) {
    const total = analysedRows.length;
    const count = (f: (a: StoredAnalysis) => boolean) => analysedRows.filter((r) => f(analyses.get(r.threadId)!)).length;
    const lines: string[] = [
      renderMetric(reg.add({ label: "AI-analyserade dialoger", value: total, of: eligibleCount, population: seller ? `leads där ${sellerAlias} gav första svaret, med registrerat säljsvar och minst ett säljarmeddelande` : "leads med registrerat säljsvar och minst ett säljarmeddelande i urvalet", origin: "klassificering", definition: `analysmetod ${input.analysisVersion}` })),
    ];
    if (total < MIN_ANALYSED) lines.push(`- Litet underlag: färre än ${MIN_ANALYSED} AI-analyserade dialoger. Beskriv enskilda exempel men dra inga slutsatser om mönster.`);
    // Where the analysis exists: a region can be analysed in one inbox only.
    if (input.scopeType !== "inbox" && !seller) {
      const perInbox = inboxes
        .map((i) => ({ name: i.name, analysed: analysedRows.filter((r) => r.inboxId === i.id).length, eligible: eligibleRows(rows.filter((r) => r.inboxId === i.id)).length }))
        .filter((x) => x.eligible > 0);
      lines.push(`- AI-analyserade dialoger per inkorg (av möjliga): ${perInbox.map((x) => `${x.name} ${x.analysed} av ${x.eligible}`).join("; ")}. Mönstren gäller bara de analyserade dialogerna.`);
    }
    const typeLine = (label: string, type: string, n: number, kind: "good" | "improve") => {
      const ids = analysedRows.filter((r) => (kind === "good" ? goodTypes(analyses.get(r.threadId)!, null) : improveTypes(analyses.get(r.threadId)!, null)).includes(type as never)).map((r) => r.threadId);
      const setId = `${kind === "good" ? "strength" : "opportunity"}:${type}`;
      if (n > 0) {
        const existing = sets.findIndex((x) => x.id === setId);
        if (existing >= 0) sets.splice(existing, 1);
        sets.push({ kind: "lead_set", id: setId, title: label, count: ids.length, threadIds: ids.slice(0, 300), scope: scopeForSets, types: [type], quote: `${n} av ${total}`, mention: MENTIONS[setId] ?? null });
      }
      const examples = pick(
        analysedRows.filter((r) => ids.includes(r.threadId)).map((row) => ({ row, types: [type] })),
        PATTERN_EXAMPLES,
        !seller,
      );
      const tags = examples.map(({ row }) => {
        const a = analyses.get(row.threadId)!;
        const s = a.classification.assessment;
        const reason = kind === "good" ? [s?.goal, s?.progressReason].filter(Boolean).join(" – ") : s?.missedReason || s?.progressReason || null;
        const nr = addLead(row, kind, [type], reason, kind === "good" ? "Fungerade" : "Möjlighet att utveckla");
        return `  ${leadTag(nr, row, { typ: kind === "good" ? "fungerade" : "möjlighet", fortsättning: s?.continuation ? CONTINUATION_LABELS[s.continuation] : null }, reason)}`;
      });
      return [renderMetric(reg.add({ label, value: n, of: total, population: analysedPopulation, origin: "klassificering" })), ...tags].join("\n");
    };
    const strengths = STRENGTH_TYPES.filter((t) => !focus || focus.has(t)).map((t) => ({ t, n: count((a) => goodTypes(a, null).includes(t)) }));
    const opportunities = OPPORTUNITY_TYPES.filter((t) => !focus || focus.has(t)).map((t) => ({ t, n: count((a) => improveTypes(a, null).includes(t)) }));
    shownTypes.push(...strengths.filter((s) => s.n > 0).map((s) => ({ type: s.t as string, label: STRENGTH_LABELS[s.t], kind: "good" as const })));
    shownTypes.push(...opportunities.filter((s) => s.n > 0).map((s) => ({ type: s.t as string, label: OPPORTUNITY_LABELS[s.t], kind: "improve" as const })));
    const strengthLines = strengths.filter((s) => s.n > 0).sort((a, b) => b.n - a.n).map((s) => typeLine(STRENGTH_LABELS[s.t], s.t, s.n, "good"));
    const opportunityLines = opportunities.filter((s) => s.n > 0).sort((a, b) => b.n - a.n).map((s) => typeLine(OPPORTUNITY_LABELS[s.t], s.t, s.n, "improve"));
    lines.push("### Det som fungerar (AI-klassificering, synligt i dialogen)", ...(strengthLines.length ? strengthLines : ["- Inga styrkor klassificerade i urvalet."]));
    lines.push("### Möjligheter att utveckla (AI-klassificering, synligt i dialogen)", ...(opportunityLines.length ? opportunityLines : ["- Inga möjligheter klassificerade i urvalet."]));
    const cont = (c: string) => count((a) => a.classification.assessment?.continuation === c);
    lines.push(
      "### Fortsättning efter dialogen (AI-klassificering)",
      renderMetric(reg.add({ label: "Fortsättningen syns i HubSpot", value: cont("visible"), of: total, population: analysedPopulation, origin: "klassificering" })),
      renderMetric(reg.add({ label: "Fortsättningen går inte att avgöra från HubSpot", value: cont("not_determinable"), of: total, population: analysedPopulation, origin: "klassificering", definition: "t.ex. offert från säljsystemet, ett samtal eller en process som stannade – Folke kan inte avgöra vilket, och det är inte ett fel" })),
      renderMetric(reg.add({ label: "Säljaren angav telefon, möte eller annat system", value: cont("stated_other_channel"), of: total, population: analysedPopulation, origin: "klassificering" })),
      renderMetric(reg.add({ label: "Överenskommet nästa steg", value: count((a) => !!a.classification.assessment?.agreedNextStep), of: total, population: analysedPopulation, origin: "klassificering" })),
    );
    if (input.runFindings?.length && !seller && !focus) {
      lines.push(
        "### Sparad sammanvägning för samma urval och period (AI-klassificering)",
        ...input.runFindings.slice(0, 5).map((f) => `- ${aliasSellerTokens(data(f.title, { keepSellerTokens: true }), pseudonyms)}: ${aliasSellerTokens(data(f.text, { keepSellerTokens: true }), pseudonyms)} (${f.threadIds.length} dialoger)`),
      );
    }
    sections.push(`## Mönster i de AI-analyserade dialogerna\n${lines.join("\n")}`);
  }

  if (modules.has("examples") && analyses && !(input.intents.includes("response_time") && modules.has("responseTimes"))) {
    const req = input.examples ?? { polarity: "both" as const, count: 3 };
    const candidates: Candidate[] = analysedRows.flatMap((row): Candidate[] => {
      const a = analyses.get(row.threadId)!;
      const good = goodTypes(a, focus);
      const improve = improveTypes(a, focus);
      return [...(good.length ? [{ row, a, types: good as string[], kind: "good" as const }] : []), ...(improve.length ? [{ row, a, types: improve, kind: "improve" as const }] : [])];
    });
    const goodCount = req.polarity === "good" ? req.count : req.polarity === "improve" ? 0 : Math.ceil(req.count / 2);
    const improveCount = req.count - goodCount;
    const chosen = [
      ...pick(candidates.filter((c) => c.kind === "good"), goodCount, !seller),
      ...pick(candidates.filter((c) => c.kind === "improve" && !leadNumber.has(c.row.threadId)), improveCount, !seller),
    ];
    const lines = chosen.map((c) => {
      const s = c.a.classification.assessment;
      const reason = c.kind === "good" ? [s?.goal, s?.progressReason].filter(Boolean).join(" – ") : s?.missedReason || s?.progressReason || null;
      const typeLabels = c.types.map((t) => (STRENGTH_LABELS as Record<string, string>)[t] ?? (OPPORTUNITY_LABELS as Record<string, string>)[t] ?? "Missad möjlighet");
      const nr = addLead(c.row, c.kind, c.types, reason, c.kind === "good" ? "Fungerade" : "Möjlighet att utveckla");
      return leadTag(nr, c.row, { typ: c.kind === "good" ? "fungerade" : "möjlighet", typer: typeLabels.join("; "), fortsättning: s?.continuation ? CONTINUATION_LABELS[s.continuation] : null }, reason);
    });
    for (const kind of ["good", "improve"] as const) {
      const ids = [...new Set(candidates.filter((c) => c.kind === kind).map((c) => c.row.threadId))];
      if ((kind === "good" ? goodCount : improveCount) > 0 && ids.length) {
        sets.push({ kind: "lead_set", id: `examples:${kind}`, title: kind === "good" ? "Dialoger där något fungerade" : "Dialoger med möjligheter att utveckla", count: ids.length, threadIds: ids.slice(0, 300), scope: scopeForSets, types: [], quote: null, mention: null });
      }
    }
    const missing = chosen.length < req.count ? `\n- Bara ${chosen.length} exempel passar frågan i urvalet${focus ? " (samma typ som tidigare)" : ""}. Säg det hellre än att fylla ut.` : "";
    sections.push(
      `## Exempel (AI-klassificering; dialoger där fortsättningen inte går att avgöra är inte med)\n${lines.join("\n") || "- Inga dialoger i urvalet passar."}${missing}`,
    );
  }

  if (needsAnalyses(modules) && analyses && !analysedRows.length) {
    sections.push(`## AI-klassificering saknas\n- Det finns inga AI-analyserade dialoger (${input.analysisVersion}) i urvalet för perioden. Svara utifrån HubSpot-fakta och säg att AI-analysen inte är gjord.`);
  }

  // --- The previous, narrower selection (widening) -----------------------------
  if (input.widenedFrom) {
    const w = input.widenedFrom;
    const label = w.label;
    const within = rows.filter((r) => w.inboxIds.includes(r.inboxId));
    const sub = w.sellerId ? within.filter((r) => r.responderId === w.sellerId) : within;
    const lines: string[] = [];
    if (modules.has("keyFigures") || modules.has("responseTimes")) {
      const replied = repliedRows(sub);
      const population = w.sellerId ? POPULATIONS.firstResponder : POPULATIONS.replied;
      reg.add({ label: "Median svarstid, arbetstid", value: formatMinutes(median(replied.map((r) => r.businessMinutes!))), population, origin: "fakta", selection: label });
      reg.add({ label: "Första registrerade säljsvar inom 1 arbetstimme", value: replied.filter((r) => r.businessMinutes! <= 60).length, of: replied.length, population, origin: "fakta", selection: label });
      lines.push(
        w.sellerId ? `- Leads där säljaren gav det första registrerade säljsvaret: ${sub.length}` : `- Leads: ${sub.length} (population: ${POPULATIONS.leads})`,
        `- Median svarstid, arbetstid: ${formatMinutes(median(replied.map((r) => r.businessMinutes!)))} (population: ${population}, n = ${replied.length})`,
        `- Första registrerade säljsvar inom 1 arbetstimme: ${replied.filter((r) => r.businessMinutes! <= 60).length} av ${replied.length} (population: ${population})`,
      );
    }
    if (analyses && shownTypes.length) {
      const subAnalysed = eligibleRows(sub).filter((r) => analyses.has(r.threadId));
      const t = subAnalysed.length;
      const population = w.sellerId ? POPULATIONS.analysedSeller : POPULATIONS.analysed;
      lines.push(`- AI-analyserade dialoger: ${t}`);
      for (const s of shownTypes) {
        const n = subAnalysed.filter((r) => (s.kind === "good" ? goodTypes(analyses.get(r.threadId)!, null) : improveTypes(analyses.get(r.threadId)!, null)).includes(s.type as never)).length;
        reg.add({ label: s.label, value: n, of: t, population, origin: "klassificering", selection: label });
        lines.push(`- ${s.label}: ${n} av ${t} (population: ${population})`);
      }
      if (t < MIN_ANALYSED) lines.push(`- Litet underlag i det tidigare urvalet: jämför försiktigt.`);
    }
    if (lines.length) sections.push(`## Samma mått för det tidigare urvalet (${label}) – del av urvalet ovan, för jämförelse\n${lines.join("\n")}`);
    // "Resten" after a seller: the same measures for everyone else in the selection.
    if (w.sellerId && lines.length) {
      const rest = within.filter((r) => r.responderId !== w.sellerId);
      const restLines: string[] = [];
      if (modules.has("keyFigures") || modules.has("responseTimes")) {
        const replied = repliedRows(rest);
        restLines.push(
          `- Median svarstid, arbetstid: ${formatMinutes(median(replied.map((r) => r.businessMinutes!)))} (population: leads med registrerat säljsvar där någon annan gav det första svaret, n = ${replied.length})`,
          `- Första registrerade säljsvar inom 1 arbetstimme: ${replied.filter((r) => r.businessMinutes! <= 60).length} av ${replied.length}`,
        );
      }
      if (analyses && shownTypes.length) {
        const restAnalysed = eligibleRows(rest).filter((r) => analyses.has(r.threadId));
        restLines.push(`- AI-analyserade dialoger där någon annan gav det första svaret: ${restAnalysed.length}`);
        for (const s of shownTypes) {
          const n = restAnalysed.filter((r) => (s.kind === "good" ? goodTypes(analyses.get(r.threadId)!, null) : improveTypes(analyses.get(r.threadId)!, null)).includes(s.type as never)).length;
          restLines.push(`- ${s.label}: ${n} av ${restAnalysed.length}`);
        }
      }
      sections.push(`## Övriga i urvalet (utan ${label.split(" i ")[0]}) – samma mått\n${restLines.join("\n")}`);
    }
  }

  // --- Verified facts from earlier answers -------------------------------------------
  const selectionLabel = `${input.selection}${seller ? ` · ${seller.name}` : ""}`;
  const periodText = period.label === periodLabel(period.from, period.to) ? period.label : `${periodLabel(period.from, period.to)} (${period.label})`;
  const facts = currentFacts(reg.all, { selection: selectionLabel, period: periodText, scope: { regionId: input.state.regionId, inboxId: input.state.inboxId, sellerId: input.state.sellerId } }, pseudonyms.reveal);
  const earlier = input.earlierFacts?.length ? earlierFactsSection(input.earlierFacts, facts, pseudonyms.hide) : null;
  if (earlier) sections.push(earlier);
  if (input.actionNote) sections.push(`## Åtgärd som användaren kan välja\n- ${input.actionNote} Nämn det kort om det hjälper. Starta inget själv och skriv inga länkar.`);

  // --- Basis (shown under the answer, written by the server) ---------------
  const basisLines = [
    cov.complete
      ? `Hela perioden hämtad från HubSpot (${cov.inboxes} ${cov.inboxes === 1 ? "inkorg" : "inkorgar"}).`
      : todayOnly
        ? "Hela perioden utom i dag hämtad från HubSpot."
      : `Perioden är inte hämtad i sin helhet: ${cov.completeInboxes} av ${cov.inboxes} inkorgar har hela perioden.`,
    `${rows.length} leads i urvalet${seller ? `, varav ${firstRows!.length} där ${seller.name} gav det första registrerade säljsvaret` : ""}.`,
    ...(analyses ? [`${analysedRows.length} AI-analyserade dialoger (${input.analysisVersion}) av ${eligibleCount} möjliga.`] : []),
    ...(modules.has("comparison") && input.previous
      ? [input.prevCoverage?.complete ? `Jämförelse med ${periodLabel(input.previous.from, input.previous.to)}.` : `Föregående period (${periodLabel(input.previous.from, input.previous.to)}) är inte hämtad – ingen jämförelse.`]
      : []),
    "Svaret bygger på data som redan finns i Leadanalys. Ingen ny hämtning från HubSpot och ingen ny AI-analys gjordes.",
  ];
  const basis: LeadBasisReference = {
    kind: "lead_basis",
    id: "basis",
    selection: selectionLabel,
    period: periodText,
    lines: basisLines,
  };

  const text = sections.join("\n\n");
  return {
    text,
    leads,
    sets,
    basis,
    metrics: reg.all,
    facts,
    modules: [...modules],
    fallback: fallbackAnswer(input, reg.all, sellerAlias),
    stats: {
      rows: rows.length,
      prevRows: input.prevRows?.length ?? 0,
      analyses: analysedRows.length,
      leads: leads.length,
      chars: text.length,
      approxTokens: Math.ceil(text.length / 3.5),
    },
  };
}

/** Without AI: the key figures as plain sentences (no interpretation). */
function fallbackAnswer(input: BriefInput, metrics: readonly Metric[], sellerAlias: string | null): string {
  const shown = metrics.slice(0, 10).map((m) => {
    const label = sellerAlias && input.seller ? m.label.split(sellerAlias).join(input.seller.name) : m.label;
    return `- ${label}: ${m.of !== undefined ? `${m.value} av ${m.of}` : m.value}`;
  });
  return [
    `AI-svar är inte aktiverat för Leadanalys i den här miljön. Här är siffrorna från Leadanalys för ${input.selection}${input.seller ? ` (${input.seller.name})` : ""}, ${periodLabel(input.period.from, input.period.to)}:`,
    "",
    ...(shown.length ? shown : ["- Inga nyckeltal för frågan."]),
  ].join("\n");
}
