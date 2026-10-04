import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { LeadChatState } from "@/lib/leads/chat";
import { addDays, previousPeriod, resolvePeriod } from "@/lib/leads/periods";
import type { AISummary, CoverageInfo, LeadRow, Period } from "@/lib/leads/types";
import { defaultChatModel } from "@/server/ai/models";
import {
  getThreadUrlTemplate,
  leadStore,
  listLeadInboxes,
  listLeadRegions,
  listLeadRows,
  listRuns,
  listSyncs,
  sellerNames,
  type StoredAnalysis,
} from "@/server/data/leads";
import { ANALYSIS_VERSION } from "@/server/leads/analysis";
import { startOfStockholmDate, stockholmTime } from "@/server/leads/business-hours";
import { coverage } from "@/server/leads/coverage";

import { modulesFor, needsAnalyses, type BriefInput } from "./brief";
import type { ExampleRequest } from "./intent";
import type { Pseudonyms } from "./pseudonyms";
import type { LeadEntities } from "./scope";

/**
 * Loads what a lead answer may use – always with the user's own client, so the lead access rules
 * (RLS) decide every row. Only the modules the question needs are loaded (ADR-050).
 */

const SELLER_WINDOW_DAYS = 180;
const PAGE = 1000;

export function stockholmToday(now = new Date()) {
  const t = stockholmTime(now);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function dateOf(iso: string) {
  const t = stockholmTime(new Date(iso));
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/** Regions, inboxes and sellers the user may see. Sellers come from readable leads only. */
export async function loadEntities(supabase: SupabaseClient, today: string): Promise<LeadEntities> {
  const [regions, all] = await Promise.all([listLeadRegions(supabase), listLeadInboxes(supabase)]);
  const inboxes = all.filter((i) => i.active);
  const inboxIds = new Set(inboxes.map((i) => i.id));
  const since = startOfStockholmDate(addDays(today, -SELLER_WINDOW_DAYS)).toISOString();
  const actors = new Map<string, Set<string>>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("lead_threads")
      .select("hubspot_inbox_id, owner_actor_id, responder_actor_id")
      .gte("arrived_at", since)
      .order("hubspot_thread_id")
      .range(page * PAGE, page * PAGE + PAGE - 1)
      .returns<{ hubspot_inbox_id: string; owner_actor_id: string | null; responder_actor_id: string | null }[]>();
    if (error) throw new Error(`lead entities: ${error.code}`);
    for (const r of data ?? []) {
      if (!inboxIds.has(r.hubspot_inbox_id)) continue;
      for (const id of [r.owner_actor_id, r.responder_actor_id]) {
        if (id) actors.set(id, (actors.get(id) ?? new Set()).add(r.hubspot_inbox_id));
      }
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  const [names, known] = await Promise.all([
    sellerNames([...actors.keys()], supabase),
    supabase.from("lead_sellers").select("display_name").not("display_name", "is", null).limit(5000).returns<{ display_name: string }[]>(),
  ]);
  return {
    regions: regions.filter((r) => inboxes.some((i) => i.regionId === r.id)).map((r) => ({ id: r.id, name: r.name })),
    inboxes: inboxes.map((i) => ({ id: i.id, name: i.name, regionId: i.regionId, facility: i.facility, brand: i.brand })),
    sellers: [...actors]
      .filter(([id]) => names.has(id))
      .map(([id, set]) => ({ id, name: names.get(id)!, inboxIds: [...set].sort() })),
    knownNames: (known.data ?? []).map((r) => r.display_name),
  };
}

export interface LoadedSelection {
  input: Omit<BriefInput, "pseudonyms" | "now">;
  /** Nothing fetched for the period at all: answer without AI. */
  notFetched: boolean;
  timings: { rowsMs: number; analysesMs: number };
}

export async function loadSelection(
  supabase: SupabaseClient,
  args: { state: LeadChatState; intents: BriefInput["intents"]; examples: ExampleRequest | null; entities: LeadEntities; today: string },
): Promise<LoadedSelection> {
  const { state, entities, today } = args;
  const inbox = state.inboxId ? entities.inboxes.find((i) => i.id === state.inboxId) : null;
  const region = !inbox && state.regionId ? entities.regions.find((r) => r.id === state.regionId) : null;
  const scopeInboxes = inbox ? [inbox] : region ? entities.inboxes.filter((i) => i.regionId === region.id) : entities.inboxes;
  const scopeType: BriefInput["scopeType"] = inbox ? "inbox" : region ? "region" : "all";
  const selection = inbox ? inbox.name : region ? `Region ${region.name}` : "Alla leads du har tillgång till";
  const seller = state.sellerId ? (entities.sellers.find((s) => s.id === state.sellerId) ?? null) : null;

  const period: Period = resolvePeriod(state.preset, today, state.from, state.to);
  const modules = modulesFor(args.intents, !!seller);
  const previous = modules.has("comparison") ? previousPeriod(period) : null;
  const ids = scopeInboxes.map((i) => i.id);

  const t0 = Date.now();
  const [allRows, syncs, template] = await Promise.all([
    listLeadRows(ids, startOfStockholmDate(previous?.from ?? period.from), startOfStockholmDate(addDays(period.to, 1)), supabase),
    listSyncs(ids, supabase),
    getThreadUrlTemplate(supabase),
  ]);
  const inPeriod = (p: Period) => (r: LeadRow) => {
    const d = dateOf(r.arrivedAt);
    return d >= p.from && d <= p.to;
  };
  const rows = allRows.filter(inPeriod(period));
  const prevRows = previous ? allRows.filter(inPeriod(previous)) : null;
  const cov: CoverageInfo = coverage(scopeInboxes, syncs, period.from, period.to);
  const prevCov = previous ? coverage(scopeInboxes, syncs, previous.from, previous.to) : null;
  const rowsMs = Date.now() - t0;

  const t1 = Date.now();
  let analyses: Map<string, StoredAnalysis> | null = null;
  let runFindings: BriefInput["runFindings"] = null;
  if (needsAnalyses(modules)) {
    const eligible = rows.filter((r) => r.status === "registered_reply" && r.sellerMessages > 0 && (!seller || r.responderId === seller.id || r.ownerId === seller.id));
    const [loaded, runs] = await Promise.all([
      leadStore(supabase).loadAnalyses(eligible.map((r) => r.threadId), ANALYSIS_VERSION, defaultChatModel().id),
      modules.has("patterns") && !seller
        ? listRuns({ type: scopeType, inboxId: inbox?.id ?? null, regionId: region?.id ?? null }, supabase)
        : Promise.resolve([]),
    ]);
    analyses = loaded;
    const run = runs.find((r) => r.from === period.from && r.to === period.to && r.analysisVersion === ANALYSIS_VERSION && r.summary && "findings" in r.summary);
    runFindings = run ? (run.summary as AISummary).findings.map((f) => ({ title: f.title, text: f.text, kind: f.kind, threadIds: f.threadIds })) : null;
  }
  const analysesMs = Date.now() - t1;

  return {
    notFetched: cov.coveredDays === 0 && rows.length === 0,
    timings: { rowsMs, analysesMs },
    input: {
      state: { ...state, preset: period.preset, from: period.from, to: period.to },
      intents: args.intents,
      examples: args.examples,
      selection,
      scopeType,
      inboxes: scopeInboxes.map((i) => ({ id: i.id, name: i.name })),
      seller: seller ? { id: seller.id, name: seller.name } : null,
      period,
      previous,
      rows,
      prevRows,
      coverage: cov,
      prevCoverage: prevCov,
      analyses,
      analysisVersion: ANALYSIS_VERSION,
      runFindings,
      threadUrlTemplate: template,
    },
  };
}

export type { Pseudonyms };
