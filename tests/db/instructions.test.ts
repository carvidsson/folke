import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { U, seedFixture, type Fixture } from "./fixtures";
import { asUser, createTestDatabase } from "./harness";

/** Shared instructions, instruction history and personal AI preferences (ADR-037). */

let db: PGlite;
let fx: Fixture;

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedFixture(db);
}, 60_000);

async function expectDenied(tx: Transaction, sql: string, params: unknown[] = []) {
  await tx.exec("savepoint denied");
  let failed = false;
  try {
    await tx.query(sql, params);
  } catch {
    failed = true;
  }
  await tx.exec(failed ? "rollback to savepoint denied" : "release savepoint denied");
  expect(failed, `expected to be denied: ${sql}`).toBe(true);
}

const count = async (tx: Transaction, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) s`, params)).rows[0].n;

describe("organization instructions", () => {
  it("exist with a default text", async () => {
    const { rows } = await db.query<{ content: string }>(`select content from public.organization_instructions`);
    expect(rows).toHaveLength(1);
    // Updated default that leaves room for personal preferences (ADR-038).
    expect(rows[0].content).toContain("Anpassa svarets längd och detaljnivå");
    expect(rows[0].content).not.toContain("kortfattad");
  });

  it("are readable by system administrators and assistant managers only", async () => {
    await asUser(db, U.admin, async (tx) => expect(await count(tx, "select * from public.organization_instructions")).toBe(1));
    await asUser(db, U.salesManager, async (tx) =>
      expect(await count(tx, "select * from public.organization_instructions")).toBe(1),
    );
    for (const user of [U.mechanic, U.seller, U.workshopManager]) {
      await asUser(db, user, async (tx) => expect(await count(tx, "select * from public.organization_instructions")).toBe(0));
    }
  });

  it("are writable by system administrators only, and every change is kept as a revision", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      const { rows } = await tx.query(`update public.organization_instructions set content = 'Kapat' returning id`);
      expect(rows).toHaveLength(0);
    });
    await asUser(db, U.admin, async (tx) => {
      await tx.query(`update public.organization_instructions set content = 'Ny gemensam text'`);
      const { rows } = await tx.query<{ content: string; created_by: string; updated_by: string }>(
        `select r.content, r.created_by, o.updated_by
         from public.instruction_revisions r, public.organization_instructions o
         where r.scope = 'organization' order by r.id desc limit 1`,
      );
      expect(rows[0]).toEqual({ content: "Ny gemensam text", created_by: U.admin, updated_by: U.admin });
      await expectDenied(tx, `update public.organization_instructions set updated_by = null`);
    });
  });

  it("cannot be inserted or deleted through the API", async () => {
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, `insert into public.organization_instructions (id, content) values (true, 'x')`);
      await expectDenied(tx, `delete from public.organization_instructions`);
    });
  });
});

describe("instruction revisions", () => {
  it("record assistant instruction changes with the author", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      await tx.query(`update public.assistants set instructions = 'Säljinstruktion v2 med mer text' where id = $1`, [
        fx.assistants.sales,
      ]);
      const { rows } = await tx.query<{ content: string; created_by: string }>(
        `select content, created_by from public.instruction_revisions
         where scope = 'assistant' and assistant_id = $1 order by id desc limit 1`,
        [fx.assistants.sales],
      );
      expect(rows[0]).toEqual({ content: "Säljinstruktion v2 med mer text", created_by: U.salesManager });
    });
  });

  it("are visible to managers for their own assistants only, and never to employees", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      expect(
        await count(tx, `select * from public.instruction_revisions where assistant_id = $1`, [fx.assistants.sales]),
      ).toBeGreaterThan(0);
      expect(
        await count(tx, `select * from public.instruction_revisions where assistant_id = $1`, [fx.assistants.warranty]),
      ).toBe(0);
    });
    await asUser(db, U.seller, async (tx) => expect(await count(tx, "select * from public.instruction_revisions")).toBe(0));
  });

  it("cannot be written or changed by users", async () => {
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, `insert into public.instruction_revisions (scope, content) values ('organization', 'x')`);
      await expectDenied(tx, `update public.instruction_revisions set content = 'x'`);
      await expectDenied(tx, `delete from public.instruction_revisions`);
    });
  });
});

describe("personal AI preferences", () => {
  it("users can create and change their own preferences", async () => {
    await asUser(db, U.seller, async (tx) => {
      await tx.query(
        `insert into public.user_ai_preferences (answer_length, writing_tone, writing_options, extra_notes)
         values ('short', 'personal', '{no_emojis,we_form}', 'Skriv gärna punktlistor')`,
      );
      await tx.query(`update public.user_ai_preferences set answer_length = 'detailed'`);
      const { rows } = await tx.query<{ user_id: string; answer_length: string }>(
        `select user_id, answer_length from public.user_ai_preferences`,
      );
      expect(rows).toEqual([{ user_id: U.seller, answer_length: "detailed" }]);
    });
  });

  it("are private: administrators and others cannot read or write them", async () => {
    await db.query(`insert into public.user_ai_preferences (user_id, answer_length) values ($1, 'short')`, [U.mechanic]);
    for (const user of [U.admin, U.workshopManager, U.seller]) {
      await asUser(db, user, async (tx) => {
        expect(await count(tx, `select * from public.user_ai_preferences where user_id = $1`, [U.mechanic])).toBe(0);
        const { rows } = await tx.query(`update public.user_ai_preferences set answer_length = 'detailed' where user_id = $1 returning 1`, [
          U.mechanic,
        ]);
        expect(rows).toHaveLength(0);
      });
    }
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(tx, `insert into public.user_ai_preferences (user_id) values ($1)`, [U.mechanic]);
    });
  });

  it("only accept known values", async () => {
    await asUser(db, U.loner, async (tx) => {
      await expectDenied(tx, `insert into public.user_ai_preferences (answer_length) values ('endless')`);
      await expectDenied(tx, `insert into public.user_ai_preferences (writing_options) values ('{ignore_rules}')`);
      await expectDenied(tx, `insert into public.user_ai_preferences (extra_notes) values ($1)`, ["x".repeat(1001)]);
    });
  });

  it("onboarding offer can be set by an administrator; existing users are not offered it", async () => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.profiles where onboarding_offered`);
    expect(rows[0].n).toBe(0);
    await asUser(db, U.admin, async (tx) => {
      const { rows: updated } = await tx.query(`update public.profiles set onboarding_offered = true where id = $1 returning id`, [
        U.seller,
      ]);
      expect(updated).toHaveLength(1);
    });
  });
});

