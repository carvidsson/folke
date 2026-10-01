import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { D, G, U, seedFixture, type Fixture } from "./fixtures";
import { asService, asServiceRollback, asUser, createTestDatabase } from "./harness";

/**
 * MVP 0.3 data guard: only synthetic documents and synthetic conversations
 * may reach an external AI provider. These tests prove the database
 * enforces the parts that users could otherwise influence.
 */

let db: PGlite;
let fx: Fixture;

const SYN = {
  warranty: "40000000-0000-4000-8000-000000000001",
  sales: "40000000-0000-4000-8000-000000000002",
  conversation: "40000000-0000-4000-8000-000000000003",
};
const MODEL = "text-embedding-3-small";

/** Unit vector along `axis` (1536 dimensions) as a pgvector literal. */
function vec(axis: number) {
  const v = new Array<number>(1536).fill(0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedFixture(db);

  const syntheticDoc = async (id: string, title: string, group: string, assistant: string, chunks: [string, number][]) => {
    await asService(db, async (tx) => {
      await tx.query(
        `insert into public.documents
           (id, title, file_name, mime_type, file_type, size_bytes, collection_id, owner_group_id,
            uploaded_by, internal_only_attested_at, review_status, processing_status, ai_data_class, tags)
         values ($1, $2, $3, 'text/markdown', 'md', 100, $4, $5, $6, now(), 'approved', 'ready',
                 'synthetic', '{syntetisk}')`,
        [id, title, `${id}.md`, fx.collections.warranty, group, U.admin],
      );
      await tx.query(`insert into public.document_assistants values ($1, $2)`, [id, assistant]);
      for (const [i, [content, axis]] of chunks.entries()) {
        await tx.query(
          `insert into public.document_chunks (document_id, chunk_index, content, embedding, embedding_model, embedded_at)
           values ($1, $2, $3, $4::extensions.halfvec, $5, now())`,
          [id, i, content, vec(axis), MODEL],
        );
      }
    });
  };

  await syntheticDoc(SYN.warranty, "Syntetisk garantimanual Blåbär", G.workshop, fx.assistants.warranty, [
    ["Fiktiv modell Blåbär X har tolv års rostskyddsgaranti enligt testdata.", 1],
    ["Kodordet för testdokumentet är Ekorre-17.", 2],
  ]);
  await syntheticDoc(SYN.sales, "Syntetisk säljkampanj", G.sales, fx.assistants.sales, [
    ["Testkampanjen Lingon ger fiktiv rabatt.", 3],
  ]);

  // The mechanic is a test user with AI test access.
  await db.query(`update public.profiles set ai_test_access = true where id = $1`, [U.mechanic]);
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

const insertDocumentSql = (dataClass: string) => `
  insert into public.documents
    (title, file_name, mime_type, file_type, size_bytes, collection_id, owner_group_id,
     internal_only_attested_at, ai_data_class)
  values ('Test', 'test.pdf', 'application/pdf', 'pdf', 10, $1, $2, now(), '${dataClass}')`;

describe("document data class", () => {
  it("existing documents are internal by default", async () => {
    const { rows } = await db.query<{ ai_data_class: string }>(
      `select ai_data_class from public.documents where id = any($1)`,
      [[D.warrantyApproved, D.warrantyPending, D.campaignApproved]],
    );
    expect(rows.map((r) => r.ai_data_class)).toEqual(["internal", "internal", "internal"]);
  });

  it("users (also system administrators) cannot reclassify a document", async () => {
    for (const user of [U.workshopManager, U.admin]) {
      await asUser(db, user, async (tx) => {
        await expectDenied(tx, `update public.documents set ai_data_class = 'synthetic' where id = $1`, [
          D.warrantyApproved,
        ]);
      });
    }
  });

  it("users cannot upload documents marked as synthetic or approved", async () => {
    for (const dataClass of ["synthetic", "approved"]) {
      await asUser(db, U.admin, async (tx) => {
        await expectDenied(tx, insertDocumentSql(dataClass), [fx.collections.warranty, G.workshop]);
      });
    }
  });

  it("not even the server can reclassify existing documents or use the approval class yet", async () => {
    await asServiceRollback(db, async (tx) => {
      await expectDenied(tx, `update public.documents set ai_data_class = 'synthetic' where id = $1`, [
        D.warrantyApproved,
      ]);
      await expectDenied(tx, `update public.documents set ai_data_class = 'internal' where id = $1`, [SYN.warranty]);
      await expectDenied(tx, insertDocumentSql("approved"), [fx.collections.warranty, G.workshop]);
    });
  });

  it("metadata edits by the uploader keep the class", async () => {
    await asUser(db, U.workshopManager, async (tx) => {
      await tx.query(`update public.documents set title = 'Nytt namn', tags = '{syntetisk}' where id = $1`, [
        D.warrantyPending,
      ]);
      const { rows } = await tx.query<{ ai_data_class: string }>(
        `select ai_data_class from public.documents where id = $1`,
        [D.warrantyPending],
      );
      expect(rows[0].ai_data_class).toBe("internal");
    });
  });
});

describe("embeddings", () => {
  it("cannot be stored for internal documents, not even by the server", async () => {
    await asServiceRollback(db, async (tx) => {
      await expectDenied(
        tx,
        `update public.document_chunks set embedding = $2::extensions.halfvec, embedding_model = $3 where document_id = $1`,
        [D.warrantyApproved, vec(1), MODEL],
      );
    });
  });

  it("are stored for synthetic documents", async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from public.document_chunks where document_id = $1 and embedding is not null`,
      [SYN.warranty],
    );
    expect(rows[0].n).toBe(2);
  });

  it("users cannot write embeddings", async () => {
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, `update public.document_chunks set embedding_model = 'x' where document_id = $1`, [
        SYN.warranty,
      ]);
    });
  });
});

describe("AI test access and synthetic conversations", () => {
  it("users cannot grant themselves AI test access", async () => {
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(tx, `update public.profiles set ai_test_access = true where id = $1`, [U.seller]);
    });
  });

  it("only users with AI test access can start a synthetic conversation", async () => {
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(
        tx,
        `insert into public.conversations (assistant_id, data_class) values ($1, 'synthetic')`,
        [fx.assistants.sales],
      );
    });
    await asUser(db, U.mechanic, async (tx) => {
      const { rows } = await tx.query<{ data_class: string }>(
        `insert into public.conversations (assistant_id, data_class) values ($1, 'synthetic') returning data_class`,
        [fx.assistants.warranty],
      );
      expect(rows[0].data_class).toBe("synthetic");
    });
  });

  it("new conversations are internal by default", async () => {
    await asUser(db, U.seller, async (tx) => {
      const { rows } = await tx.query<{ data_class: string }>(
        `insert into public.conversations (assistant_id) values ($1) returning data_class`,
        [fx.assistants.sales],
      );
      expect(rows[0].data_class).toBe("internal");
    });
  });

  it("a conversation's data class cannot be changed", async () => {
    await db.query(
      `insert into public.conversations (id, user_id, assistant_id, data_class) values ($1, $2, $3, 'internal')`,
      [SYN.conversation, U.mechanic, fx.assistants.warranty],
    );
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, `update public.conversations set data_class = 'synthetic' where id = $1`, [
        SYN.conversation,
      ]);
    });
  });

  it("revoking test access blocks new synthetic conversations", async () => {
    await db.query(`update public.profiles set ai_test_access = false where id = $1`, [U.mechanic]);
    try {
      await asUser(db, U.mechanic, async (tx) => {
        await expectDenied(
          tx,
          `insert into public.conversations (assistant_id, data_class) values ($1, 'synthetic')`,
          [fx.assistants.warranty],
        );
      });
    } finally {
      await db.query(`update public.profiles set ai_test_access = true where id = $1`, [U.mechanic]);
    }
  });
});

describe("hybrid search", () => {
  type Hit = { document_id: string; ai_data_class: string; content: string };
  const search = (
    tx: Transaction,
    assistant: string,
    query: string,
    opts: { axis?: number; model?: string; dataClass?: string | null } = {},
  ) =>
    tx
      .query<Hit>(
        `select document_id, ai_data_class, content
         from public.search_document_chunks_hybrid($1, $2, $3::extensions.halfvec, $4, $5, 8)`,
        [assistant, query, opts.axis === undefined ? null : vec(opts.axis), opts.model ?? MODEL, opts.dataClass ?? null],
      )
      .then((r) => r.rows);

  it("restricted to synthetic documents, it never returns internal documents", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const hits = await search(tx, fx.assistants.warranty, "laddkabel garanti rostskyddsgaranti", {
        axis: 1,
        dataClass: "synthetic",
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.ai_data_class === "synthetic")).toBe(true);
      expect(hits.map((h) => h.document_id)).not.toContain(D.warrantyApproved);
    });
  });

  it("finds semantic matches without shared words (vector search)", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const hits = await search(tx, fx.assistants.warranty, "hemligt lösen", { axis: 2, dataClass: "synthetic" });
      expect(hits[0]?.content).toContain("Ekorre-17");
    });
  });

  it("ignores vectors from another embedding model", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const hits = await search(tx, fx.assistants.warranty, "hemligt lösen", {
        axis: 2,
        model: "annan-modell",
        dataClass: "synthetic",
      });
      expect(hits).toEqual([]);
    });
  });

  it("combines full-text and vector hits", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const hits = await search(tx, fx.assistants.warranty, "laddkabel", { axis: 2 });
      const docs = hits.map((h) => h.document_id);
      expect(docs).toContain(D.warrantyApproved); // full text
      expect(docs).toContain(SYN.warranty); // vector
      expect(docs).not.toContain(D.warrantyPending);
      expect(docs).not.toContain(D.warrantyExpired);
    });
  });

  it("respects group sharing and assistant links", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      // The synthetic sales document is shared with sales only.
      expect(await search(tx, fx.assistants.sales, "Lingon", { axis: 3 })).toEqual([]);
    });
    await asUser(db, U.seller, async (tx) => {
      expect(await search(tx, fx.assistants.warranty, "Ekorre", { axis: 2 })).toEqual([]);
      const hits = await search(tx, fx.assistants.sales, "Lingon", { axis: 3, dataClass: "synthetic" });
      expect(hits.map((h) => h.document_id)).toEqual([SYN.sales]);
    });
  });

  it("returns nothing when assistant access is revoked", async () => {
    await asUser(db, U.loner, async (tx) => {
      expect(await search(tx, fx.assistants.warranty, "Ekorre", { axis: 2 })).toEqual([]);
    });
  });
});

describe("assistant model choice", () => {
  it("is readable but not writable by assistant managers", async () => {
    await asUser(db, U.salesManager, async (tx) => {
      const { rows } = await tx.query<{ ai_model: string | null }>(
        `select ai_model from public.assistants where id = $1`,
        [fx.assistants.sales],
      );
      expect(rows[0].ai_model).toBeNull();
      await expectDenied(tx, `update public.assistants set ai_model = 'gpt-6-astra' where id = $1`, [
        fx.assistants.sales,
      ]);
    });
  });

  it("rejects malformed model names", async () => {
    await asServiceRollback(db, async (tx) => {
      await expectDenied(tx, `update public.assistants set ai_model = 'Model; drop' where id = $1`, [
        fx.assistants.sales,
      ]);
    });
  });
});

describe("AI request limits", () => {
  const begin = (tx: Transaction, user: string | null, opts: Partial<Record<string, number>> = {}) =>
    tx
      .query<{ r: { ok: boolean; reason?: string; request_id?: string } }>(
        `select public.ai_begin_request($1, 'chat', $2, $3, $4, $5) as r`,
        [user, opts.concurrent ?? 2, opts.perMinute ?? 10, opts.daily ?? 1, opts.monthly ?? 10],
      )
      .then((res) => res.rows[0].r);

  it("are not available to users", async () => {
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, `select * from public.ai_requests`);
      await expectDenied(tx, `select public.ai_begin_request($1, 'chat', 2, 10, 1, 10)`, [U.admin]);
    });
  });

  it("limit concurrent requests and release them when finished", async () => {
    await asServiceRollback(db, async (tx) => {
      const a = await begin(tx, U.mechanic);
      const b = await begin(tx, U.mechanic);
      expect(a.ok && b.ok).toBe(true);
      expect(await begin(tx, U.mechanic)).toEqual({ ok: false, reason: "concurrency" });
      await tx.query(`select public.ai_finish_request($1, 'completed')`, [a.request_id]);
      expect((await begin(tx, U.mechanic)).ok).toBe(true);
    });
  });

  it("limit requests per minute", async () => {
    await asServiceRollback(db, async (tx) => {
      for (let i = 0; i < 3; i++) {
        const r = await begin(tx, U.seller, { concurrent: 10, perMinute: 3 });
        await tx.query(`select public.ai_finish_request($1, 'completed')`, [r.request_id]);
      }
      expect(await begin(tx, U.seller, { concurrent: 10, perMinute: 3 })).toEqual({
        ok: false,
        reason: "rate_limit",
      });
    });
  });

  it("stop at the user's daily and the monthly budget", async () => {
    await asServiceRollback(db, async (tx) => {
      await tx.query(
        `insert into public.ai_usage (user_id, provider, model, cost_usd) values ($1, 'openai', 'x', 0.6)`,
        [U.workshopManager],
      );
      expect((await begin(tx, U.workshopManager, { daily: 1 })).ok).toBe(true);
      expect(await begin(tx, U.workshopManager, { daily: 0.5 })).toEqual({ ok: false, reason: "user_daily_budget" });
      expect(await begin(tx, U.seller, { monthly: 0.5 })).toEqual({ ok: false, reason: "monthly_budget" });
    });
  });
});
