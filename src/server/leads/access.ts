import "server-only";

import { notFound } from "next/navigation";

import type { LeadAccessInfo } from "@/lib/leads/types";
import { logSecurityEvent } from "@/server/audit";
import { getSession, type Session } from "@/server/auth/session";
import { myLeadAccess } from "@/server/data/leads";

/**
 * Who may use the lead analysis (ADR-048). The database is the authority
 * (public.my_lead_access and the RLS policies on every lead table); these
 * helpers make pages and actions refuse early and log the attempt. Hiding a
 * link is never the access control.
 */

export async function leadAccess(): Promise<{ session: Session; access: LeadAccessInfo }> {
  const session = await getSession();
  return { session, access: await myLeadAccess() };
}

/** For pages: 404 (and a log entry) without access. */
export async function requireLeadAccessPage() {
  const result = await leadAccess();
  if (!result.access.hasAccess) {
    await logSecurityEvent("access.denied", { actorId: result.session.user.id, metadata: { area: "leads" } });
    notFound();
  }
  return result;
}

/** For server actions: throws (and logs) without access. */
export async function requireLeadAccess() {
  const result = await leadAccess();
  if (!result.access.hasAccess) {
    await logSecurityEvent("access.denied", { actorId: result.session.user.id, metadata: { area: "leads" } });
    throw new Error("Behörighet saknas");
  }
  return result;
}

/** Configuration: system administrators only. */
export async function requireLeadAdmin() {
  const session = await getSession();
  if (session.user.role !== "system_admin") {
    await logSecurityEvent("access.denied", { actorId: session.user.id, metadata: { area: "leads.admin" } });
    throw new Error("Behörighet saknas");
  }
  return session;
}
