import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AISummary,
  BehaviourJudgement,
  LeadAccessInfo,
  LeadInboxConfig,
  LeadRegion,
  LeadRow,
  LegacyAISummary,
  RunSummaryInfo,
  SituationAssessment,
} from "@/lib/leads/types";
import type { RawClassification } from "@/server/leads/analysis";
import type { SyncRecord } from "@/server/leads/coverage";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

/**
 * Persistent lead analysis (ADR-047, ADR-048). Always read and written with
 * the signed-in user's own session: RLS decides what each user may see
 * (system administrators everything; others the active inboxes of their
 * regions). Structured data only – never message texts or customer contact
 * details. HubSpot remains the source of the conversations.
 */

export interface StoredAnalysis {
  fingerprint: string;
  sourceLatestMessageAt: string | null;
  situationState: string | null;
  analysedAt: string;
  classification: RawClassification;
}

export interface NewAnalysis {
  threadId: string;
  fingerprint: string;
  sellerId: string | null;
  sourceLatestMessageAt: string | null;
  situationState: string;
  classification: RawClassification;
}

export interface RunRecord {
  scopeType: "inbox" | "region" | "all";
  inboxId: string | null;
  regionId: string | null;
  from: string;
  to: string;
  analysisVersion: string;
  model: string;
  factsVersion: number;
  startedAt: string;
  leads: number;
  dialoguesAnalysed: number;
  analysedNew: number;
  reused: number;
  notAnalysed: unknown;
  costUsd: number;
  facts: unknown;
  counts: unknown;
  summary: AISummary | null;
}

export interface StoredRun extends RunSummaryInfo {
  scopeType: "inbox" | "region" | "all";
  inboxId: string | null;
  regionId: string | null;
  counts: unknown;
  summary: AISummary | LegacyAISummary | null;
  notAnalysed: unknown;
}

export interface ThreadState {
  latestMessageAt: string | null;
  factsVersion: number;
}

export interface LeadStore {
  saveFacts(input: { sellers: { id: string; name: string | null }[]; rows: LeadRow[]; factsVersion: number }): Promise<void>;
  threadStates(threadIds: string[]): Promise<Map<string, ThreadState>>;
  recordSync(sync: { inboxId: string; from: string; to: string; leads: number; complete: boolean }): Promise<void>;
  loadAnalyses(threadIds: string[], analysisVersion: string, model: string): Promise<Map<string, StoredAnalysis>>;
  saveAnalyses(rows: NewAnalysis[], analysisVersion: string, model: string): Promise<void>;
  saveRun(run: RunRecord): Promise<string | null>;
  leadRows(inboxIds: string[], from: Date, to: Date): Promise<LeadRow[]>;
  sellerNames(ids: string[]): Promise<Map<string, string>>;
}

const CHUNK = 100;
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const THREAD_COLUMNS =
  "hubspot_thread_id, hubspot_inbox_id, arrived_at, arrival_window, channel, source, form_name, vehicle, reply_status, first_response_at, calendar_minutes, business_minutes, owner_actor_id, responder_actor_id, assignment_events, moved_into_inbox, thread_open, customer_messages, seller_messages, internal_comments, customer_wrote_last, latest_message_at, last_customer_message_at, first_seller_after_customer_at, followed_up, vehicle_brand, vehicle_model, vehicle_source, regnr_kind";

type ThreadRow = {
  hubspot_thread_id: string;
  hubspot_inbox_id: string;
  arrived_at: string;
  arrival_window: LeadRow["arrivalWindow"];
  channel: LeadRow["channel"];
  source: string | null;
  form_name: string | null;
  vehicle: string | null;
  reply_status: LeadRow["status"];
  first_response_at: string | null;
  calendar_minutes: number | null;
  business_minutes: number | null;
  owner_actor_id: string | null;
  responder_actor_id: string | null;
  assignment_events: number;
  moved_into_inbox: boolean;
  thread_open: boolean;
  customer_messages: number;
  seller_messages: number;
  internal_comments: number;
  customer_wrote_last: boolean;
  latest_message_at: string | null;
  last_customer_message_at: string | null;
  first_seller_after_customer_at: string | null;
  followed_up: boolean;
  vehicle_brand: string | null;
  vehicle_model: string | null;
  vehicle_source: LeadRow["vehicleSource"];
  regnr_kind: LeadRow["regnrKind"];
};

