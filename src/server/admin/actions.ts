"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { roleHas } from "@/lib/domain/roles";
import { logSecurityEvent } from "@/server/audit";
import { getSession } from "@/server/auth/session";
import { serverEnv } from "@/server/env";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Administrative mutations.
 *
 * Pattern: verify the caller's role, validate input with Zod, then write
 * through the caller's own Supabase client so RLS and the audit triggers
 * apply (actor = the administrator). The secret-key client is used only for
 * Auth admin operations (invite, ban) after the role check.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const uuid = z.uuid();
const role = z.enum(["system_admin", "assistant_manager", "employee"]);

async function requireSystemAdmin() {
  const session = await getSession();
  if (session.user.role !== "system_admin") {
    await logSecurityEvent("access.denied", { actorId: session.user.id, metadata: { area: "admin" } });
    throw new Error("Behörighet saknas");
  }
  return session;
}

function fail(error: unknown, fallback: string): ActionResult {
  const message = (error as { message?: string })?.message ?? "";
  console.error("[admin]", message);
  // Surface our own Swedish database exceptions; hide everything else.
  if (/^(Du |Endast |Dokument|Profilens|Godkända|Behörighet)/.test(message)) return { ok: false, error: message };
  return { ok: false, error: fallback };
}

function refreshAdmin() {
  revalidatePath("/admin", "layout");
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const inviteSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  role,
  groupIds: z.array(uuid).max(50),
});

