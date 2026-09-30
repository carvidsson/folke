import "server-only";

import { notFound } from "next/navigation";
import { connection } from "next/server";

import { canSeeAdministration } from "@/lib/domain/roles";
import type { User } from "@/lib/domain/types";
import { getUser } from "@/server/data/users";
import { DEMO_USER_ID } from "@/mocks/people";

/**
 * Session access – the single seam for "who is the current user".
 *
 * ⚠ PROTOTYPE: there is NO authentication. `getSession()` always returns the
 * same synthetic demo user so the UI can be built. It must be replaced with
 * the real auth provider (planned: Supabase Auth with e-mail, password and
 * mandatory TOTP) before any real data is connected. See docs/ROADMAP.md.
 *
 * Every page, route handler and server action obtains the user through this
 * module, so swapping the implementation does not touch UI code.
 */

export interface Session {
  user: User;
  /** Whether this session comes from the prototype stub. Always true for now. */
  isPrototype: true;
}

export async function getSession(): Promise<Session> {
  // Opt out of static rendering, as a real cookie-based session would.
  await connection();

  const user = await getUser(DEMO_USER_ID);
  if (!user) throw new Error("Demo user missing from mock data");
  return { user, isPrototype: true };
}

/**
 * Guard for administration pages. Call it in every admin page/route – not
 * only in the layout, since layouts do not re-run on client navigation.
 *
 * ⚠ In the prototype the session is fake, so this only demonstrates where
 * the check belongs. Real enforcement also requires database policies.
 */
export async function requireAdministrationAccess(): Promise<Session> {
  const session = await getSession();
  if (!canSeeAdministration(session.user.role)) notFound();
  return session;
}