export function toLeadRow(r: ThreadRow): LeadRow {
  return {
    threadId: r.hubspot_thread_id,
    inboxId: r.hubspot_inbox_id,
    arrivedAt: new Date(r.arrived_at).toISOString(),
    arrivalWindow: r.arrival_window,
    channel: r.channel,
    source: r.source,
    formName: r.form_name,
    vehicle: r.vehicle,
    status: r.reply_status,
    firstResponseAt: r.first_response_at,
    calendarMinutes: r.calendar_minutes,
    businessMinutes: r.business_minutes,
    ownerId: r.owner_actor_id,
    responderId: r.responder_actor_id,
    assignmentEvents: r.assignment_events,
    movedIntoInbox: r.moved_into_inbox,
    threadOpen: r.thread_open,
    customerMessages: r.customer_messages,
    sellerMessages: r.seller_messages,
    internalComments: r.internal_comments,
    customerWroteLast: r.customer_wrote_last,
    latestMessageAt: r.latest_message_at ? new Date(r.latest_message_at).toISOString() : null,
    lastCustomerMessageAt: r.last_customer_message_at ? new Date(r.last_customer_message_at).toISOString() : null,
    firstSellerAfterCustomerAt: r.first_seller_after_customer_at ? new Date(r.first_seller_after_customer_at).toISOString() : null,
    followedUp: r.followed_up,
    vehicleBrand: r.vehicle_brand,
    vehicleModel: r.vehicle_model,
    vehicleSource: r.vehicle_source,
    regnrKind: r.regnr_kind,
  };
}

type AnalysisRow = {
  hubspot_thread_id: string;
  source_fingerprint: string;
  source_latest_message_at: string | null;
  situation_state: string | null;
  analysed_at: string;
  seller_actor_id: string | null;
  intent: RawClassification["intent"];
  purchase_intent: RawClassification["purchaseIntent"];
  car_status: RawClassification["carStatus"];
  alternative_offered: RawClassification["alternativeOffered"];
  behaviours: Record<string, BehaviourJudgement>;
  observations: string[];
  evidence: RawClassification["evidence"];
  assessment: SituationAssessment | null;
};

const ANALYSIS_COLUMNS =
  "hubspot_thread_id, source_fingerprint, source_latest_message_at, situation_state, analysed_at, seller_actor_id, intent, purchase_intent, car_status, alternative_offered, behaviours, observations, evidence, assessment";

function toClassification(r: AnalysisRow): RawClassification {
  return {
    intent: r.intent,
    purchaseIntent: r.purchase_intent,
    carStatus: r.car_status,
    alternativeOffered: r.alternative_offered,
    behaviours: r.behaviours as RawClassification["behaviours"],
    observations: r.observations,
    evidence: r.evidence,
    assessment: r.assessment,
  };
}

const RUN_COLUMNS =
  "id, scope_type, hubspot_inbox_id, region_id, finished_at, period_from, period_to, dialogues_analysed, analysed_new, reused, analysis_version, model, cost_usd, counts, summary, not_analysed";

type RunRow = {
  id: string;
  scope_type: StoredRun["scopeType"];
  hubspot_inbox_id: string | null;
  region_id: string | null;
  finished_at: string;
  period_from: string;
  period_to: string;
  dialogues_analysed: number;
  analysed_new: number;
  reused: number;
  analysis_version: string;
  model: string;
  cost_usd: number | string;
  counts: unknown;
  summary: AISummary | LegacyAISummary | null;
  not_analysed: unknown;
};

function toRun(r: RunRow): StoredRun {
  return {
    id: r.id,
    scopeType: r.scope_type,
    inboxId: r.hubspot_inbox_id,
    regionId: r.region_id,
    finishedAt: r.finished_at,
    from: r.period_from,
    to: r.period_to,
    dialoguesAnalysed: r.dialogues_analysed,
    analysedNew: r.analysed_new,
    reused: r.reused,
    analysisVersion: r.analysis_version,
    model: r.model,
    costUsd: Number(r.cost_usd),
    counts: r.counts,
    summary: r.summary,
    notAnalysed: r.not_analysed,
  };
}

async function client(given?: SupabaseClient) {
  return given ?? (await createSupabaseServerClient());
}

