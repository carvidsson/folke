import "server-only";

import {
  CARRIED_GROUP_LABELS,
  NEED_LABELS,
  REQUEST_LABELS,
  SIGNAL_LABELS,
  STRONG_SIGNALS,
  UNAVAILABLE_LABELS,
  carriedGroup,
  type DialogueNeeds,
  type Need,
} from "@/lib/leads/needs";
import type { LeadRow } from "@/lib/leads/types";
import type { StoredAnalysis, StoredNeeds } from "@/server/data/leads";
import { NEEDS_VERSION } from "@/server/leads/needs";
import {
  coOccurring,
  COMBINATION_MIN,
  CROSSING_MIN_GROUP,
  expressedNeeds,
  hasStrongSignal,
  itemsOf,
  matchesNeeds,
  needCombinations,
  purchaseDialogues,
  signalWithoutNextStep,
  unavailableSummary,
} from "@/server/leads/needs-stats";
import { sourceRows, UNKNOWN_SOURCE } from "@/server/leads/overview";

import { renderMetric, type Metric, type MetricRegistry } from "./metrics";

/**
 * The customer needs module of the lead brief (ADR-052): counts over stored lead-needs-1 labels –
 * deterministic, with populations – crossed with HubSpot facts (source, Virtuell, inbox), and the leads
 * behind them as sets and numbered examples. The model formulates; it never counts.
 */

/** How an answer names a figure from this module (a set is attached when the answer uses it). */
export const NEEDS_MENTIONS: Record<string, RegExp> = {
  "need:private_leasing": /privatleas/i,
  "need:business": /företag|förmånsbil|tjänstebil/i,
  "need:leasing_unspecified": /leasing[^.]{0,30}(oklart|inte (angett|sagt)|utan att)/i,
  "need:financing": /finansiering|billån|avbetalning/i,
  "need:monthly_cost": /månadskostnad/i,
  "need:trade_in": /inbyte/i,
  "need:availability": /finns kvar|lagerstatus|i lager/i,
  "need:fast_delivery": /snabb leverans|bråttom|snabbt/i,
  "need:delivery_time": /leveranstid/i,
  "need:home_delivery": /hemleverans|transport/i,
  "need:price_negotiation": /rabatt|prisförhandl|förhandl/i,
  "need:product_facts": /utrustning|skick/i,
  "need:factory_order": /beställ/i,
  "request:send_offer": /offert|kalkyl/i,
  "request:call_me": /uppringd|ringa upp|bli ringd/i,
  "request:book_visit": /provkör|besök/i,
  "request:value_trade_in": /värder|inbytespris/i,
  "request:find_alternative": /annan bil|liknande bil|bevaka/i,
  strong_signal: /köpsignal/i,
  soon: /inom kort|inom (ungefär )?en månad/i,
  unavailable: /inte (gick|går) att få|var såld|sålda|reserverad/i,
  "carried:forward": /fördes (synligt )?vidare|alternativ/i,
  "carried:not_visible": /inget sådant syns|syns inget/i,
  "carried:not_determinable": /går inte att avgöra/i,
  signal_no_next_step: /inget (tydligt )?nästa steg/i,
};

const ITEM_LABEL = (item: string): string => {
  const [kind, code] = item.split(":");
  if (kind === "need") return NEED_LABELS[code as Need];
  if (kind === "request") return `ber om: ${REQUEST_LABELS[code as keyof typeof REQUEST_LABELS].toLowerCase()}`;
  if (kind === "signal") return `köpsignal: ${SIGNAL_LABELS[code as keyof typeof SIGNAL_LABELS].toLowerCase()}`;
  return item;
};

/** "need:leasing" and "need:delivery" in a question's focus mean several needs. */
const FOCUS_ITEMS: Record<string, string[]> = {
  "need:leasing": ["need:private_leasing", "need:leasing_unspecified", "need:business"],
  "need:delivery": ["need:fast_delivery", "need:delivery_time"],
};

export interface NeedsSet {
  id: string;
  title: string;
  threadIds: string[];
  quote: string | null;
}

