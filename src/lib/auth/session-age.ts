/**
 * Session lifetime rules (decision: sessions may be active for at most 7 days).
 *
 * The session start is the earliest timestamp in the JWT `amr` claim (the
 * first authentication method used in this session). Token refreshes do not
 * change it. The same rule is enforced in the database (app.session_fresh).
 */

export const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

type AmrEntry = { method?: string; timestamp?: number } | string;

/** Session start in ms since epoch, or null when it cannot be determined. */
export function sessionStartedAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  const stamps = (amr as AmrEntry[])
    .map((entry) => (typeof entry === "object" && entry ? entry.timestamp : undefined))
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return stamps.length ? Math.min(...stamps) * 1000 : null;
}

/** Fails closed: an unknown session start counts as expired. */
export function isSessionExpired(amr: unknown, now = Date.now()): boolean {
  const started = sessionStartedAt(amr);
  return started === null || now - started >= MAX_SESSION_MS;
}