/** The store used by sync and analysis (tests pass a signed-in client or a fake). */
export function leadStore(given?: SupabaseClient): LeadStore {
  return {
    leadRows: (inboxIds, from, to) => listLeadRows(inboxIds, from, to, given),
    sellerNames: (ids) => sellerNames(ids, given),
    async saveFacts({ sellers, rows, factsVersion }) {
      const supabase = await client(given);
      // A known name is refreshed; an unknown one never overwrites a stored name.
      const named = sellers.filter((s) => s.name);
      const unnamed = sellers.filter((s) => !s.name);
      if (named.length) unwrap(await supabase.from("lead_sellers").upsert(named.map((s) => ({ hubspot_actor_id: s.id, display_name: s.name }))));
      if (unnamed.length) {
        unwrap(await supabase.from("lead_sellers").upsert(unnamed.map((s) => ({ hubspot_actor_id: s.id })), { onConflict: "hubspot_actor_id", ignoreDuplicates: true }));
      }
      for (const part of chunks(rows)) {
        unwrap(
          await supabase.from("lead_threads").upsert(
            part.map((r) => ({
              hubspot_thread_id: r.threadId,
              hubspot_inbox_id: r.inboxId,
              facts_version: factsVersion,
              arrived_at: r.arrivedAt,
              arrival_window: r.arrivalWindow,
              channel: r.channel,
              source: r.source?.slice(0, 100) ?? null,
              form_name: r.formName?.slice(0, 200) ?? null,
              vehicle: r.vehicle?.slice(0, 200) ?? null,
              reply_status: r.status,
              first_response_at: r.firstResponseAt,
              calendar_minutes: r.calendarMinutes,
              business_minutes: r.businessMinutes,
              owner_actor_id: r.ownerId,
              responder_actor_id: r.responderId,
              assignment_events: r.assignmentEvents,
              moved_into_inbox: r.movedIntoInbox,
              thread_open: r.threadOpen,
              customer_messages: r.customerMessages,
              seller_messages: r.sellerMessages,
              internal_comments: r.internalComments,
              customer_wrote_last: r.customerWroteLast,
              latest_message_at: r.latestMessageAt,
              last_customer_message_at: r.lastCustomerMessageAt,
              first_seller_after_customer_at: r.firstSellerAfterCustomerAt,
              followed_up: r.followedUp,
              vehicle_brand: r.vehicleBrand,
              vehicle_model: r.vehicleModel,
              vehicle_source: r.vehicleSource,
              regnr_kind: r.regnrKind,
            })),
          ),
        );
      }
    },

    async threadStates(threadIds) {
      const supabase = await client(given);
      const out = new Map<string, ThreadState>();
      for (const part of chunks(threadIds)) {
        const rows = unwrap(
          await supabase
            .from("lead_threads")
            .select("hubspot_thread_id, latest_message_at, facts_version")
            .in("hubspot_thread_id", part)
            .returns<{ hubspot_thread_id: string; latest_message_at: string | null; facts_version: number }[]>(),
        );
        for (const r of rows) {
          out.set(r.hubspot_thread_id, { latestMessageAt: r.latest_message_at ? new Date(r.latest_message_at).toISOString() : null, factsVersion: r.facts_version });
        }
      }
      return out;
    },

    async recordSync({ inboxId, from, to, leads, complete }) {
      const supabase = await client(given);
      unwrap(await supabase.from("lead_syncs").insert({ hubspot_inbox_id: inboxId, period_from: from, period_to: to, leads, complete }));
    },

    async loadAnalyses(threadIds, analysisVersion, model) {
      const supabase = await client(given);
      const out = new Map<string, StoredAnalysis>();
      // The id lists are chunked to keep URLs short; the chunks are read in parallel.
      const parts = await Promise.all(
        chunks(threadIds).map(async (part) =>
          unwrap(
            await supabase
              .from("lead_dialogue_analyses")
              .select(ANALYSIS_COLUMNS)
              .eq("analysis_version", analysisVersion)
              .eq("model", model)
              .in("hubspot_thread_id", part)
              .returns<AnalysisRow[]>(),
          ),
        ),
      );
      for (const rows of parts) {
        for (const r of rows) {
          out.set(r.hubspot_thread_id, {
            fingerprint: r.source_fingerprint,
            sourceLatestMessageAt: r.source_latest_message_at ? new Date(r.source_latest_message_at).toISOString() : null,
            situationState: r.situation_state,
            analysedAt: r.analysed_at,
            classification: toClassification(r),
          });
        }
      }
      return out;
    },

    async saveAnalyses(rows, analysisVersion, model) {
      if (!rows.length) return;
      const supabase = await client(given);
      const now = new Date().toISOString();
      for (const part of chunks(rows)) {
        unwrap(
          await supabase.from("lead_dialogue_analyses").upsert(
            part.map((r) => ({
              hubspot_thread_id: r.threadId,
              analysis_version: analysisVersion,
              model,
              source_fingerprint: r.fingerprint,
              source_latest_message_at: r.sourceLatestMessageAt,
              situation_state: r.situationState,
              analysed_at: now,
              seller_actor_id: r.sellerId,
              intent: r.classification.intent,
              purchase_intent: r.classification.purchaseIntent,
              car_status: r.classification.carStatus,
              alternative_offered: r.classification.alternativeOffered,
              behaviours: r.classification.behaviours,
              observations: r.classification.observations,
              evidence: r.classification.evidence,
              assessment: r.classification.assessment,
            })),
            { onConflict: "hubspot_thread_id,analysis_version,model" },
          ),
        );
      }
    },

    async saveRun(run) {
      const supabase = await client(given);
      const created = unwrap(
        await supabase
          .from("lead_analysis_runs")
          .insert({
            scope_type: run.scopeType,
            hubspot_inbox_id: run.inboxId,
            region_id: run.regionId,
            period_from: run.from,
            period_to: run.to,
            analysis_version: run.analysisVersion,
            model: run.model,
            facts_version: run.factsVersion,
            started_at: run.startedAt,
            leads: run.leads,
            dialogues_analysed: run.dialoguesAnalysed,
            analysed_new: run.analysedNew,
            reused: run.reused,
            not_analysed: run.notAnalysed,
            cost_usd: run.costUsd,
            facts: run.facts,
            counts: run.counts,
            summary: run.summary,
          })
          .select("id")
          .single(),
      ) as { id: string } | null;
      return created?.id ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Reading for the pages (user session, RLS)
// ---------------------------------------------------------------------------

export async function myLeadAccess(given?: SupabaseClient): Promise<LeadAccessInfo> {
  const supabase = await client(given);
  const { data, error } = await supabase.rpc("my_lead_access");
  if (error || !data) return { hasAccess: false, isAdmin: false, allRegions: false, regionIds: [] };
  const d = data as { has_access: boolean; is_admin: boolean; all_regions: boolean; region_ids: string[] };
  return { hasAccess: d.has_access, isAdmin: d.is_admin, allRegions: d.all_regions, regionIds: d.region_ids ?? [] };
}

export async function listLeadRegions(given?: SupabaseClient): Promise<LeadRegion[]> {
  const supabase = await client(given);
  const rows = unwrap(
    await supabase.from("lead_regions").select("id, name, sort_order").order("sort_order").order("name").returns<{ id: string; name: string; sort_order: number }[]>(),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }));
}

/** Inboxes visible to the user (RLS): active ones in their regions; all for system administrators. */
export async function listLeadInboxes(given?: SupabaseClient): Promise<LeadInboxConfig[]> {
  const supabase = await client(given);
  const rows = unwrap(
    await supabase
      .from("lead_inboxes")
      .select("hubspot_inbox_id, name, active, region_id, facility, brand")
      .order("name")
      .returns<{ hubspot_inbox_id: string; name: string; active: boolean; region_id: string | null; facility: string | null; brand: string | null }[]>(),
  );
  return rows.map((r) => ({ id: r.hubspot_inbox_id, name: r.name, configured: true, active: r.active, regionId: r.region_id, facility: r.facility, brand: r.brand }));
}

export async function listSyncs(inboxIds: string[], given?: SupabaseClient): Promise<SyncRecord[]> {
  if (!inboxIds.length) return [];
  const supabase = await client(given);
  const out: SyncRecord[] = [];
  for (const part of chunks(inboxIds)) {
    const rows = unwrap(
      await supabase
        .from("lead_syncs")
        .select("hubspot_inbox_id, period_from, period_to, synced_at, complete")
        .in("hubspot_inbox_id", part)
        .order("synced_at", { ascending: false })
        .limit(5000)
        .returns<{ hubspot_inbox_id: string; period_from: string; period_to: string; synced_at: string; complete: boolean }[]>(),
    );
    out.push(...rows.map((r) => ({ inboxId: r.hubspot_inbox_id, from: r.period_from, to: r.period_to, syncedAt: r.synced_at, complete: r.complete })));
  }
  return out;
}

/** Leads that arrived between two instants in the given inboxes. */
export async function listLeadRows(inboxIds: string[], from: Date, to: Date, given?: SupabaseClient): Promise<LeadRow[]> {
  if (!inboxIds.length) return [];
  const supabase = await client(given);
  const out: LeadRow[] = [];
  for (const part of chunks(inboxIds)) {
    for (let page = 0; ; page++) {
      const rows = unwrap(
        await supabase
          .from("lead_threads")
          .select(THREAD_COLUMNS)
          .in("hubspot_inbox_id", part)
          .gte("arrived_at", from.toISOString())
          .lt("arrived_at", to.toISOString())
          .order("arrived_at")
          .range(page * 1000, page * 1000 + 999)
          .returns<ThreadRow[]>(),
      );
      out.push(...rows.map(toLeadRow));
      if (rows.length < 1000) break;
    }
  }
  return out;
}

export async function listLeadRowsById(threadIds: string[], given?: SupabaseClient): Promise<LeadRow[]> {
  const supabase = await client(given);
  const out: LeadRow[] = [];
  for (const part of chunks(threadIds)) {
    const rows = unwrap(await supabase.from("lead_threads").select(THREAD_COLUMNS).in("hubspot_thread_id", part).returns<ThreadRow[]>());
    out.push(...rows.map(toLeadRow));
  }
  return out;
}

export async function sellerNames(ids: string[], given?: SupabaseClient): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const supabase = await client(given);
  const out = new Map<string, string>();
  for (const part of chunks(ids)) {
    const rows = unwrap(
      await supabase.from("lead_sellers").select("hubspot_actor_id, display_name").in("hubspot_actor_id", part).returns<{ hubspot_actor_id: string; display_name: string | null }[]>(),
    );
    for (const r of rows) if (r.display_name) out.set(r.hubspot_actor_id, r.display_name);
  }
  return out;
}

