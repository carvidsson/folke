"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/server/admin/actions";
import { logSecurityEvent } from "@/server/audit";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { requireLeadAdmin } from "./access";
import { getAccountDetails, getThread, HubSpotError } from "./hubspot";
import { deriveThreadTemplate } from "./hubspot-link";
import { inboxOptions } from "./service";

/**
 * Configuration of the lead analysis (ADR-048): which HubSpot inboxes are
 * included and their region, facility and brand; regions; who has access;
 * the verified HubSpot link pattern. System administrators only – checked
 * here and enforced by RLS (the user's own session writes).
 */

function fail(error: { message?: string } | null, fallback: string): ActionResult {
  console.error("[leads/admin]", error?.message ?? "");
  return { ok: false, error: fallback };
}

function refresh() {
  revalidatePath("/admin/leads");
  revalidatePath("/leads");
}

const inboxId = z.string().regex(/^[0-9]{1,20}$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

const inboxSchema = z.object({
  id: inboxId,
  active: z.boolean(),
  regionId: z.uuid().nullish(),
  facility: text(80),
  brand: text(80),
});

export async function saveLeadInboxAction(input: z.input<typeof inboxSchema>): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  const parsed = inboxSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Kontrollera inkorgens uppgifter." };
  let hubspot;
  try {
    hubspot = (await inboxOptions()).find((i) => i.id === parsed.data.id);
  } catch {
    return { ok: false, error: "Inkorgarna kunde inte hämtas från HubSpot." };
  }
  if (!hubspot) return { ok: false, error: "Inkorgen finns inte i HubSpot." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("lead_inboxes").upsert({
    hubspot_inbox_id: parsed.data.id,
    name: hubspot.name,
    active: parsed.data.active,
    region_id: parsed.data.regionId ?? null,
    facility: parsed.data.facility ?? null,
    brand: parsed.data.brand ?? null,
  });
  if (error) return fail(error, "Inkorgen kunde inte sparas.");
  await logSecurityEvent("leads.config_changed", { actorId: session.user.id, targetType: "hubspot_inbox", targetId: parsed.data.id, metadata: { active: parsed.data.active } });
  refresh();
  return { ok: true, message: "Inkorgen är sparad." };
}

const regionSchema = z.object({ id: z.uuid().nullish(), name: z.string().trim().min(1).max(80), sortOrder: z.number().int().min(0).max(999) });

export async function saveLeadRegionAction(input: z.input<typeof regionSchema>): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  const parsed = regionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Ange ett namn på regionen." };
  const supabase = await createSupabaseServerClient();
  const row = { name: parsed.data.name, sort_order: parsed.data.sortOrder };
  const { error } = parsed.data.id
    ? await supabase.from("lead_regions").update(row).eq("id", parsed.data.id)
    : await supabase.from("lead_regions").insert(row);
  if (error) return fail(error, error.code === "23505" ? "Det finns redan en region med det namnet." : "Regionen kunde inte sparas.");
  await logSecurityEvent("leads.config_changed", { actorId: session.user.id, targetType: "lead_region", targetId: parsed.data.id ?? null, metadata: { name: parsed.data.name } });
  refresh();
  return { ok: true, message: "Regionen är sparad." };
}

export async function deleteLeadRegionAction(id: string): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Ogiltig region." };
  const supabase = await createSupabaseServerClient();
  const { count } = await supabase.from("lead_inboxes").select("*", { count: "exact", head: true }).eq("region_id", id);
  if (count) return { ok: false, error: "Regionen har inkorgar. Flytta dem till en annan region först." };
  const { error } = await supabase.from("lead_regions").delete().eq("id", id);
  if (error) return fail(error, "Regionen kunde inte tas bort.");
  await logSecurityEvent("leads.config_changed", { actorId: session.user.id, targetType: "lead_region", targetId: id, metadata: { deleted: true } });
  refresh();
  return { ok: true, message: "Regionen är borttagen." };
}

const grantSchema = z.object({ subject: z.enum(["user", "group"]), subjectId: z.uuid(), regionId: z.uuid().nullish() });

export async function addLeadGrantAction(input: z.input<typeof grantSchema>): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  const parsed = grantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Välj en grupp eller användare." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("lead_access_grants").insert({
    user_id: parsed.data.subject === "user" ? parsed.data.subjectId : null,
    group_id: parsed.data.subject === "group" ? parsed.data.subjectId : null,
    region_id: parsed.data.regionId ?? null,
  });
  if (error) return fail(error, error.code === "23505" ? "Den åtkomsten finns redan." : "Åtkomsten kunde inte sparas.");
  await logSecurityEvent("leads.access_changed", {
    actorId: session.user.id,
    targetType: parsed.data.subject === "user" ? "profile" : "group",
    targetId: parsed.data.subjectId,
    metadata: { granted: true, region: parsed.data.regionId ?? "alla" },
  });
  refresh();
  return { ok: true, message: "Åtkomsten är tillagd." };
}

export async function removeLeadGrantAction(id: string): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Ogiltig åtkomst." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("lead_access_grants").delete().eq("id", id);
  if (error) return fail(error, "Åtkomsten kunde inte tas bort.");
  await logSecurityEvent("leads.access_changed", { actorId: session.user.id, targetType: "lead_access_grant", targetId: id, metadata: { granted: false } });
  refresh();
  return { ok: true, message: "Åtkomsten är borttagen." };
}

/** Verifies a pasted HubSpot conversation URL and stores the derived pattern (see hubspot-link.ts). */
export async function saveThreadUrlAction(url: string): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  if (typeof url !== "string" || url.length > 500) return { ok: false, error: "Klistra in adressen till en konversation i HubSpot." };
  let result;
  let account;
  try {
    account = await getAccountDetails();
    result = await deriveThreadTemplate(url, account, async (id) => (await getThread(id)) !== null);
  } catch (error) {
    console.error("[leads/admin] HubSpot", error instanceof HubSpotError ? error.code : "unknown");
    return { ok: false, error: "HubSpot kunde inte verifiera adressen just nu. Försök igen." };
  }
  if (!result.ok) return { ok: false, error: result.error };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("lead_settings")
    .update({ hubspot_portal_id: account.portalId, hubspot_thread_url_template: result.template, updated_at: new Date().toISOString(), updated_by: session.user.id })
    .eq("id", true);
  if (error) return fail(error, "Länkmönstret kunde inte sparas.");
  await logSecurityEvent("leads.config_changed", { actorId: session.user.id, targetType: "lead_settings", metadata: { threadLink: "verified" } });
  refresh();
  return { ok: true, message: "Länken till HubSpot är verifierad och sparad." };
}

export async function clearThreadUrlAction(): Promise<ActionResult> {
  const session = await requireLeadAdmin();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("lead_settings").update({ hubspot_thread_url_template: null, updated_at: new Date().toISOString(), updated_by: session.user.id }).eq("id", true);
  if (error) return fail(error, "Länkmönstret kunde inte tas bort.");
  await logSecurityEvent("leads.config_changed", { actorId: session.user.id, targetType: "lead_settings", metadata: { threadLink: "removed" } });
  refresh();
  return { ok: true, message: "Länken till HubSpot är borttagen." };
}
