import type { LeadStore, NewAnalysis, RunRecord, StoredAnalysis } from "@/server/data/leads";

import type { HubSpotMessage, HubSpotThread } from "./hubspot";

/**
 * Synthetic HubSpot data for unit tests, shaped like the verified API
 * responses (ADR-046). All people, addresses and numbers are invented
 * (domain folke.example).
 */

export const INBOX_ID = "900001";
export const SELLER_A = "A-1001";
export const SELLER_B = "A-1002";
export const CUSTOMER = "V-5001";

export const SYNTHETIC_CUSTOMER = {
  name: "Testa Kundsson",
  email: "testa.kundsson@folke.example",
  phone: "070-000 00 01",
};

export const LISTING_TEXT = [
  "Källa: Blocket",
  `Namn: ${SYNTHETIC_CUSTOMER.name}`,
  `E-post: ${SYNTHETIC_CUSTOMER.email}`,
  `Telefon: ${SYNTHETIC_CUSTOMER.phone}`,
  "Registreringsnummer: Virtuell",
  "Ämne: Nytt meddelande angående: Volkswagen ID.4",
  "Lead meddelande: Hej! Finns bilen kvar?",
  "Jag undrar också: kan ni ta inbyte?",
  "Märke: Volkswagen",
  "Modell: -",
  "Bilkort URL: https://www.blocket.se/mobility/item/1",
  "Mätarställning: 0",
].join("\n");

let seq = 0;
export function message(partial: Partial<HubSpotMessage> & Pick<HubSpotMessage, "type" | "createdAt">): HubSpotMessage {
  seq++;
  return {
    id: `m-${seq}`,
    createdBy: null,
    direction: null,
    channelId: null,
    channelAccountId: null,
    senders: null,
    text: null,
    client: null,
    status: null,
    assignedTo: null,
    toInboxId: null,
    fromInboxId: null,
    ...partial,
  };
}

export function customerMessage(createdAt: string, text: string, channelId = "1003"): HubSpotMessage {
  return message({
    type: "MESSAGE",
    createdAt,
    createdBy: CUSTOMER,
    direction: "INCOMING",
    channelId,
    channelAccountId: "700001",
    senders: [{ actorId: CUSTOMER, name: SYNTHETIC_CUSTOMER.name }],
    text,
    client: { clientType: "HUBSPOT" },
    status: { statusType: "RECEIVED" },
  });
}

export function sellerMessage(createdAt: string, text: string, seller = SELLER_A, name = "Sälja Säljarsson"): HubSpotMessage {
  return message({
    type: "MESSAGE",
    createdAt,
    createdBy: seller,
    direction: "OUTGOING",
    channelId: "1002",
    senders: [{ actorId: seller, name }],
    text,
    client: { clientType: "HUBSPOT" },
    status: { statusType: "SENT" },
  });
}

export function systemEvent(type: string, createdAt: string, extra: Partial<HubSpotMessage> = {}): HubSpotMessage {
  return message({ type, createdAt, createdBy: "S-hubspot", senders: [{ actorId: "S-hubspot" }], client: { clientType: "SYSTEM" }, ...extra });
}

export function thread(partial: Partial<HubSpotThread> & Pick<HubSpotThread, "id" | "createdAt">): HubSpotThread {
  return {
    status: "CLOSED",
    inboxId: INBOX_ID,
    assignedTo: SELLER_A,
    spam: false,
    archived: false,
    latestMessageTimestamp: partial.createdAt,
    originalChannelId: "1003",
    originalChannelAccountId: "700001",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// In-memory LeadStore with the same keys as the database (ADR-047)
// ---------------------------------------------------------------------------


export class MemoryLeadStore implements LeadStore {
  inboxes = new Map<string, string>();
  sellers = new Map<string, string | null>();
  threads = new Map<string, Record<string, unknown>>();
  /** Key: thread|version|model – the database's unique key. */
  analyses = new Map<string, NewAnalysis & { analysisVersion: string; model: string; writes: number }>();
  runs: RunRecord[] = [];

  async saveFacts({ inbox, sellers, rows }: Parameters<LeadStore["saveFacts"]>[0]) {
    this.inboxes.set(inbox.id, inbox.name);
    for (const s of sellers) if (s.name || !this.sellers.has(s.id)) this.sellers.set(s.id, s.name ?? this.sellers.get(s.id) ?? null);
    for (const r of rows) this.threads.set(r.threadId, { ...r });
  }
  async loadAnalyses(threadIds: string[], analysisVersion: string, model: string) {
    const out = new Map<string, StoredAnalysis>();
    for (const id of threadIds) {
      const a = this.analyses.get(`${id}|${analysisVersion}|${model}`);
      if (a) out.set(id, { fingerprint: a.fingerprint, classification: a.classification });
    }
    return out;
  }
  async saveAnalyses(rows: NewAnalysis[], analysisVersion: string, model: string) {
    for (const r of rows) {
      const key = `${r.threadId}|${analysisVersion}|${model}`;
      this.analyses.set(key, { ...r, analysisVersion, model, writes: (this.analyses.get(key)?.writes ?? 0) + 1 });
    }
  }
  async saveRun(run: RunRecord) {
    this.runs.push(run);
  }
  async history() {
    return { months: [], runs: [] };
  }
  /** Everything except the seller table (where employee names belong). */
  analysisData() {
    return JSON.stringify({ threads: [...this.threads.values()], analyses: [...this.analyses.values()], runs: this.runs });
  }
}