export interface NeedsModuleInput {
  rows: LeadRow[];
  /** Leads the seller handled, when the question is about one seller. */
  sellerRows: LeadRow[] | null;
  sellerAlias: string | null;
  scopeType: "all" | "region" | "inbox";
  inboxes: { id: string; name: string }[];
  needs: Map<string, StoredNeeds>;
  analyses: Map<string, StoredAnalysis> | null;
  focus: string[];
  examples: { count: number } | null;
  reg: MetricRegistry;
  /** Adds a numbered example lead and returns its number. */
  addLead: (row: LeadRow, types: string[], reason: string | null, label: string) => number;
  leadTag: (nr: number, row: LeadRow, extra: Record<string, string | null>, reason: string | null) => string;
}

export function needsModule(input: NeedsModuleInput): { text: string; sets: NeedsSet[] } {
  const { reg, needs, analyses } = input;
  const base = input.sellerRows ?? input.rows;
  const candidates = base.filter((r) => r.customerMessages > 0);
  const analysed = candidates.filter((r) => needs.has(r.threadId));
  const list = purchaseDialogues(candidates, needs);
  const total = list.length;
  const who = input.sellerAlias ? ` där ${input.sellerAlias} är ägare eller gav första svaret` : "";
  const population = `köpdialoger med behovsanalys${who} i urvalet`;
  const sets: NeedsSet[] = [];
  const lines: string[] = [];
  const metric = (m: Omit<Metric, "id">) => renderMetric(reg.add(m));
  const addSet = (id: string, title: string, filterRows: { row: LeadRow; n: DialogueNeeds }[], of: number) => {
    if (!filterRows.length || sets.some((s) => s.id === id)) return;
    sets.push({ id, title, threadIds: filterRows.map((x) => x.row.threadId).slice(0, 300), quote: `${filterRows.length} av ${of}` });
  };
  const having = (filter: string) => list.filter(({ row, n }) => matchesNeeds(filter, n, analyses?.get(row.threadId)));

  lines.push(
    metric({ label: "Leads med behovsanalys", value: analysed.length, of: candidates.length, population: `leads med meddelande från kunden${who} i urvalet`, origin: "klassificering", definition: `analysmetod ${NEEDS_VERSION}` }),
    metric({ label: "Köpdialoger (köp eller leasing av bil) – populationen för kundbehoven", value: total, of: analysed.length, population: `leads med behovsanalys${who}`, origin: "klassificering", definition: "övriga gäller en bil kunden redan har eller annat än köp" }),
  );
  if (analysed.length < candidates.length) {
    const per = input.scopeType !== "inbox" && !input.sellerAlias
      ? input.inboxes
          .map((i) => ({ name: i.name, a: analysed.filter((r) => r.inboxId === i.id).length, c: candidates.filter((r) => r.inboxId === i.id).length }))
          .filter((x) => x.c > 0)
          .map((x) => `${x.name} ${x.a} av ${x.c}`)
          .join("; ")
      : null;
    lines.push(`- Behovsanalysen saknas för ${candidates.length - analysed.length} leads${per ? ` (per inkorg: ${per})` : ""}. Siffrorna gäller bara de analyserade.`);
  }
  if (total < 10) lines.push("- Litet underlag: färre än 10 köpdialoger. Beskriv enskilda dialoger men dra inga slutsatser om vad som är vanligt.");

  // --- Needs, requests, signals -------------------------------------------------
  const needLines = (Object.keys(NEED_LABELS) as Need[])
    .map((code) => ({ code, hit: having(`need:${code}`) }))
    .filter((x) => x.hit.length)
    .sort((a, b) => b.hit.length - a.hit.length)
    .map(({ code, hit }) => {
      addSet(`need:${code}`, `Kundbehov: ${NEED_LABELS[code]}`, hit, total);
      return metric({ label: NEED_LABELS[code], value: hit.length, of: total, population, origin: "klassificering" });
    });
  lines.push("### Kundens uttryckta behov (AI-klassificering av kundens egna meddelanden och formulärfält)", ...(needLines.length ? needLines : ["- Inga."]));
  const requestLines = (Object.keys(REQUEST_LABELS) as (keyof typeof REQUEST_LABELS)[])
    .map((code) => ({ code, hit: having(`request:${code}`) }))
    .filter((x) => x.hit.length)
    .sort((a, b) => b.hit.length - a.hit.length)
    .map(({ code, hit }) => {
      addSet(`request:${code}`, `Kunden ber om: ${REQUEST_LABELS[code].toLowerCase()}`, hit, total);
      return metric({ label: `Kunden ber om: ${REQUEST_LABELS[code].toLowerCase()}`, value: hit.length, of: total, population, origin: "klassificering" });
    });
  lines.push("### Det kunden uttryckligen ber om", ...(requestLines.length ? requestLines : ["- Inget."]));
  const strong = having("strong_signal");
  const soon = having("soon");
  addSet("strong_signal", "Tydliga köpsignaler", strong, total);
  addSet("soon", "Vill köpa inom kort", soon, total);
  lines.push(
    "### Köpsignaler (observerbara, inga poäng)",
    metric({ label: "Köpdialoger med tydlig köpsignal", value: strong.length, of: total, population, origin: "klassificering", definition: "kunden vill köpa eller reservera, lägger bud eller frågar hur man går vidare" }),
    metric({ label: "Köpdialoger där kunden vill köpa eller behöver bilen inom ungefär en månad", value: soon.length, of: total, population, origin: "klassificering" }),
    ...(Object.keys(SIGNAL_LABELS) as (keyof typeof SIGNAL_LABELS)[])
      .map((code) => ({ code, n: having(`signal:${code}`).length }))
      .filter((x) => x.n)
      .map((x) => `- ${SIGNAL_LABELS[x.code]}: ${x.n} av ${total}`),
  );

  // --- Clear signal and the next step (with the lead analysis) ------------------------
  const wanting = list.filter(({ n }) => hasStrongSignal(n) || n.timeframe === "soon");
  if (wanting.length) {
    const withAnalysis = wanting.filter(({ row }) => analyses?.has(row.threadId));
    const noStep = wanting.filter(({ row, n }) => signalWithoutNextStep(n, analyses?.get(row.threadId)));
    const noReply = wanting.filter(({ row }) => row.status !== "registered_reply");
    addSet("signal_no_next_step", "Köpsignal utan synligt nästa steg", noStep, withAnalysis.length);
    lines.push(
      "### Tydlig köpsignal eller köp inom kort – syns ett nästa steg? (kombinerat med leadanalysen lead-ai-3.1)",
      `- Köpdialoger med tydlig köpsignal eller köp inom kort: ${wanting.length}; av dem AI-analyserade i leadanalysen: ${withAnalysis.length}; utan registrerat säljsvar i HubSpot: ${noReply.length}.`,
      metric({ label: "Tydlig köpsignal eller köp inom kort utan synligt nästa steg i HubSpot", value: noStep.length, of: withAnalysis.length, population: "köpdialoger med tydlig köpsignal eller köp inom kort som också är AI-analyserade i leadanalysen", origin: "klassificering", definition: "inget överenskommet nästa steg, inget konkret nästa steg i säljarens meddelanden och inget om telefon eller annan kanal; ett samtal eller en offert från säljsystemet syns inte" }),
    );
  }

  // --- Combinations --------------------------------------------------------------------
  const combos = needCombinations(list, 5);
  lines.push(
    `### Vanliga kombinationer av behov (bara par med minst ${COMBINATION_MIN.count} dialoger och minst ${Math.round(COMBINATION_MIN.share * 100)} % av minst ${COMBINATION_MIN.population} köpdialoger)`,
    ...(combos.length
      ? combos.map((c) => {
          const hit = having(`combo:${c.a}+${c.b}`);
          addSet(`combo:${c.a}+${c.b}`, `${NEED_LABELS[c.a]} och ${NEED_LABELS[c.b].toLowerCase()}`, hit, total);
          return metric({ label: `${NEED_LABELS[c.a]} + ${NEED_LABELS[c.b].toLowerCase()}`, value: c.count, of: total, population, origin: "klassificering" });
        })
      : ["- Ingen kombination når tröskeln i urvalet. Säg det hellre än att räkna upp små tal."]),
  );
  const focusItems = [...new Set(input.focus.flatMap((f) => FOCUS_ITEMS[f] ?? [f]).filter((f) => /^(need|request|signal):/.test(f)))];
  for (const item of focusItems.slice(0, 3)) {
    const with_ = list.filter(({ n }) => itemsOf(n).includes(item));
    if (!with_.length) {
      lines.push(`### Tillsammans med "${ITEM_LABEL(item)}"\n- Inga köpdialoger i urvalet har det.`);
      continue;
    }
    const co = coOccurring(list, item).slice(0, 6);
    lines.push(
      `### Tillsammans med "${ITEM_LABEL(item)}" (bland de ${with_.length} köpdialoger som har det)`,
      ...(co.length ? co.map((c) => `- ${ITEM_LABEL(c.item)}: ${c.count} av ${with_.length}`) : ["- Inget annat förekommer."]),
      with_.length < 10 ? "- Litet underlag: beskriv försiktigt." : "",
    );
  }

  // --- Crossed with HubSpot facts (never re-classified) ---------------------------------
  const top = (group: { n: DialogueNeeds }[]) => {
    const counts = new Map<Need, number>();
    for (const { n } of group) for (const c of new Set(expressedNeeds(n))) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, k]) => `${NEED_LABELS[c]} ${k}`).join(", ") || "inga uttryckta behov";
  };
  const groupLine = (name: string, group: { n: DialogueNeeds }[]) =>
    `- ${name} (${group.length} köpdialoger${group.length < CROSSING_MIN_GROUP ? ", litet underlag" : ""}): ${top(group)}`;
  const bySource = sourceRows(list.map((x) => x.row))
    .map((s) => ({ name: s.name, group: list.filter(({ row }) => (row.source ?? UNKNOWN_SOURCE) === s.name) }))
    .filter((s) => s.group.length >= 3);
  if (bySource.length) lines.push(`### Vanligaste behoven per leadskälla (HubSpot-fakta × AI-klassificering; antal köpdialoger)`, ...bySource.map((s) => groupLine(s.name, s.group)));
  const virtual = list.filter(({ row }) => row.regnrKind === "virtual");
  const plate = list.filter(({ row }) => row.regnrKind === "plate");
  if (virtual.length || plate.length) {
    lines.push(
      `### Virtuell eller riktigt registreringsnummer i formuläret (HubSpot-fakta × AI-klassificering)`,
      groupLine('"Virtuell"', virtual),
      groupLine("Riktigt registreringsnummer", plate),
      "- Virtuell är en signal (ofta annonser utan fysisk bil i lager), inte en säker fordonsstatus.",
    );
  }
  if (input.scopeType !== "inbox" && !input.sellerAlias) {
    const perInbox = input.inboxes.map((i) => ({ name: i.name, group: list.filter(({ row }) => row.inboxId === i.id) })).filter((x) => x.group.length >= 3);
    if (perInbox.length > 1) lines.push("### Per inkorg", ...perInbox.map((x) => groupLine(x.name, x.group)));
  }

  // --- When the car could not be had ---------------------------------------------------
  const u = unavailableSummary(list);
  if (u.total) {
    const all = having("unavailable");
    addSet("unavailable", "Bilen gick inte att få", all, total);
    lines.push(
      "### När bilen kunden frågade om inte gick att få (AI-klassificering)",
      metric({ label: "Köpdialoger där bilen inte gick att få", value: u.total, of: total, population, origin: "klassificering" }),
      `- Varför: ${u.situations.map((s) => `${UNAVAILABLE_LABELS[s.code].toLowerCase()} ${s.count}`).join(", ")}.`,
      ...u.carried.map((c) => {
        const hit = having(`carried:${c.group}`);
        addSet(`carried:${c.group}`, CARRIED_GROUP_LABELS[c.group], hit, u.total);
        return metric({ label: `Därefter: ${CARRIED_GROUP_LABELS[c.group].toLowerCase()}`, value: c.count, of: u.total, population: "köpdialoger där bilen inte gick att få", origin: "klassificering" });
      }),
      '- "Fördes synligt vidare": säljaren föreslog ett alternativ, en annan lösning eller ett nästa steg, eller frågade om behovet. "Inget sådant syns": säljaren skrev men inget av det syns – samtal och säljsystemet syns inte, så det är ingen bedömning av säljaren.',
    );
  } else if (total) lines.push("### När bilen inte gick att få\n- Inga analyserade köpdialoger där bilen inte gick att få.");

  // --- The seller's topics (kept apart from the customer's needs) -------------------------
  const sellerTopics = new Map<Need, number>();
  for (const { n } of list) for (const t of n.sellerTopics) sellerTopics.set(t, (sellerTopics.get(t) ?? 0) + 1);
  if (sellerTopics.size) {
    lines.push(
      `### Ämnen som säljaren tog upp utan att kunden hade nämnt dem (inte kundbehov)\n- ${[...sellerTopics].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, k]) => `${NEED_LABELS[c]} ${k}`).join(", ")}`,
    );
  }

  // --- Examples ------------------------------------------------------------------------
  if (input.examples) {
    const wanted = input.focus.includes("next_step") && (input.focus.includes("strong_signal") || input.focus.includes("soon"))
      ? "signal_no_next_step"
      : input.focus.includes("unavailable")
        ? "unavailable"
        : focusItems[0] ?? (input.focus.includes("strong_signal") ? "strong_signal" : input.focus.includes("soon") ? "soon" : null);
    if (wanted) {
      const pool = /^(need|request|signal):/.test(wanted) ? list.filter(({ n }) => itemsOf(n).includes(wanted)) : having(wanted);
      const chosen = [...pool].sort((a, b) => b.row.arrivedAt.localeCompare(a.row.arrivedAt) || a.row.threadId.localeCompare(b.row.threadId)).slice(0, input.examples.count);
      const tags = chosen.map(({ row, n }) => {
        const notes = [
          ...n.needs.filter((x) => x.stance === "expressed" && x.note).map((x) => x.note),
          ...n.signals.filter((x) => STRONG_SIGNALS.includes(x.code) && x.note).map((x) => x.note),
          n.unavailable.situation !== "none" ? `${UNAVAILABLE_LABELS[n.unavailable.situation as keyof typeof UNAVAILABLE_LABELS] ?? ""}: ${n.unavailable.note}` : "",
        ].filter(Boolean);
        const reason = notes.slice(0, 3).join(" · ") || null;
        const group = carriedGroup(n.unavailable.carried);
        const nr = input.addLead(row, [wanted], reason, "Kundbehov");
        return `  ${input.leadTag(
          nr,
          row,
          {
            behov: expressedNeeds(n).map((c) => NEED_LABELS[c]).join("; ") || null,
            köpsignal: hasStrongSignal(n) ? "tydlig" : null,
            "köp inom kort": n.timeframe === "soon" ? "ja" : null,
            "nästa steg": wanted === "signal_no_next_step" ? "syns inte i HubSpot" : null,
            därefter: group ? CARRIED_GROUP_LABELS[group] : null,
            ursprung: "AI-klassificering",
          },
          reason,
        )}`;
      });
      lines.push(
        `### Exempel på dialoger som passar frågan (${chosen.length} av ${pool.length}) – visa dem och hänvisa med [nr]`,
        ...(tags.length ? tags : ["- Inga dialoger i urvalet passar. Säg det."]),
      );
    }
  }

  return { text: `## Vad kunderna frågar efter (lead-needs-1)\n${lines.filter(Boolean).join("\n")}`, sets };
}
