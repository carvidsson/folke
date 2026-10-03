import "server-only";

/**
 * Small in-memory TTL cache for the lead analysis (ADR-046). Nothing from
 * HubSpot is written to the database or to disk: thread histories and AI
 * classifications live only in this server process and expire. Keys include
 * the thread's latest message timestamp, so a thread with new activity is
 * read and analysed again.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    // Oldest first: Map keeps insertion order.
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear() {
    this.entries.clear();
  }
}
