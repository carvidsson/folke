import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { G, U, seedFixture } from "./fixtures";
import { asAnon, asService, asServiceRollback, asUser, createTestDatabase } from "./harness";

/**
 * Persistent lead analysis (ADR-047): system administrators only, upserts
 * without duplicates, versioned analyses side by side, no deletes by users,
 * and history that can be aggregated over time. Synthetic ids only.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedFixture(db);
}, 60_000);

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const BEHAVIOURS = JSON.stringify({ next_step: { status: "missing", reason: "Inget konkret förslag." } });

async function expectDenied(tx: Transaction, sql: string, params: unknown[] = []) {
  await tx.exec("savepoint denied");
  let failed = false;
  try {
    const result = await tx.query(sql, params);
    // RLS on update/select filters silently: no rows affected counts as denied.
    if (/^\s*(update|delete)/i.test(sql) && (result.affectedRows ?? 0) === 0) failed = true;
  } catch {
    failed = true;
  }
  await tx.exec(failed ? "rollback to savepoint denied" : "release savepoint denied");
  expect(failed, `expected to be denied: ${sql}`).toBe(true);
}

/** Inbox, seller and two leads in September and one in August, as the server writes them. */
async function seedFacts(tx: Transaction) {
  await tx.query(`insert into public.lead_inboxes (hubspot_inbox_id, name) values ('900001', 'Testinkorg')`);
  await tx.query(`insert into public.lead_sellers (hubspot_actor_id, display_name) values ('A-1001', 'Sälja Säljarsson'), ('A-1002', null)`);
  await tx.query(
    `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, source, reply_status, first_response_at, calendar_minutes, business_minutes, owner_actor_id, responder_actor_id)
     values
       ('11', '900001', 1, '2026-09-02T08:00:00Z', 'business_hours', 'form', 'Blocket', 'registered_reply', '2026-09-02T09:00:00Z', 60, 60, 'A-1001', 'A-1001'),
       ('12', '900001', 1, '2026-09-05T10:00:00Z', 'weekend', 'form', 'Blocket', 'no_registered_reply', null, null, null, null, null),
       ('13', '900001', 1, '2026-08-20T10:00:00Z', 'business_hours', 'email', null, 'registered_reply', '2026-08-20T10:30:00Z', 30, 30, 'A-1002', 'A-1002')`,
  );
}

const analysis = (thread: string, version: string, fp: string) =>
  `insert into public.lead_dialogue_analyses (hubspot_thread_id, analysis_version, model, source_fingerprint, seller_actor_id, intent, purchase_intent, car_status, alternative_offered, behaviours, observations, evidence)
   values ('${thread}', '${version}', 'gpt-6-luna', '${fp}', 'A-1001', 'availability', 'interested', 'sold_or_reserved', 'no', '${BEHAVIOURS}', array['Säljaren svarade snabbt.'], 'limited')
   on conflict (hubspot_thread_id, analysis_version, model) do update set source_fingerprint = excluded.source_fingerprint, analysed_at = now()`;

