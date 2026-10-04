/**
 * LIVE tests of Leadanalys in the chat (ADR-050) against the DEVELOPMENT Supabase project: who may
 * start a lead conversation, what a region-limited user's chat can see (entities, selection, brief),
 * and that a forged page selection never widens it. Synthetic regions, inboxes, sellers and ids only;
 * everything is removed afterwards. No calls to HubSpot or OpenAI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBrief } from "@/server/lead-chat/brief";
import { loadEntities, loadSelection } from "@/server/lead-chat/load";
import { pseudonymsFor } from "@/server/lead-chat/pseudonyms";
import { resolveTurn } from "@/server/lead-chat/scope";

import { assistantId, cleanup, createGroup, createUser, isDevelopmentProject, service, type LiveUser } from "./helpers";

const SEED = String(Date.now()).slice(-8);
const INBOX_A = `981${SEED}`;
const INBOX_B = `982${SEED}`;
const THREAD_A = `9831${SEED}`;
const THREAD_B = `9832${SEED}`;
const SELLER_A = `A-98${SEED}1`;
const SELLER_B = `A-98${SEED}2`;
const TODAY = new Date().toISOString().slice(0, 10);

describe.skipIf(!isDevelopmentProject)("Leadanalys in the chat (live, development project)", () => {
  let admin: LiveUser;
  let regionUser: LiveUser;
  let noLead: LiveUser;
  let regionA: string;
  let regionB: string;
  let lead: string;

  beforeAll(async () => {
    const svc = service();
    admin = await createUser("leadchatadmin", { role: "system_admin" });
    regionUser = await createUser("leadchatregion");
    noLead = await createUser("leadchatingen");
    lead = await assistantId("leadanalys");
    const group = await createGroup("leadchat");
    await svc.from("group_members").insert({ group_id: group, user_id: regionUser.id, is_manager: false });
    const regions = await svc
      .from("lead_regions")
      .insert([
        { name: `Test – chatt A ${SEED}`, sort_order: 910 },
        { name: `Test – chatt B ${SEED}`, sort_order: 911 },
      ])
      .select("id, sort_order");
    const sorted = [...regions.data!].sort((a, b) => a.sort_order - b.sort_order);
    regionA = sorted[0].id;
    regionB = sorted[1].id;
    await svc.from("lead_inboxes").insert([
      { hubspot_inbox_id: INBOX_A, name: `Testchatt A ${SEED}`, active: true, region_id: regionA, facility: "Testort", brand: "Testmärke" },
      { hubspot_inbox_id: INBOX_B, name: `Testchatt B ${SEED}`, active: true, region_id: regionB, facility: "Annanort", brand: "Testmärke" },
    ]);
    await svc.from("lead_sellers").insert([
      { hubspot_actor_id: SELLER_A, display_name: `Livea Chattsdotter${SEED}` },
      { hubspot_actor_id: SELLER_B, display_name: `Liveb Annansson${SEED}` },
    ]);
    const arrived = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const thread = (id: string, inbox: string, seller: string) => ({
      hubspot_thread_id: id,
      hubspot_inbox_id: inbox,
      facts_version: 3,
      arrived_at: arrived,
      arrival_window: "business_hours",
      channel: "form",
      source: "Blocket",
      reply_status: "registered_reply",
      first_response_at: arrived,
      calendar_minutes: 20,
      business_minutes: 20,
      owner_actor_id: seller,
      responder_actor_id: seller,
      seller_messages: 1,
      customer_messages: 1,
    });
    await svc.from("lead_threads").insert([thread(THREAD_A, INBOX_A, SELLER_A), thread(THREAD_B, INBOX_B, SELLER_B)]);
    await svc.from("lead_access_grants").insert({ group_id: group, region_id: regionA });
    await svc.from("assistant_grants").insert([
      { assistant_id: lead, user_id: regionUser.id },
      { assistant_id: lead, user_id: noLead.id },
      { assistant_id: lead, user_id: admin.id },
    ]);
  });

  afterAll(async () => {
    const svc = service();
    await svc.from("conversations").delete().in("user_id", [admin.id, regionUser.id, noLead.id]);
    await svc.from("assistant_grants").delete().eq("assistant_id", lead).in("user_id", [admin.id, regionUser.id, noLead.id]);
    await svc.from("lead_threads").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_access_grants").delete().in("region_id", [regionA, regionB]);
    await svc.from("lead_inboxes").delete().in("hubspot_inbox_id", [INBOX_A, INBOX_B]);
    await svc.from("lead_regions").delete().in("id", [regionA, regionB]);
    await svc.from("lead_sellers").delete().in("hubspot_actor_id", [SELLER_A, SELLER_B]);
    await cleanup();
  });

  it("only users with lead access start lead conversations; the assistant grant alone is not enough", async () => {
    const ok = await regionUser.client.from("conversations").insert({ assistant_id: lead, title: "Test – leadchatt", data_class: "lead" }).select("id").single();
    expect(ok.error).toBeNull();
    const wrongClass = await regionUser.client.from("conversations").insert({ assistant_id: lead, title: "x", data_class: "internal" });
    expect(wrongClass.error).not.toBeNull();
    const denied = await noLead.client.from("conversations").insert({ assistant_id: lead, title: "x", data_class: "lead" });
    expect(denied.error).not.toBeNull();
    // The remembered selection is stored on the conversation; a non-object is refused.
    const state = await regionUser.client.from("conversations").update({ lead_context: { regionId: regionA, preset: "30d" } }).eq("id", ok.data!.id);
    expect(state.error).toBeNull();
    const bad = await regionUser.client.from("conversations").update({ lead_context: [1, 2] }).eq("id", ok.data!.id);
    expect(bad.error).not.toBeNull();
  });

  it("the assistant's kind is readable and cannot be changed through the API", async () => {
    const read = await regionUser.client.from("assistants").select("kind").eq("id", lead).single();
    expect(read.data?.kind).toBe("lead_analysis");
    const change = await admin.client.from("assistants").update({ kind: "documents" }).eq("id", lead);
    expect(change.error).not.toBeNull();
  });

  it("a region-limited user's chat sees only their region: entities, selection and brief", async () => {
    const entities = await loadEntities(regionUser.client, TODAY);
    const inboxes = entities.inboxes.map((i) => i.id);
    expect(inboxes).toContain(INBOX_A);
    expect(inboxes).not.toContain(INBOX_B);
    expect(entities.sellers.map((s) => s.id)).toContain(SELLER_A);
    expect(entities.sellers.map((s) => s.id)).not.toContain(SELLER_B);

    // A forged page selection (the other region's inbox and seller) is dropped, never trusted.
    const turn = resolveTurn({ text: "Hur är svarstiden?", today: TODAY, entities, previous: null, context: { inboxId: INBOX_B, regionId: regionB, sellerId: SELLER_B } });
    expect(turn).toMatchObject({ kind: "answer", state: { inboxId: null, regionId: null, sellerId: null } });
    // Naming the other region's seller is "not found", without revealing anything.
    const named = resolveTurn({ text: `Hur går det för Liveb Annansson${SEED}?`, today: TODAY, entities, previous: null, context: null });
    expect(named.kind).toBe("not_found");

    if (turn.kind !== "answer") throw new Error("expected an answer");
    const loaded = await loadSelection(regionUser.client, { state: turn.state, intents: turn.intents, examples: null, entities, today: TODAY });
    expect(loaded.input.inboxes.map((i) => i.id)).not.toContain(INBOX_B);
    expect(loaded.input.rows.map((r) => r.threadId)).not.toContain(THREAD_B);
    const brief = buildBrief({ ...loaded.input, pseudonyms: pseudonymsFor(entities.sellers, entities.knownNames), now: new Date() });
    expect(brief.text).not.toContain(`Testchatt B ${SEED}`);
    expect(brief.text).not.toMatch(new RegExp(`Chattsdotter|Annansson|${THREAD_A}|${THREAD_B}`));
    // The other region's seller name is masked if typed, never sent as written.
    expect(pseudonymsFor(entities.sellers, entities.knownNames).hide(`och Liveb Annansson${SEED}?`)).toBe("och [namn]?");
  });
});