export async function listRuns(
  scope: { type: "inbox" | "region" | "all"; inboxId?: string | null; regionId?: string | null },
  given?: SupabaseClient,
): Promise<StoredRun[]> {
  const supabase = await client(given);
  let q = supabase.from("lead_analysis_runs").select(RUN_COLUMNS).eq("scope_type", scope.type).order("finished_at", { ascending: false }).limit(20);
  if (scope.type === "inbox") q = q.eq("hubspot_inbox_id", scope.inboxId!);
  if (scope.type === "region") q = q.eq("region_id", scope.regionId!);
  return unwrap(await q.returns<RunRow[]>()).map(toRun);
}

export async function getRun(id: string, given?: SupabaseClient): Promise<StoredRun | null> {
  const supabase = await client(given);
  const rows = unwrap(await supabase.from("lead_analysis_runs").select(RUN_COLUMNS).eq("id", id).limit(1).returns<RunRow[]>());
  return rows[0] ? toRun(rows[0]) : null;
}

export async function getThreadUrlTemplate(given?: SupabaseClient): Promise<string | null> {
  const supabase = await client(given);
  const rows = unwrap(await supabase.from("lead_settings").select("hubspot_thread_url_template").limit(1).returns<{ hubspot_thread_url_template: string | null }[]>());
  return rows[0]?.hubspot_thread_url_template ?? null;
}