describe("instruction drafts", () => {
  it("default texts no longer ask for short answers; the sales assistant keeps its task", async () => {
    const { rows } = await db.query<{ instructions: string }>(`select instructions from public.assistants where slug = 'salj'`);
    expect(rows[0].instructions).not.toContain("kortfattat");
    expect(rows[0].instructions).toContain("Lämna aldrig bindande prisuppgifter");
  });

  it("a draft does not change the published instructions", async () => {
    await asUser(db, U.admin, async (tx) => {
      const before = (await tx.query<{ content: string }>(`select content from public.organization_instructions`)).rows[0].content;
      await tx.query(`insert into public.instruction_drafts (scope, content) values ('organization', 'Utkast')`);
      const after = (await tx.query<{ content: string }>(`select content from public.organization_instructions`)).rows[0].content;
      expect(after).toBe(before);
      expect(await count(tx, `select * from public.instruction_revisions where content = 'Utkast'`)).toBe(0);
    });
  });

  it("one draft per target", async () => {
    await asUser(db, U.admin, async (tx) => {
      await tx.query(`insert into public.instruction_drafts (scope, content) values ('organization', 'A')`);
      await expectDenied(tx, `insert into public.instruction_drafts (scope, content) values ('organization', 'B')`);
      await tx.query(
        `insert into public.instruction_drafts (scope, content) values ('organization', 'C')
         on conflict (target) do update set content = excluded.content`,
      );
      expect(await count(tx, `select * from public.instruction_drafts`)).toBe(1);
    });
  });

  it("follow the same editing rights as the published texts", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      await expectDenied(tx, `insert into public.instruction_drafts (scope, content) values ('organization', 'x')`);
      await tx.query(`insert into public.instruction_drafts (scope, assistant_id, content) values ('assistant', $1, 'Sälj')`, [
        fx.assistants.sales,
      ]);
      await expectDenied(tx, `insert into public.instruction_drafts (scope, assistant_id, content) values ('assistant', $1, 'x')`, [
        fx.assistants.warranty,
      ]);
    });
    await db.query(`insert into public.instruction_drafts (scope, assistant_id, content) values ('assistant', $1, 'Hemligt utkast')`, [
      fx.assistants.warranty,
    ]);
    for (const user of [U.seller, U.salesManager]) {
      await asUser(db, user, async (tx) => expect(await count(tx, `select * from public.instruction_drafts`)).toBe(0));
    }
    await db.query(`delete from public.instruction_drafts`);
  });

  it("usage of instruction tests is kept apart from conversations", async () => {
    const { rows } = await db.query<{ purpose: string }>(
      `insert into public.ai_usage (provider, model, purpose) values ('openai', 'x', 'instruction_test') returning purpose`,
    );
    expect(rows[0].purpose).toBe("instruction_test");
    await db.query(`delete from public.ai_usage where model = 'x'`);
  });
});

