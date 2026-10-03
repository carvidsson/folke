import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { U, seedFixture } from "./fixtures";
import { asAnon, asService, asUser, createTestDatabase } from "./harness";

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
    const forbidden = columns.filter((c) => /^(text|message|messages|body|content|subject|customer_name|name_of_customer)$|email|phone|personnummer|regnr|registration/.test(c));
    expect(forbidden).toEqual([]);
    expect(columns).toContain("customer_messages");
  });
});