export async function inviteUserAction(input: z.input<typeof inviteSchema>): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Kontrollera namn, e-postadress och roll." };
  const { email, fullName, groupIds } = parsed.data;

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${serverEnv().NEXT_PUBLIC_SITE_URL}/auth/confirm`,
  });
  if (error || !data.user) {
    return {
      ok: false,
      error: error?.code === "email_exists" ? "Det finns redan en användare med den e-postadressen." : "Inbjudan kunde inte skickas.",
    };
  }

  // Role, inviter and groups are set by the admin's own session (audited).
  const supabase = await createSupabaseServerClient();
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ role: parsed.data.role, invited_by: session.user.id, full_name: fullName })
    .eq("id", data.user.id);
  if (profileError) return fail(profileError, "Användaren bjöds in men rollen kunde inte sättas.");

  if (groupIds.length) {
    const { error: groupError } = await supabase
      .from("group_members")
      .insert(groupIds.map((group_id) => ({ group_id, user_id: data.user.id })));
    if (groupError) return fail(groupError, "Användaren bjöds in men grupperna kunde inte sättas.");
  }

  await logSecurityEvent("admin.user_invited", {
    actorId: session.user.id,
    targetType: "profiles",
    targetId: data.user.id,
    metadata: { role: parsed.data.role, groups: groupIds.length },
  });
  refreshAdmin();
  return { ok: true, message: `En inbjudan har skickats till ${email}.` };
}

export async function resendInviteAction(userId: string): Promise<ActionResult> {
  await requireSystemAdmin();
  if (!uuid.safeParse(userId).success) return { ok: false, error: "Ogiltig användare." };
  const supabase = await createSupabaseServerClient();
  const { data: profile } = await supabase.from("profiles").select("email, status").eq("id", userId).maybeSingle();
  if (!profile || profile.status !== "invited") return { ok: false, error: "Användaren är inte inbjuden." };

  const { error } = await createSupabaseAdminClient().auth.admin.inviteUserByEmail(profile.email, {
    redirectTo: `${serverEnv().NEXT_PUBLIC_SITE_URL}/auth/confirm`,
  });
  if (error) return { ok: false, error: "Inbjudan kunde inte skickas igen." };
  return { ok: true, message: "Inbjudan har skickats igen." };
}

export async function setUserRoleAction(userId: string, newRole: string): Promise<ActionResult> {
  await requireSystemAdmin();
  const parsed = z.object({ userId: uuid, role }).safeParse({ userId, role: newRole });
  if (!parsed.success) return { ok: false, error: "Ogiltig roll." };
  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("profiles")
    .update({ role: parsed.data.role }, { count: "exact" })
    .eq("id", parsed.data.userId);
  if (error) return fail(error, "Rollen kunde inte ändras.");
  if (!count) return { ok: false, error: "Användaren hittades inte." };
  refreshAdmin();
  return { ok: true, message: "Rollen har ändrats." };
}

/**
 * Disable: profile status + ban in Auth (existing refresh tokens stop
 * working). Enable: lift the ban; the user becomes active again if they have
 * completed TOTP, otherwise invited.
 */
export async function setUserEnabledAction(userId: string, enabled: boolean): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!uuid.safeParse(userId).success) return { ok: false, error: "Ogiltig användare." };
  if (userId === session.user.id) return { ok: false, error: "Du kan inte inaktivera ditt eget konto." };

  const supabase = await createSupabaseServerClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("mfa_enrolled_at")
    .eq("id", userId)
    .maybeSingle<{ mfa_enrolled_at: string | null }>();
  if (!profile) return { ok: false, error: "Användaren hittades inte." };

  const status = enabled ? (profile.mfa_enrolled_at ? "active" : "invited") : "disabled";
  const { error } = await supabase.from("profiles").update({ status }).eq("id", userId);
  if (error) return fail(error, "Statusen kunde inte ändras.");

  const { error: banError } = await createSupabaseAdminClient().auth.admin.updateUserById(userId, {
    ban_duration: enabled ? "none" : "876000h",
  });
  if (banError) console.error("[admin] ban update failed", banError.message);

  refreshAdmin();
  return { ok: true, message: enabled ? "Kontot har aktiverats." : "Kontot har inaktiverats." };
}

export async function setUserGroupsAction(userId: string, groupIds: string[]): Promise<ActionResult> {
  await requireSystemAdmin();
  const parsed = z.object({ userId: uuid, groupIds: z.array(uuid).max(100) }).safeParse({ userId, groupIds });
  if (!parsed.success) return { ok: false, error: "Ogiltiga grupper." };

  const supabase = await createSupabaseServerClient();
  const { data: current } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("user_id", userId)
    .returns<{ group_id: string }[]>();
  const before = new Set((current ?? []).map((m) => m.group_id));
  const after = new Set(parsed.data.groupIds);
  const toAdd = [...after].filter((g) => !before.has(g));
  const toRemove = [...before].filter((g) => !after.has(g));

  if (toAdd.length) {
    const { error } = await supabase.from("group_members").insert(toAdd.map((group_id) => ({ group_id, user_id: userId })));
    if (error) return fail(error, "Grupperna kunde inte uppdateras.");
  }
  if (toRemove.length) {
    const { error } = await supabase.from("group_members").delete().eq("user_id", userId).in("group_id", toRemove);
    if (error) return fail(error, "Grupperna kunde inte uppdateras.");
  }
  refreshAdmin();
  return { ok: true, message: "Grupperna har uppdaterats." };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300),
});

export async function saveGroupAction(
  groupId: string | null,
  input: z.input<typeof groupSchema>,
): Promise<ActionResult> {
  await requireSystemAdmin();
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Ange ett namn (högst 80 tecken)." };
  const supabase = await createSupabaseServerClient();
  const { error } = groupId
    ? await supabase.from("groups").update(parsed.data).eq("id", groupId)
    : await supabase.from("groups").insert(parsed.data);
  if (error) {
    return error.code === "23505"
      ? { ok: false, error: "Det finns redan en grupp med det namnet." }
      : fail(error, "Gruppen kunde inte sparas.");
  }
  refreshAdmin();
  return { ok: true, message: groupId ? "Gruppen har sparats." : "Gruppen har skapats." };
}

export async function deleteGroupAction(groupId: string): Promise<ActionResult> {
  await requireSystemAdmin();
  if (!uuid.safeParse(groupId).success) return { ok: false, error: "Ogiltig grupp." };
  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase.from("groups").delete({ count: "exact" }).eq("id", groupId);
  if (error) {
    return error.code === "23503"
      ? { ok: false, error: "Gruppen äger dokument. Flytta eller ta bort dokumenten först." }
      : fail(error, "Gruppen kunde inte tas bort.");
  }
  if (!count) return { ok: false, error: "Gruppen kan inte tas bort." };
  refreshAdmin();
  return { ok: true, message: "Gruppen har tagits bort." };
}

const membersSchema = z.array(z.object({ userId: uuid, isManager: z.boolean() })).max(500);

/** Replaces the member list of a (non-system) group. */
export async function setGroupMembersAction(
  groupId: string,
  members: z.input<typeof membersSchema>,
): Promise<ActionResult> {
  await requireSystemAdmin();
  const parsed = membersSchema.safeParse(members);
  if (!uuid.safeParse(groupId).success || !parsed.success) return { ok: false, error: "Ogiltiga medlemmar." };

  const supabase = await createSupabaseServerClient();
  const { data: current } = await supabase
    .from("group_members")
    .select("user_id, is_manager")
    .eq("group_id", groupId)
    .returns<{ user_id: string; is_manager: boolean }[]>();
  const before = new Map((current ?? []).map((m) => [m.user_id, m.is_manager]));
  const after = new Map(parsed.data.map((m) => [m.userId, m.isManager]));

  const toRemove = [...before.keys()].filter((id) => !after.has(id));
  const toUpsert = [...after].filter(([id, mgr]) => before.get(id) !== mgr);

  if (toRemove.length) {
    const { error } = await supabase.from("group_members").delete().eq("group_id", groupId).in("user_id", toRemove);
    if (error) return fail(error, "Medlemmarna kunde inte sparas.");
  }
  if (toUpsert.length) {
    const { error } = await supabase
      .from("group_members")
      .upsert(toUpsert.map(([user_id, is_manager]) => ({ group_id: groupId, user_id, is_manager })));
    if (error) return fail(error, "Medlemmarna kunde inte sparas.");
  }
  refreshAdmin();
  return { ok: true, message: "Medlemmarna har sparats." };
}

// ---------------------------------------------------------------------------
// Assistant access
// ---------------------------------------------------------------------------

const grantChangesSchema = z
  .array(z.object({ groupId: uuid, assistantId: uuid, granted: z.boolean() }))
  .max(500);

export async function saveGroupGrantsAction(changes: z.input<typeof grantChangesSchema>): Promise<ActionResult> {
  await requireSystemAdmin();
  const parsed = grantChangesSchema.safeParse(changes);
  if (!parsed.success) return { ok: false, error: "Ogiltiga ändringar." };
  const supabase = await createSupabaseServerClient();

  for (const change of parsed.data) {
    // Plain insert: the uniqueness index is partial, which PostgREST's
    // on_conflict cannot target. An existing grant (23505) is fine.
    const { error } = change.granted
      ? await supabase
          .from("assistant_grants")
          .insert({ assistant_id: change.assistantId, group_id: change.groupId })
          .then((r) => (r.error?.code === "23505" ? { ...r, error: null } : r))
      : await supabase
          .from("assistant_grants")
          .delete()
          .eq("assistant_id", change.assistantId)
          .eq("group_id", change.groupId);
    if (error) return fail(error, "Behörigheterna kunde inte sparas.");
  }
  refreshAdmin();
  return { ok: true, message: "Behörigheterna har sparats." };
}

export async function addUserGrantAction(userId: string, assistantId: string): Promise<ActionResult> {
  await requireSystemAdmin();
  if (!uuid.safeParse(userId).success || !uuid.safeParse(assistantId).success) {
    return { ok: false, error: "Ogiltig tilldelning." };
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("assistant_grants").insert({ user_id: userId, assistant_id: assistantId });
  if (error) {
    return error.code === "23505"
      ? { ok: false, error: "Användaren har redan den assistenten." }
      : fail(error, "Tilldelningen kunde inte sparas.");
  }
  refreshAdmin();
  return { ok: true, message: "Assistenten har tilldelats." };
}

export async function removeGrantAction(grantId: string): Promise<ActionResult> {
  await requireSystemAdmin();
  if (!uuid.safeParse(grantId).success) return { ok: false, error: "Ogiltig tilldelning." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("assistant_grants").delete().eq("id", grantId);
  if (error) return fail(error, "Tilldelningen kunde inte tas bort.");
  refreshAdmin();
  return { ok: true, message: "Tilldelningen har tagits bort." };
}

// ---------------------------------------------------------------------------
// Assistant configuration (admins and the assistant's managers)
// ---------------------------------------------------------------------------

const assistantSchema = z.object({
  status: z.enum(["active", "draft", "paused"]),
  suggestedPrompts: z.array(z.string().trim().min(1).max(200)).max(6),
});

export async function saveAssistantAction(
  assistantId: string,
  input: z.input<typeof assistantSchema>,
): Promise<ActionResult> {
  const session = await getSession();
  if (!roleHas(session.user.role, "assistants.configure")) return { ok: false, error: "Behörighet saknas." };
  const parsed = assistantSchema.safeParse(input);
  if (!uuid.safeParse(assistantId).success || !parsed.success) {
    return { ok: false, error: "Kontrollera status och förslag (högst sex, 200 tecken var)." };
  }
  const supabase = await createSupabaseServerClient();
  const { error, count } = await supabase
    .from("assistants")
    .update(
      {
        status: parsed.data.status,
        suggested_prompts: parsed.data.suggestedPrompts,
      },
      { count: "exact" },
    )
    .eq("id", assistantId);
  if (error) return fail(error, "Assistenten kunde inte sparas.");
  if (!count) return { ok: false, error: "Du ansvarar inte för den här assistenten." };
  refreshAdmin();
  return { ok: true, message: "Assistenten har sparats." };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Deletes conversations inactive since before `date` (≥ 12 months, enforced in the database). */
export async function purgeConversationsAction(date: string): Promise<ActionResult> {
  await requireSystemAdmin();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Ogiltigt datum." };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("purge_conversations", {
    p_inactive_before: `${date}T00:00:00+00:00`,
  });
  if (error) {
    return {
      ok: false,
      error: error.message.startsWith("Gallring") ? error.message : "Gallringen kunde inte genomföras.",
    };
  }
  refreshAdmin();
  return { ok: true, message: `${Number(data)} konversationer har tagits bort.` };
}

/**
 * Removes a user's TOTP factors (lost phone). The user must enrol a new
 * factor at next sign-in; existing sessions are signed out.
 */
export async function resetUserMfaAction(userId: string): Promise<ActionResult> {
  const session = await requireSystemAdmin();
  if (!uuid.safeParse(userId).success) return { ok: false, error: "Ogiltig användare." };
  if (userId === session.user.id) return { ok: false, error: "Du kan inte återställa din egen tvåstegsverifiering." };

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) return { ok: false, error: "Tvåstegsverifieringen kunde inte återställas." };
  for (const factor of data.factors) {
    await admin.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
  }
  await admin.from("profiles").update({ mfa_enrolled_at: null }).eq("id", userId);
  await logSecurityEvent("auth.mfa_reset", { actorId: session.user.id, targetType: "profiles", targetId: userId });
  refreshAdmin();
  return { ok: true, message: "Tvåstegsverifieringen är återställd. Användaren registrerar en ny vid nästa inloggning." };
}
