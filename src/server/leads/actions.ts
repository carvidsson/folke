"use server";

import { z } from "zod";

import type { LeadActionResult, LeadAIResult, LeadReport } from "@/lib/leads/types";
import { leadAnalysisExternalAllowed } from "@/server/ai/guard";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { leadStore } from "@/server/data/leads";

import { stockholmTime } from "./business-hours";
import { HubSpotError, hubSpotConfigured } from "./hubspot";
import { analyseLeads, collectLeads, MAX_PERIOD_DAYS } from "./service";

/**
 * Lead analysis (ADR-046). System administrators only. Reads HubSpot
 * (read-only) on the server; the browser receives the report without
 * customer contact details or message texts.
 */



const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const input = z
  .object({ inboxId: z.string().regex(/^\d{1,20}$/), from: isoDate, to: isoDate })
  // A real calendar date: "2026-02-31" is rejected, not rolled over to March.
  .refine((v) => [v.from, v.to].every((d) => new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d), "date")
  .refine((v) => v.from <= v.to, "order")
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_PERIOD_DAYS, "length")
  .refine((v) => {
    const t = stockholmTime(new Date());
    const today = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
    return v.to <= today;
  }, "future");

const INPUT_ERRORS: Record<string, string> = {
  order: "Startdatum måste ligga före slutdatum.",
  length: `Välj en period på högst ${MAX_PERIOD_DAYS} dagar.`,
  future: "Perioden kan inte sluta i framtiden.",
};

async function requireSystemAdmin() {
  const session = await getSession();
  if (session.user.role !== "system_admin") {
    await logSecurityEvent("access.denied", { actorId: session.user.id, metadata: { area: "admin.leads" } });
    throw new Error("Behörighet saknas");
  }
  return session;
}

function hubSpotMessage(error: unknown): string {
  const code = error instanceof HubSpotError ? error.code : "unknown";
  console.error("[leads] HubSpot request failed", code);
  switch (code) {
    case "not_configured":
      return "HubSpot är inte konfigurerat i den här miljön.";
    case "auth":
    case "forbidden":
      return "HubSpot nekade åtkomst. Kontrollera servicenyckeln och att den har behörigheten conversations.read.";
    case "not_found":
      return "Inkorgen hittades inte i HubSpot.";
    case "rate_limited":
      return "HubSpot begränsar antalet anrop just nu. Försök igen om en minut.";
    default:
      return "Det gick inte att hämta data från HubSpot. Försök igen.";
  }
}

function parseInput(raw: unknown) {
  const parsed = input.safeParse(raw);
  if (parsed.success) return { ok: true as const, value: parsed.data };
  const code = parsed.error.issues[0]?.message ?? "";
  return { ok: false as const, error: INPUT_ERRORS[code] ?? "Välj en inkorg och en giltig period." };
}

export async function leadReportAction(raw: unknown): Promise<LeadActionResult<LeadReport>> {
  const session = await requireSystemAdmin();
  if (!hubSpotConfigured()) return { ok: false, error: hubSpotMessage(new HubSpotError("not_configured")) };
  const parsed = parseInput(raw);
  if (!parsed.ok) return parsed;
  try {
    const { report } = await collectLeads(parsed.value);
    await logSecurityEvent("leads.report_generated", {
      actorId: session.user.id,
      targetType: "hubspot_inbox",
      targetId: parsed.value.inboxId,
      metadata: { from: parsed.value.from, to: parsed.value.to, leads: report.dataset.leads, complete: report.dataset.complete },
    });
    return { ok: true, data: report };
  } catch (error) {
    return { ok: false, error: hubSpotMessage(error) };
  }
}

export async function leadAIAnalysisAction(raw: unknown): Promise<LeadActionResult<{ report: LeadReport; ai: LeadAIResult }>> {
  const session = await requireSystemAdmin();
  if (!leadAnalysisExternalAllowed()) {
    return { ok: false, error: "AI-analysen är inte aktiverad i den här miljön." };
  }
  if (!hubSpotConfigured()) return { ok: false, error: hubSpotMessage(new HubSpotError("not_configured")) };
  const parsed = parseInput(raw);
  if (!parsed.ok) return parsed;

  const store = leadStore();
  let collected;
  try {
    collected = await collectLeads(parsed.value, store);
  } catch (error) {
    return { ok: false, error: hubSpotMessage(error) };
  }
  const run = await analyseLeads(collected, session.user.id, { store });
  if (!run.ok) return run;
  // The history now includes this run.
  if (collected.report.history) {
    collected.report.history = await store.history(collected.report.inbox.id).catch(() => collected.report.history);
  }
  await logSecurityEvent("leads.ai_analysis_run", {
    actorId: session.user.id,
    targetType: "hubspot_inbox",
    targetId: parsed.value.inboxId,
    metadata: {
      from: parsed.value.from,
      to: parsed.value.to,
      dialogues: run.result.dialoguesAnalysed,
      analysedNew: run.result.analysedNew,
      reused: run.result.reused,
      analysisVersion: run.result.analysisVersion,
      model: run.result.model,
      costUsd: run.result.costUsd,
    },
  });
  return { ok: true, data: { report: collected.report, ai: run.result } };
}