describe("lead analysis store", () => {
  it("system administrators write facts, analyses and runs through their own session", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await tx.query(analysis("11", "lead-ai-2", FP_A));
      await tx.query(
        `insert into public.lead_analysis_runs (hubspot_inbox_id, period_from, period_to, analysis_version, model, facts_version, started_at, leads, dialogues_analysed, analysed_new, reused, facts, counts)
         values ('900001', '2026-09-01', '2026-09-30', 'lead-ai-2', 'gpt-6-luna', 1, now(), 2, 1, 1, 0, '{}', '{}')`,
      );
      const runs = await tx.query<{ created_by: string }>(`select created_by from public.lead_analysis_runs`);
      expect(runs.rows).toEqual([{ created_by: U.admin }]);
      expect((await tx.query(`select 1 from public.lead_threads`)).rows).toHaveLength(3);
    });
  });

  it("upserts without duplicates and keeps versions apart", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await tx.query(analysis("11", "lead-ai-2", FP_A));
      // The same dialogue analysed again after a change: one row, new fingerprint.
      await tx.query(analysis("11", "lead-ai-2", FP_B));
      // The same dialogue with another analysis version: a separate row.
      await tx.query(analysis("11", "lead-ai-3", FP_B));
      const { rows } = await tx.query<{ analysis_version: string; source_fingerprint: string; first_analysed_at: string; analysed_at: string }>(
        `select analysis_version, source_fingerprint, first_analysed_at, analysed_at from public.lead_dialogue_analyses where hubspot_thread_id = '11' order by analysis_version`,
      );
      expect(rows.map((r) => [r.analysis_version, r.source_fingerprint])).toEqual([
        ["lead-ai-2", FP_B],
        ["lead-ai-3", FP_B],
      ]);
      // A plain insert of an existing key is rejected (the unique key holds).
      await expect(
        tx.query(
          `insert into public.lead_dialogue_analyses (hubspot_thread_id, analysis_version, model, source_fingerprint, intent, purchase_intent, car_status, alternative_offered, behaviours, evidence)
           values ('11', 'lead-ai-2', 'gpt-6-luna', '${FP_A}', 'other', 'unclear', 'unknown', 'not_applicable', '{}', 'limited')`,
        ),
      ).rejects.toThrow();
    });
  });

  it("re-saving facts updates the lead instead of adding one", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await tx.query(
        `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status, first_response_at, calendar_minutes, business_minutes, responder_actor_id)
         values ('12', '900001', 1, '2026-09-05T10:00:00Z', 'weekend', 'form', 'registered_reply', '2026-09-07T07:30:00Z', 2730, 30, 'A-1001')
         on conflict (hubspot_thread_id) do update set reply_status = excluded.reply_status, first_response_at = excluded.first_response_at,
           calendar_minutes = excluded.calendar_minutes, business_minutes = excluded.business_minutes, responder_actor_id = excluded.responder_actor_id`,
      );
      const { rows } = await tx.query<{ n: number; first_seen_at: string; updated_at: string }>(
        `select count(*)::int as n from public.lead_threads where hubspot_thread_id = '12'`,
      );
      expect(rows[0].n).toBe(1);
      const status = await tx.query<{ reply_status: string }>(`select reply_status from public.lead_threads where hubspot_thread_id = '12'`);
      expect(status.rows[0].reply_status).toBe("registered_reply");
    });
  });

  it("rejects malformed data instead of storing it", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await expectDenied(tx, analysis("11", "lead-ai-2", "not-a-hash"));
      await expectDenied(tx, analysis("11", "Lead AI 2!", FP_A));
      // A registered reply must have a reply time (and only then).
      await expectDenied(
        tx,
        `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values ('99', '900001', 1, now(), 'weekend', 'form', 'registered_reply')`,
      );
      await expectDenied(tx, `insert into public.lead_sellers (hubspot_actor_id) values ('V-1')`);
      await expectDenied(tx, `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values ('../x', '900001', 1, now(), 'weekend', 'form', 'no_registered_reply')`);
      await expectDenied(tx, analysis("11", "lead-ai-2", FP_A).replace("array['Säljaren svarade snabbt.']", "array['a', 'b', 'c', 'd']"));
    });
  });

  it("is closed to everyone but system administrators", async () => {
    await asService(db, async (tx) => {
      await seedFacts(tx);
      await tx.query(analysis("11", "lead-ai-2", FP_A));
    });
    for (const user of [U.seller, U.salesManager]) {
      await asUser(db, user, async (tx) => {
        for (const table of ["lead_inboxes", "lead_sellers", "lead_threads", "lead_dialogue_analyses", "lead_analysis_runs"]) {
          expect((await tx.query(`select 1 from public.${table}`)).rows, table).toHaveLength(0);
        }
        await expectDenied(tx, `insert into public.lead_inboxes (hubspot_inbox_id, name) values ('900002', 'X')`);
        await expectDenied(tx, `update public.lead_threads set source = 'X'`);
      });
    }
    await asAnon(db, async (tx) => {
      await expectDenied(tx, `select 1 from public.lead_threads`);
    });
    // A system administrator without a completed TOTP session sees nothing either.
    await asUser(db, U.admin, async (tx) => expect((await tx.query(`select 1 from public.lead_threads`)).rows).toHaveLength(0), { aal: "aal1" });
    await asService(db, async (tx) => {
      await tx.query(`delete from public.lead_dialogue_analyses`);
      await tx.query(`delete from public.lead_threads`);
      await tx.query(`delete from public.lead_sellers`);
      await tx.query(`delete from public.lead_inboxes`);
    });
  });

  it("system administrators cannot delete history or write runs in someone else's name", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await expectDenied(tx, `delete from public.lead_threads`);
      await expectDenied(
        tx,
        `insert into public.lead_analysis_runs (hubspot_inbox_id, period_from, period_to, analysis_version, model, facts_version, started_at, leads, dialogues_analysed, analysed_new, reused, facts, counts, created_by)
         values ('900001', '2026-09-01', '2026-09-30', 'lead-ai-2', 'gpt-6-luna', 1, now(), 0, 0, 0, 0, '{}', '{}', '${U.seller}')`,
      );
      await expectDenied(tx, `update public.lead_analysis_runs set cost_usd = 0`);
    });
  });

  it("history can be aggregated per month, seller and analysis version", async () => {
    await asUser(db, U.admin, async (tx) => {
      await seedFacts(tx);
      await tx.query(analysis("11", "lead-ai-2", FP_A));
      const months = await tx.query<{ month: string; leads: number; replied: number; median_business: number }>(
        `select to_char(arrived_at at time zone 'Europe/Stockholm', 'YYYY-MM') as month, count(*)::int as leads,
                count(*) filter (where reply_status = 'registered_reply')::int as replied,
                percentile_cont(0.5) within group (order by business_minutes) as median_business
         from public.lead_threads where hubspot_inbox_id = '900001' group by 1 order by 1`,
      );
      expect(months.rows).toEqual([
        { month: "2026-08", leads: 1, replied: 1, median_business: 30 },
        { month: "2026-09", leads: 2, replied: 1, median_business: 60 },
      ]);
      const perSeller = await tx.query<{ seller: string; status: string; n: number }>(
        `select seller_actor_id as seller, behaviours -> 'next_step' ->> 'status' as status, count(*)::int as n
         from public.lead_dialogue_analyses where analysis_version = 'lead-ai-2' and model = 'gpt-6-luna' group by 1, 2`,
      );
      expect(perSeller.rows).toEqual([{ seller: "A-1001", status: "missing", n: 1 }]);
    });
  });

  it("has no columns for message texts or customer contact details", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'lead\\_%'`,
    );
    const columns = rows.map((r) => r.column_name);
    // Counts such as customer_messages are fine; content and contact details are not.
    // regnr_kind holds only 'plate' | 'virtual' | 'other' (check constraint, tested below), never a number.
    const allowed = new Set(["regnr_kind"]);
    const forbidden = columns.filter((c) => !allowed.has(c) && /^(text|message|messages|body|content|subject|customer_name|name_of_customer)$|email|phone|personnummer|regnr|registration/.test(c));
    expect(forbidden).toEqual([]);
    expect(columns).toContain("customer_messages");
  });
});

/**
 * ADR-048: access per group or user, optionally limited to one region.
 * Setup (as the database owner): two regions, an active inbox in each, an
 * inactive inbox in region A, a lead in each inbox; the sales group may see
 * region A only, the loner user all regions.
 */
describe("lead access per group, user and region", () => {
  const RA = "a0000000-0000-4000-8000-000000000001";
  const RB = "b0000000-0000-4000-8000-000000000002";

  async function setup(tx: Transaction) {
    await tx.query(`insert into public.lead_regions (id, name, sort_order) values ('${RA}', 'Test A', 10), ('${RB}', 'Test B', 11)`);
    await tx.query(
      `insert into public.lead_inboxes (hubspot_inbox_id, name, active, region_id) values
        ('800001', 'A aktiv', true, '${RA}'), ('800002', 'B aktiv', true, '${RB}'), ('800003', 'A inaktiv', false, '${RA}')`,
    );
    await tx.query(
      `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values
        ('701', '800001', 2, '2026-09-02T08:00:00Z', 'business_hours', 'form', 'no_registered_reply'),
        ('702', '800002', 2, '2026-09-02T08:00:00Z', 'business_hours', 'form', 'no_registered_reply'),
        ('703', '800003', 2, '2026-09-02T08:00:00Z', 'business_hours', 'form', 'no_registered_reply')`,
    );
    await tx.query(`insert into public.lead_sellers (hubspot_actor_id, display_name) values ('A-1001', 'Sälja Säljarsson') on conflict do nothing`);
    await tx.query(analysis("701", "lead-ai-3", FP_A));
    await tx.query(analysis("702", "lead-ai-3", FP_A));
    await tx.query(
      `insert into public.lead_analysis_runs (scope_type, hubspot_inbox_id, region_id, period_from, period_to, analysis_version, model, facts_version, started_at, leads, dialogues_analysed, analysed_new, reused, facts, counts, created_by) values
        ('inbox', '800001', null, '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 1, 1, 1, 0, '{}', '{}', '${U.admin}'),
        ('inbox', '800002', null, '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 1, 1, 1, 0, '{}', '{}', '${U.admin}'),
        ('region', null, '${RA}', '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 1, 1, 0, 1, '{}', '{}', '${U.admin}'),
        ('all', null, null, '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 2, 2, 0, 2, '{}', '{}', '${U.admin}')`,
    );
    await tx.query(`insert into public.lead_access_grants (group_id, region_id) values ('${G.sales}', '${RA}')`);
    await tx.query(`insert into public.lead_access_grants (user_id, region_id) values ('${U.loner}', null)`);
    // The Leadanalys assistant (ADR-050): the sales group, and a user without lead access.
    await tx.query(`insert into public.assistant_grants (assistant_id, group_id) select id, '${G.sales}' from public.assistants where slug = 'leadanalys'`);
    await tx.query(`insert into public.assistant_grants (assistant_id, user_id) select id, '${U.mechanic}' from public.assistants where slug = 'leadanalys'`);
  }

  /** As the owner: set up; then as `user` run `fn` (one transaction, rolled back). */
  async function withSetup(user: string, fn: (tx: Transaction) => Promise<void>) {
    await asServiceRollback(db, async (tx) => {
      await tx.exec("reset role");
      await setup(tx);
      const now = Math.floor(Date.now() / 1000);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", amr: [{ method: "password", timestamp: now }, { method: "totp", timestamp: now }] }),
      ]);
      await tx.exec("set local role authenticated");
      await fn(tx);
    });
  }

  const ids = async (tx: Transaction, sql: string) => (await tx.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();

  it("a region-limited group sees only its region's active inboxes and their data", async () => {
    await withSetup(U.seller, async (tx) => {
      expect(await ids(tx, `select hubspot_inbox_id as id from public.lead_inboxes where hubspot_inbox_id like '8000%'`)).toEqual(["800001"]);
      expect(await ids(tx, `select hubspot_thread_id as id from public.lead_threads where hubspot_thread_id like '70%'`)).toEqual(["701"]);
      expect(await ids(tx, `select hubspot_thread_id as id from public.lead_dialogue_analyses where hubspot_thread_id like '70%'`)).toEqual(["701"]);
      expect(await ids(tx, `select coalesce(hubspot_inbox_id, scope_type) as id from public.lead_analysis_runs where analysis_version = 'lead-ai-3'`)).toEqual(["800001", "region"]);
      const access = await tx.query<{ a: { has_access: boolean; all_regions: boolean; region_ids: string[] } }>(`select public.my_lead_access() as a`);
      expect(access.rows[0].a).toMatchObject({ has_access: true, all_regions: false, region_ids: [RA] });
      // Region names are visible; the grants themselves are not.
      expect((await tx.query(`select 1 from public.lead_regions`)).rows.length).toBeGreaterThan(0);
      expect((await tx.query(`select 1 from public.lead_access_grants`)).rows).toHaveLength(0);
    });
  });

  it("a user with access to all regions sees every active inbox, but not inactive ones", async () => {
    await withSetup(U.loner, async (tx) => {
      expect(await ids(tx, `select hubspot_inbox_id as id from public.lead_inboxes where hubspot_inbox_id like '8000%'`)).toEqual(["800001", "800002"]);
      expect(await ids(tx, `select hubspot_thread_id as id from public.lead_threads where hubspot_thread_id like '70%'`)).toEqual(["701", "702"]);
      expect((await tx.query(`select 1 from public.lead_analysis_runs where scope_type = 'all'`)).rows).toHaveLength(1);
    });
  });

  it("users without a grant see nothing", async () => {
    await withSetup(U.mechanic, async (tx) => {
      for (const table of ["lead_regions", "lead_inboxes", "lead_threads", "lead_dialogue_analyses", "lead_analysis_runs", "lead_syncs", "lead_settings", "lead_sellers"]) {
        expect((await tx.query(`select 1 from public.${table}`)).rows, table).toHaveLength(0);
      }
      const access = await tx.query<{ a: { has_access: boolean } }>(`select public.my_lead_access() as a`);
      expect(access.rows[0].a.has_access).toBe(false);
    });
  });

  it("stores only the kind of registration number, from a fixed set (never the number)", async () => {
    await withSetup(U.seller, async (tx) => {
      await tx.query(`update public.lead_threads set regnr_kind = 'virtual' where hubspot_thread_id = '701'`);
      expect((await tx.query<{ k: string }>(`select regnr_kind as k from public.lead_threads where hubspot_thread_id = '701'`)).rows[0].k).toBe("virtual");
      await expectDenied(tx, `update public.lead_threads set regnr_kind = 'ABC123' where hubspot_thread_id = '701'`);
      await expectDenied(tx, `update public.lead_threads set regnr_kind = 'Virtuell' where hubspot_thread_id = '701'`);
    });
  });

  it("a region-limited user can refresh their own region only, and configure nothing", async () => {
    await withSetup(U.seller, async (tx) => {
      await tx.query(`update public.lead_threads set source = 'Blocket' where hubspot_thread_id = '701'`);
      await tx.query(`insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('800001', '2026-09-01', '2026-09-30', true, '${U.seller}')`);
      await expectDenied(tx, `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values ('799', '800002', 2, now(), 'weekend', 'form', 'no_registered_reply')`);
      await expectDenied(tx, `update public.lead_threads set source = 'X' where hubspot_thread_id = '702'`);
      await expectDenied(tx, `insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('800002', '2026-09-01', '2026-09-30', true, '${U.seller}')`);
      await expectDenied(tx, `insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('800001', '2026-09-01', '2026-09-30', true, '${U.admin}')`);
      await expectDenied(tx, `update public.lead_inboxes set active = false where hubspot_inbox_id = '800001'`);
      await expectDenied(tx, `insert into public.lead_regions (name) values ('Kapad')`);
      await expectDenied(tx, `insert into public.lead_access_grants (user_id, region_id) values ('${U.seller}', null)`);
      await expectDenied(tx, `update public.lead_settings set hubspot_thread_url_template = 'https://x.example/{threadId}'`);
      await expectDenied(
        tx,
        `insert into public.lead_analysis_runs (scope_type, region_id, period_from, period_to, analysis_version, model, facts_version, started_at, leads, dialogues_analysed, analysed_new, reused, facts, counts, created_by) values ('all', null, '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 0, 0, 0, 0, '{}', '{}', '${U.seller}')`,
      );
      await tx.query(
        `insert into public.lead_analysis_runs (scope_type, region_id, period_from, period_to, analysis_version, model, facts_version, started_at, leads, dialogues_analysed, analysed_new, reused, facts, counts, created_by) values ('region', '${RA}', '2026-09-01', '2026-09-30', 'lead-ai-3', 'gpt-6-luna', 2, now(), 0, 0, 0, 0, '{}', '{}', '${U.seller}')`,
      );
    });
  });

  /**
   * 20261013090000_lead_rls_performance: the new policies must give exactly what the earlier model gave.
   * The earlier model is still in the database (app.can_read_lead_inbox / app.can_read_lead_thread), so
   * for every user the expected rows are computed with it as the owner (no RLS), and compared with what
   * the same user gets through the new policies – for reading and for writing, per table.
   */
  it("the per-query policies equal the earlier per-row model for every kind of user (read and write)", async () => {
    await asServiceRollback(db, async (tx) => {
      await tx.exec("reset role");
      await setup(tx);
      // More cases: an active inbox without region, analyses for every thread, a sync per inbox,
      // and a user with both a group grant (region A) and a user grant (region B).
      await tx.query(`insert into public.lead_inboxes (hubspot_inbox_id, name, active, region_id) values ('800004', 'Utan region', true, null)`);
      await tx.query(
        `insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values ('704', '800004', 2, '2026-09-02T08:00:00Z', 'business_hours', 'form', 'no_registered_reply')`,
      );
      await tx.query(analysis("703", "lead-ai-3", FP_A));
      await tx.query(analysis("704", "lead-ai-3", FP_A));
      for (const inbox of ["800001", "800002", "800003", "800004"]) {
        await tx.query(`insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('${inbox}', '2026-09-01', '2026-09-30', true, '${U.admin}')`);
      }
      await tx.query(`insert into public.lead_access_grants (user_id, region_id) values ('${U.salesManager}', '${RB}')`);

      const claims = async (user: string, aal: "aal1" | "aal2") => {
        const now = Math.floor(Date.now() / 1000);
        const amr = aal === "aal2" ? [{ method: "password", timestamp: now }, { method: "totp", timestamp: now }] : [{ method: "password", timestamp: now }];
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal, amr })]);
      };
      const set = async (sql: string) => (await tx.query<{ id: string }>(sql)).rows.map((r) => String(r.id)).sort();
      const cases: [string, string, "aal1" | "aal2"][] = [
        ["systemadministratör", U.admin, "aal2"],
        ["systemadministratör utan MFA-session", U.admin, "aal1"],
        ["grupp med region A", U.seller, "aal2"],
        ["grupp A och användare B", U.salesManager, "aal2"],
        ["alla regioner", U.loner, "aal2"],
        ["ingen behörighet", U.mechanic, "aal2"],
        ["spärrad användare", U.disabled, "aal2"],
      ];
      const seen: Record<string, number> = {};
      for (const [label, user, aal] of cases) {
        await claims(user, aal);
        // Earlier model, evaluated as the owner (RLS does not apply to the owner).
        await tx.exec("reset role");
        const expected = {
          threads: await set(`select hubspot_thread_id as id from public.lead_threads where hubspot_thread_id like '70%' and app.can_read_lead_inbox(hubspot_inbox_id)`),
          syncs: await set(`select hubspot_inbox_id as id from public.lead_syncs where hubspot_inbox_id like '8000%' and app.can_read_lead_inbox(hubspot_inbox_id)`),
          analyses: await set(`select hubspot_thread_id as id from public.lead_dialogue_analyses where hubspot_thread_id like '70%' and app.can_read_lead_thread(hubspot_thread_id)`),
          writable: await set(`select hubspot_inbox_id as id from public.lead_inboxes where hubspot_inbox_id like '8000%' and app.can_read_lead_inbox(hubspot_inbox_id)`),
        };
        // New policies, as the user.
        await tx.exec("set local role authenticated");
        const actual = {
          threads: await set(`select hubspot_thread_id as id from public.lead_threads where hubspot_thread_id like '70%'`),
          syncs: await set(`select hubspot_inbox_id as id from public.lead_syncs where hubspot_inbox_id like '8000%'`),
          analyses: await set(`select hubspot_thread_id as id from public.lead_dialogue_analyses where hubspot_thread_id like '70%'`),
          writable: [] as string[],
        };
        // Writing: insert a thread and a sync, update a thread and insert an analysis, per inbox.
        const threadOf: Record<string, string> = { "800001": "701", "800002": "702", "800003": "703", "800004": "704" };
        for (const inbox of ["800001", "800002", "800003", "800004"]) {
          const ok = async (sql: string, params: unknown[] = []) => {
            await tx.exec("savepoint w");
            try {
              const r = await tx.query(sql, params);
              const done = /^\s*update/i.test(sql) ? (r.affectedRows ?? 0) > 0 : true;
              await tx.exec("rollback to savepoint w");
              return done;
            } catch {
              await tx.exec("rollback to savepoint w");
              return false;
            }
          };
          const results = [
            await ok(`insert into public.lead_threads (hubspot_thread_id, hubspot_inbox_id, facts_version, arrived_at, arrival_window, channel, reply_status) values ('79${inbox}', '${inbox}', 2, now(), 'weekend', 'form', 'no_registered_reply')`),
            await ok(`insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('${inbox}', '2026-09-01', '2026-09-30', true, '${user}')`),
            await ok(`update public.lead_threads set source = 'Test' where hubspot_thread_id = '${threadOf[inbox]}'`),
            await ok(analysis(threadOf[inbox], "lead-ai-x", FP_B)),
          ];
          // Either every write is allowed for the inbox or none is – and that must match the earlier model.
          expect(new Set(results).size, `${label} ${inbox}: ${results}`).toBe(1);
          if (results[0]) actual.writable.push(inbox);
        }
        expect(actual, label).toEqual(expected);
        seen[label] = actual.threads.length;
        await tx.exec("reset role");
      }
      // The cases really differ (the comparison is not trivially empty).
      expect(seen).toEqual({
        systemadministratör: 4,
        "systemadministratör utan MFA-session": 0,
        "grupp med region A": 1,
        "grupp A och användare B": 2,
        "alla regioner": 3,
        "ingen behörighet": 0,
        "spärrad användare": 0,
      });
    });
  });

  it("explicitly: a user in region A cannot read or write region B's lead, analysis or sync", async () => {
    await withSetup(U.seller, async (tx) => {
      await tx.exec("reset role");
      await tx.query(`insert into public.lead_syncs (hubspot_inbox_id, period_from, period_to, complete, synced_by) values ('800002', '2026-09-01', '2026-09-30', true, '${U.admin}')`);
      await tx.exec("set local role authenticated");
      expect((await tx.query(`select 1 from public.lead_threads where hubspot_thread_id = '702'`)).rows).toHaveLength(0);
      expect((await tx.query(`select 1 from public.lead_dialogue_analyses where hubspot_thread_id = '702'`)).rows).toHaveLength(0);
      expect((await tx.query(`select 1 from public.lead_syncs where hubspot_inbox_id = '800002'`)).rows).toHaveLength(0);
      // Not even by joining through a table the user may read.
      expect((await tx.query(`select 1 from public.lead_dialogue_analyses a join public.lead_threads t using (hubspot_thread_id) where t.hubspot_inbox_id = '800002'`)).rows).toHaveLength(0);
      await expectDenied(tx, `update public.lead_dialogue_analyses set evidence = 'limited' where hubspot_thread_id = '702'`);
      await expectDenied(tx, analysis("702", "lead-ai-x", FP_B));
      // The helper only reveals what the user may read anyway: region A's active inbox.
      expect((await tx.query<{ a: string[] }>(`select app.readable_lead_inboxes() as a`)).rows[0].a.filter((i) => i.startsWith("8000"))).toEqual(["800001"]);
    });
  });

  it("the helper function is SECURITY DEFINER with an empty search_path and can only be executed by authenticated and service_role", async () => {
    const { rows } = await db.query<{ definer: boolean; config: string[] | null; volatile: string; acl: string }>(
      `select p.prosecdef as definer, p.proconfig as config, p.provolatile as volatile, p.proacl::text as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'readable_lead_inboxes'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ definer: true, volatile: "s", config: ["search_path=\"\""] });
    const grantees = [...rows[0].acl.matchAll(/(\w*)=X/g)].map((m) => m[1] || "PUBLIC").sort();
    expect(grantees.filter((g) => !["postgres", "supabase_admin"].includes(g))).toEqual(["authenticated", "service_role"]);
    for (const role of ["anon", "PUBLIC"]) expect(grantees).not.toContain(role);
  });

  it("an inactive inbox and a removed grant hide the data again", async () => {
    await withSetup(U.seller, async (tx) => {
      await tx.exec("reset role");
      await tx.query(`update public.lead_inboxes set active = false where hubspot_inbox_id = '800001'`);
      await tx.exec("set local role authenticated");
      expect((await tx.query(`select 1 from public.lead_threads where hubspot_thread_id like '70%'`)).rows).toHaveLength(0);
    });
    await withSetup(U.seller, async (tx) => {
      await tx.exec("reset role");
      await tx.query(`delete from public.lead_access_grants where group_id = '${G.sales}'`);
      await tx.exec("set local role authenticated");
      expect((await tx.query(`select 1 from public.lead_inboxes where hubspot_inbox_id like '8000%'`)).rows).toHaveLength(0);
    });
  });
  // --- AI analysis as a server-side job (ADR-051) ----------------------------
  const startJob = (tx: Transaction, inbox: string) =>
    tx.query<{ id: string; status: string; created: boolean }>(
      `select * from public.start_lead_analysis_job($1, '2026-09-01', '2026-09-30', 'lead-ai-3.1', 'gpt-6-luna')`,
      [inbox],
    );
  const updateJob = async (tx: Transaction, id: string, status: string, runId: string | null = null) =>
    (await tx.query<{ ok: boolean }>(`select public.update_lead_analysis_job($1, $2, $3) as ok`, [id, status, runId])).rows[0].ok;
  /** Runs `sql` as the table owner inside the same transaction, then continues as `user`. */
  async function asOwner<T>(tx: Transaction, user: string, fn: () => Promise<T>): Promise<T> {
    await tx.exec("reset role");
    const result = await fn();
    const now = Math.floor(Date.now() / 1000);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", amr: [{ method: "password", timestamp: now }, { method: "totp", timestamp: now }] }),
    ]);
    await tx.exec("set local role authenticated");
    return result;
  }

  it("analysis jobs: one running job per inbox, period and method – a second start joins it (ADR-051)", async () => {
    await withSetup(U.seller, async (tx) => {
      const first = (await startJob(tx, "800001")).rows[0];
      expect(first).toMatchObject({ status: "running", created: true });
      const again = (await startJob(tx, "800001")).rows[0];
      expect(again).toMatchObject({ id: first.id, created: false });
      expect((await tx.query(`select 1 from public.lead_analysis_jobs where hubspot_inbox_id = '800001'`)).rows).toHaveLength(1);
      // Another region's inbox: refused; and nobody writes the table directly.
      await expectDenied(tx, `select * from public.start_lead_analysis_job('800002', '2026-09-01', '2026-09-30', 'lead-ai-3.1', 'gpt-6-luna')`);
      await expectDenied(tx, `insert into public.lead_analysis_jobs (hubspot_inbox_id, period_from, period_to, analysis_version, model) values ('800001', '2026-08-01', '2026-08-31', 'lead-ai-3.1', 'gpt-6-luna')`);
      await expectDenied(tx, `update public.lead_analysis_jobs set status = 'completed' where id = '${first.id}'`);
      await expectDenied(tx, `delete from public.lead_analysis_jobs where id = '${first.id}'`);
    });
  });

  it("analysis jobs: only the starter reports, only with a run of the same inbox; a finished job allows a new one", async () => {
    await withSetup(U.seller, async (tx) => {
      const job = (await startJob(tx, "800001")).rows[0];
      const runs = await asOwner(tx, U.seller, async () =>
        (await tx.query<{ id: string; hubspot_inbox_id: string }>(`select id, hubspot_inbox_id from public.lead_analysis_runs where scope_type = 'inbox'`)).rows,
      );
      const own = runs.find((r) => r.hubspot_inbox_id === "800001")!.id;
      const other = runs.find((r) => r.hubspot_inbox_id === "800002")!.id;
      expect(await updateJob(tx, job.id, "running")).toBe(true);
      expect(await updateJob(tx, job.id, "completed", other)).toBe(false);
      // Someone else (all regions) cannot finish it.
      await asOwner(tx, U.loner, async () => undefined);
      expect(await updateJob(tx, job.id, "failed")).toBe(false);
      await asOwner(tx, U.seller, async () => undefined);
      expect(await updateJob(tx, job.id, "completed", own)).toBe(true);
      expect((await tx.query<{ status: string; run_id: string }>(`select status, run_id from public.lead_analysis_jobs where id = '${job.id}'`)).rows[0]).toEqual({ status: "completed", run_id: own });
      // Done: a finished job is not reopened, and the next start is a new job.
      expect(await updateJob(tx, job.id, "running")).toBe(false);
      const next = (await startJob(tx, "800001")).rows[0];
      expect(next.created).toBe(true);
      expect(next.id).not.toBe(job.id);
    });
  });

  it("analysis jobs: a job that stopped reporting is failed by the next start, which then starts anew", async () => {
    await withSetup(U.seller, async (tx) => {
      const stuck = (await startJob(tx, "800001")).rows[0];
      await asOwner(tx, U.seller, () => tx.query(`update public.lead_analysis_jobs set heartbeat_at = now() - interval '10 minutes', started_at = now() - interval '10 minutes' where id = $1`, [stuck.id]));
      const fresh = (await startJob(tx, "800001")).rows[0];
      expect(fresh.created).toBe(true);
      const old = (await tx.query<{ status: string; error: string }>(`select status, error from public.lead_analysis_jobs where id = '${stuck.id}'`)).rows[0];
      expect(old).toEqual({ status: "failed", error: "Analysen avbröts innan den blev klar." });
    });
  });

  it("analysis jobs: users without access see none, region users only their region's", async () => {
    await withSetup(U.loner, async (tx) => {
      await startJob(tx, "800002");
      await asOwner(tx, U.seller, async () => undefined);
      expect((await tx.query(`select 1 from public.lead_analysis_jobs where hubspot_inbox_id = '800002'`)).rows).toHaveLength(0);
      await asOwner(tx, U.mechanic, async () => undefined);
      expect((await tx.query(`select 1 from public.lead_analysis_jobs`)).rows).toHaveLength(0);
      await expectDenied(tx, `select * from public.start_lead_analysis_job('800001', '2026-09-01', '2026-09-30', 'lead-ai-3.1', 'gpt-6-luna')`);
    });
  });

  // --- Leadanalys in the chat (ADR-050) ------------------------------------
  const leadAssistant = "(select id from public.assistants where slug = 'leadanalys')";

  it("the Leadanalys assistant is marked as such; users can read the kind but never change it", async () => {
    await withSetup(U.seller, async (tx) => {
      const rows = await tx.query<{ kind: string }>(`select kind from public.assistants where slug = 'leadanalys'`);
      expect(rows.rows[0]?.kind).toBe("lead_analysis");
    });
    await withSetup(U.admin, async (tx) => {
      await expectDenied(tx, `update public.assistants set kind = 'documents' where slug = 'leadanalys'`);
      await expectDenied(tx, `update public.assistants set kind = 'lead_analysis' where slug = 'garanti'`);
    });
  });

  it("only users with lead access start lead conversations, and only as data class 'lead'", async () => {
    await withSetup(U.seller, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `insert into public.conversations (user_id, assistant_id, title, data_class) values ('${U.seller}', ${leadAssistant}, 'Leadfråga', 'lead') returning id`,
      );
      expect(created.rows).toHaveLength(1);
      await expectDenied(tx, `insert into public.conversations (user_id, assistant_id, title, data_class) values ('${U.seller}', ${leadAssistant}, 'x', 'internal')`);
      // A document assistant never gets a lead conversation.
      await expectDenied(
        tx,
        `insert into public.conversations (user_id, assistant_id, title, data_class) values ('${U.seller}', (select id from public.assistants where slug = 'salj'), 'x', 'lead')`,
      );
      // The data class cannot be changed afterwards.
      await expectDenied(tx, `update public.conversations set data_class = 'internal' where id = '${created.rows[0].id}'`);
      // The remembered selection: an object of bounded size, on lead conversations only.
      await tx.query(`update public.conversations set lead_context = '{"regionId": null, "preset": "30d"}' where id = '${created.rows[0].id}'`);
      await expectDenied(tx, `update public.conversations set lead_context = '[1, 2]' where id = '${created.rows[0].id}'`);
      await expectDenied(tx, `update public.conversations set lead_context = jsonb_build_object('x', repeat('a', 3000)) where id = '${created.rows[0].id}'`);
    });
    // The assistant grant alone is not enough: no lead access, no lead conversation.
    await withSetup(U.mechanic, async (tx) => {
      await expectDenied(tx, `insert into public.conversations (user_id, assistant_id, title, data_class) values ('${U.mechanic}', ${leadAssistant}, 'x', 'lead')`);
    });
  });

  it("lead_context is only allowed on lead conversations", async () => {
    await withSetup(U.seller, async (tx) => {
      const own = await tx.query<{ id: string }>(`select id from public.conversations where user_id = '${U.seller}' and data_class = 'internal' limit 1`);
      expect(own.rows).toHaveLength(1);
      await expectDenied(tx, `update public.conversations set lead_context = '{}' where id = '${own.rows[0].id}'`);
    });
  });

  it("usage of the lead chat is recorded separately", async () => {
    await asServiceRollback(db, async (tx) => {
      await tx.query(
        `insert into public.ai_usage (kind, user_id, provider, model, input_tokens, output_tokens, cost_usd, cost_sek, estimated, data_class, purpose)
         values ('chat', '${U.seller}', 'openai', 'gpt-6-luna', 1, 1, 0, 0, false, 'lead', 'lead_chat')`,
      );
      await expectDenied(
        tx,
        `insert into public.ai_usage (kind, user_id, provider, model, input_tokens, output_tokens, cost_usd, cost_sek, estimated, data_class, purpose)
         values ('chat', '${U.seller}', 'openai', 'gpt-6-luna', 1, 1, 0, 0, false, 'other', 'lead_chat')`,
      );
    });
  });
});
