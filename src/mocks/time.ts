/** Builds timestamps relative to `now` so mock data always looks recent. */
export function ago(
  now: Date,
  { minutes = 0, hours = 0, days = 0 }: { minutes?: number; hours?: number; days?: number },
): string {
  const ms = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}