describe("draft saving and publishing with conflict detection", () => {
  const save = (tx: Transaction, content: string, expected: string | null, assistantId: string | null = null) =>
    tx
      .query<{ t: string }>(`select public.save_instruction_draft($1, $2, $3, $4)::text as t`, [
        assistantId ? "assistant" : "organization",
        assistantId,
        content,
        expected,
      ])
      .then((r) => r.rows[0].t);
  const publish = (tx: Transaction, expected: string, assistantId: string | null = null) =>
    tx.query(`select public.publish_instruction_draft($1, $2, $3)`, [assistantId ? "assistant" : "organization", assistantId, expected]);
  const published = (tx: Transaction) =>
    tx.query<{ content: string }>(`select content from public.organization_instructions`).then((r) => r.rows[0].content);

  it("publishing makes the draft active, records a version and removes the draft", async () => {
    await asUser(db, U.admin, async (tx) => {
      const before = await published(tx);
      const t1 = await save(tx, "Utkast 1", null);
      expect(await published(tx)).toBe(before);
      const t2 = await save(tx, "Utkast 2", t1);
      await publish(tx, t2);
      expect(await published(tx)).toBe("Utkast 2");
      expect(await count(tx, `select * from public.instruction_drafts`)).toBe(0);
      expect(await count(tx, `select * from public.instruction_revisions where content = 'Utkast 2'`)).toBe(1);
      expect(await count(tx, `select * from public.instruction_revisions where content = 'Utkast 1'`)).toBe(0);
    });
  });

  it("detects two administrators editing the same draft", async () => {
    await asUser(db, U.admin, async (tx) => {
      const t1 = await save(tx, "Första", null);
      await save(tx, "Den andras ändring", t1); // someone else saved in between
      await expectDenied(tx, `select public.save_instruction_draft('organization', null, 'Min ändring', $1)`, [t1]);
      await expectDenied(tx, `select public.publish_instruction_draft('organization', null, $1)`, [t1]);
      // Starting a new draft while one exists is also a conflict.
      await expectDenied(tx, `select public.save_instruction_draft('organization', null, 'Ny', null)`);
    });
  });

  it("refuses to publish a draft whose published base has changed", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      const t = await save(tx, "Säljutkast med tillräckligt lång text", null, fx.assistants.sales);
      // Published text changes after the draft was created.
      await tx.query(`update public.assistants set instructions = 'Någon annan publicerade detta under tiden' where id = $1`, [
        fx.assistants.sales,
      ]);
      await expectDenied(tx, `select public.publish_instruction_draft('assistant', $1, $2)`, [fx.assistants.sales, t]);
    });
  });

  it("enforces editing rights in the functions too", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      await expectDenied(tx, `select public.save_instruction_draft('organization', null, 'x', null)`);
      await expectDenied(tx, `select public.save_instruction_draft('assistant', $1, 'x', null)`, [fx.assistants.warranty]);
    });
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(tx, `select public.save_instruction_draft('assistant', $1, 'x', null)`, [fx.assistants.sales]);
    });
  });

  it("chat reads only published texts while a draft exists", async () => {
    await asUser(db, U.admin, async (tx) => {
      const before = await published(tx);
      await save(tx, "Får aldrig nå användarna", null);
      await tx.exec("set local role service_role");
      const { rows } = await tx.query<{ content: string }>(`select content from public.organization_instructions`);
      expect(rows[0].content).toBe(before);
    });
  });
});

describe("conflict error code", () => {
  it("is PT409 (HTTP 409), not 40001 which PostgREST would retry", async () => {
    await asUser(db, U.admin, async (tx) => {
      await tx.query(`select public.save_instruction_draft('organization', null, 'A', null)`);
      await tx.exec("savepoint c");
      let code = "";
      try {
        await tx.query(`select public.save_instruction_draft('organization', null, 'B', null)`);
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
      }
      await tx.exec("rollback to savepoint c");
      expect(code).toBe("PT409");
    });
  });
});

describe("personal preferences via upsert (version 2 onboarding)", () => {
  it("the owner can upsert their own row repeatedly", async () => {
    await asUser(db, U.loner, async (tx) => {
      const upsert = (length: string) =>
        tx.query(
          `insert into public.user_ai_preferences (user_id, answer_length) values ($1, $2)
           on conflict (user_id) do update set answer_length = excluded.answer_length`,
          [U.loner, length],
        );
      await upsert("short");
      await upsert("detailed");
      const { rows } = await tx.query<{ answer_length: string }>(`select answer_length from public.user_ai_preferences`);
      expect(rows).toEqual([{ answer_length: "detailed" }]);
    });
  });

  it("a manipulated upsert with another user's id is rejected", async () => {
    await db.query(`insert into public.user_ai_preferences (user_id, answer_length) values ($1, 'short') on conflict do nothing`, [U.workshopManager]);
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(
        tx,
        `insert into public.user_ai_preferences (user_id, answer_length) values ($1, 'detailed')
         on conflict (user_id) do update set answer_length = excluded.answer_length`,
        [U.workshopManager],
      );
    });
    const { rows } = await db.query<{ answer_length: string }>(`select answer_length from public.user_ai_preferences where user_id = $1`, [U.workshopManager]);
    expect(rows[0].answer_length).toBe("short");
  });

  it("users cannot change whether others are offered the onboarding", async () => {
    await asUser(db, U.seller, async (tx) => {
      const { rows } = await tx.query(`update public.profiles set onboarding_offered = true where id = $1 returning id`, [U.mechanic]);
      expect(rows).toHaveLength(0);
    });
  });
});
