import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AISummary,
  BehaviourJudgement,
  InboxOption,
  LeadHistory,
  LeadRow,
  MonthHistory,
  RunHistory,
} from "@/lib/leads/types";
import type { RawClassification } from "@/server/leads/analysis";
import { stockholmTime } from "@/server/leads/business-hours";
import { median } from "@/server/leads/stats";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { unwrap } from "./errors";

/**
 * Persistent lead analysis (ADR-047). Read and written with the signed-in
 * system administrator's own session: RLS allows system administrators
 * only. Stores structured data only – never message texts or customer
 * contact details. HubSpot remains the source of the conversations.
 */

export interface StoredAnalysis {
  fingerprint: string;
  classification: RawClassification;
}

export interface NewAnalysis {
  threadId: string;
  fingerprint: string;
  sellerId: string | null;
  classification: RawClassification;
}

export interface RunRecord {
  inboxId: string;
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

export interface LeadStore {
  saveFacts(input: { inbox: InboxOption; sellers: { id: string; name: string | null }[]; rows: LeadRow[]; factsVersion: number }): Promise<void>;
  loadAnalyses(threadIds: string[], analysisVersion: string, model: string): Promise<Map<string, StoredAnalysis>>;
  saveAnalyses(rows: NewAnalysis[], analysisVersion: string, model: string): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  history(inboxId: string, now?: Date): Promise<LeadHistory>;
}

const CHUNK = 100;
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

type AnalysisRow = {
  hubspot_thread_id: string;
  source_fingerprint: string;
  intent: RawClassification["intent"];
  purchase_intent: RawClassification["purchaseIntent"];
  car_status: RawClassification["carStatus"];
  alternative_offered: RawClassification["alternativeOffered"];
  behaviours: Record<string, BehaviourJudgement>;
  observations: string[];
  evidence: RawClassification["evidence"];
};

/** The store on a given client (tests pass a signed-in client; the app uses the request's session). */
export function leadStore(client?: SupabaseClient): LeadStore {
  const db = async () => client ?? (await createSupabaseServerClient());

  return {
    async saveFacts({ inbox, sellers, rows, factsVersion }) {
      const supabase = await db();
      unwrap(await supabase.from("lead_inboxes").upsert({ hubspot_inbox_id: inbox.id, name: inbox.name }));
      // A known name is refreshed; an unknown one never overwrites a stored name.
      const named = sellers.filter((s) => s.name);
      const unnamed = sellers.filter((s) => !s.name);
      if (named.length) {
        unwrap(await supabase.from("lead_sellers").upsert(named.map((s) => ({ hubspot_actor_id: s.id, display_name: s.name }))));
      }
      if (unnamed.length) {
        unwrap(
          await supabase
            .from("lead_sellers")
            .upsert(unnamed.map((s) => ({ hubspot_actor_id: s.id })), { onConflict: "hubspot_actor_id", ignoreDuplicates: true }),
        );
      }
      for (const part of chunks(rows)) {
        unwrap(
          await supabase.from("lead_threads").upsert(
            part.map((r) => ({
              hubspot_thread_id: r.threadId,
              hubspot_inbox_id: inbox.id,
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
            })),
          ),
        );
      }
    },

    async loadAnalyses(threadIds, analysisVersion, model) {
      const supabase = await db();
      const out = new Map<string, StoredAnalysis>();
      for (const part of chunks(threadIds)) {
        const rows = unwrap(
          await supabase
            .from("lead_dialogue_analyses")
            .select("hubspot_thread_id, source_fingerprint, intent, purchase_intent, car_status, alternative_offered, behaviours, observations, evidence")
            .eq("analysis_version", analysisVersion)
            .eq("model", model)
            .in("hubspot_thread_id", part)
            .returns<AnalysisRow[]>(),
        );
        for (const r of rows) {
          out.set(r.hubspot_thread_id, {
            fingerprint: r.source_fingerprint,
            classification: {
              intent: r.intent,
              purchaseIntent: r.purchase_intent,
              carStatus: r.car_status,
              alternativeOffered: r.alternative_offered,
              behaviours: r.behaviours as RawClassification["behaviours"],
              observations: r.observations,
              evidence: r.evidence,
            },
          });
        }
      }
      return out;
    },

    async saveAnalyses(rows, analysisVersion, model) {
      if (!rows.length) return;
      const supabase = await db();
      const now = new Date().toISOString();
      for (const part of chunks(rows)) {
        unwrap(
          await supabase.from("lead_dialogue_analyses").upsert(
            part.map((r) => ({
              hubspot_thread_id: r.threadId,
              analysis_version: analysisVersion,
              model,
              source_fingerprint: r.fingerprint,
              analysed_at: now,
              seller_actor_id: r.sellerId,
              intent: r.classification.intent,
              purchase_intent: r.classification.purchaseIntent,
              car_status: r.classification.carStatus,
              alternative_offered: r.classification.alternativeOffered,
              behaviours: r.classification.behaviours,
              observations: r.classification.observations,
              evidence: r.classification.evidence,
            })),
            { onConflict: "hubspot_thread_id,analysis_version,model" },
          ),
        );
      }
    },

    async saveRun(run) {
      const supabase = await db();
      unwrap(
        await supabase.from("lead_analysis_runs").insert({
          hubspot_inbox_id: run.inboxId,
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
        }),
      );
    },

    async history(inboxId, now = new Date()) {
      const supabase = await db();
      const since = new Date(now.getTime() - 365 * 86_400_000).toISOString();
      const threads = unwrap(
        await supabase
          .from("lead_threads")
          .select("arrived_at, reply_status, business_minutes, calendar_minutes")
          .eq("hubspot_inbox_id", inboxId)
          .gte("arrived_at", since)
          .order("arrived_at")
          .limit(20_000)
          .returns<{ arrived_at: string; reply_status: string; business_minutes: number | null; calendar_minutes: number | null }[]>(),
      );
      const byMonth = new Map<string, typeof threads>();
      for (const t of threads) {
        const s = stockholmTime(new Date(t.arrived_at));
        const key = `${s.year}-${String(s.month).padStart(2, "0")}`;
        byMonth.set(key, [...(byMonth.get(key) ?? []), t]);
      }
      const months: MonthHistory[] = [...byMonth].map(([month, rows]) => {
        const replied = rows.filter((r) => r.reply_status === "registered_reply");
        return {
          month,
          leads: rows.length,
          registeredReply: replied.length,
          medianBusinessMinutes: median(replied.map((r) => r.business_minutes ?? 0)),
          medianCalendarMinutes: median(replied.map((r) => r.calendar_minutes ?? 0)),
        };
      });
      const runs = unwrap(
        await supabase
          .from("lead_analysis_runs")
          .select("finished_at, period_from, period_to, dialogues_analysed, analysed_new, reused, analysis_version, model, cost_usd")
          .eq("hubspot_inbox_id", inboxId)
          .order("finished_at", { ascending: false })
          .limit(10)
          .returns<
            {
              finished_at: string;
              period_from: string;
              period_to: string;
              dialogues_analysed: number;
              analysed_new: number;
              reused: number;
              analysis_version: string;
              model: string;
              cost_usd: number | string;
            }[]
          >(),
      );
      return {
        months,
        runs: runs.map(
          (r): RunHistory => ({
            finishedAt: r.finished_at,
            from: r.period_from,
            to: r.period_to,
            dialoguesAnalysed: r.dialogues_analysed,
            analysedNew: r.analysed_new,
            reused: r.reused,
            analysisVersion: r.analysis_version,
            model: r.model,
            costUsd: Number(r.cost_usd),
          }),
        ),
      };
    },
  };
}