// ---------------------------------------------------------------------------
// Administration (system administrators; RLS enforces it)
// ---------------------------------------------------------------------------

export interface LeadGrant {
  id: string;
  subject: "user" | "group";
  subjectId: string;
  subjectName: string;
  regionId: string | null;
}

export async function listLeadGrants(given?: SupabaseClient): Promise<LeadGrant[]> {
  const supabase = await client(given);
  const rows = unwrap(
    await supabase
      .from("lead_access_grants")
      .select("id, user_id, group_id, region_id, profiles:user_id(full_name, email), groups:group_id(name)")
      .order("created_at")
      .returns<
        {
          id: string;
          user_id: string | null;
          group_id: string | null;
          region_id: string | null;
          profiles: { full_name: string | null; email: string } | null;
          groups: { name: string } | null;
        }[]
      >(),
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.user_id ? "user" : "group",
    subjectId: (r.user_id ?? r.group_id)!,
    subjectName: r.user_id ? (r.profiles?.full_name || r.profiles?.email || "Användare") : (r.groups?.name ?? "Grupp"),
    regionId: r.region_id,
  }));
}

export async function getLeadSettings(given?: SupabaseClient): Promise<{ portalId: string | null; template: string | null }> {
  const supabase = await client(given);
  const rows = unwrap(
    await supabase.from("lead_settings").select("hubspot_portal_id, hubspot_thread_url_template").limit(1).returns<{ hubspot_portal_id: string | null; hubspot_thread_url_template: string | null }[]>(),
  );
  return { portalId: rows[0]?.hubspot_portal_id ?? null, template: rows[0]?.hubspot_thread_url_template ?? null };
}
