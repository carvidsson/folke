import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { C, D, U, seedFixture, type Fixture } from "./fixtures";
import { asAnon, asService, asUser, createTestDatabase } from "./harness";

/**
 * Conversation attachments (ADR-045): owner only, never part of the
 * knowledge base, files queued for removal on every kind of deletion.
 */

let db: PGlite;
let fx: Fixture;
const MODEL = "text-embedding-3-small";

function vec(axis: number) {
  const v = new Array<number>(1536).fill(0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

async function expectDenied(tx: Transaction, sql: string, params: unknown[] = []) {
  await tx.exec("savepoint denied");
  let failed = false;
  try {
    const r = await tx.query(sql, params);
    // An UPDATE/DELETE that RLS filters out affects no rows instead of failing.
    if (/^\s*(update|delete)/i.test(sql) && (r.affectedRows ?? 0) === 0) failed = true;
  } catch {
    failed = true;
  }
  await tx.exec(failed ? "rollback to savepoint denied" : "release savepoint denied");
  expect(failed, `expected to be denied: ${sql}`).toBe(true);
}

const NEW_UPLOAD = `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes)
  values ('document', 'syntetisk-offert.pdf', 'pdf', 'application/pdf', 1000) returning id`;

/** A ready, bound attachment with two chunks, created by the server. */
async function readyAttachment(user: string, conversation: string, text: string, axis = 1) {
  return asService(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.conversation_attachments
         (user_id, conversation_id, kind, file_name, file_type, mime_type, size_bytes, storage_path, status, content_mode)
       values ($1, $2, 'document', 'syntetisk.pdf', 'pdf', 'application/pdf', 1000, $3, 'ready', 'text') returning id`,
      [user, conversation, `${user}/${crypto.randomUUID()}/syntetisk.pdf`],
    );
    const id = rows[0].id;
    await tx.query(
      `insert into public.conversation_attachment_chunks (attachment_id, chunk_index, content, location, embedding, embedding_model)
       values ($1, 0, $2, 's. 1', $3::extensions.halfvec, $4), ($1, 1, 'Leveransvillkor: trettio dagar netto.', 's. 2', $5::extensions.halfvec, $4)`,
      [id, text, vec(axis), MODEL, vec(axis + 1)],
    );
    return id;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedFixture(db);
}, 60_000);

describe("conversation attachments: uploads", () => {
  it("a user can start an upload of their own, but cannot set server fields", async () => {
    await asUser(db, U.seller, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(NEW_UPLOAD);
      expect(rows).toHaveLength(1);
      await expectDenied(
        tx,
        `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes, storage_path)
         values ('document', 'x.pdf', 'pdf', 'application/pdf', 10, 'annan/sökväg.pdf')`,
      );
      await expectDenied(
        tx,
        `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes, status)
         values ('document', 'x.pdf', 'pdf', 'application/pdf', 10, 'ready')`,
      );
      await expectDenied(tx, `update public.conversation_attachments set status = 'ready' where id = $1`, [rows[0].id]);
      await expectDenied(tx, `update public.conversation_attachments set storage_path = 'x' where id = $1`, [rows[0].id]);
    });
  });

  it("rejects wrong combinations of kind and type, and files over 20 MB", async () => {
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(
        tx,
        `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes)
         values ('image', 'x.pdf', 'pdf', 'application/pdf', 10)`,
      );
      await expectDenied(
        tx,
        `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes)
         values ('document', 'x.exe', 'exe', 'application/octet-stream', 10)`,
      );
      await expectDenied(
        tx,
        `insert into public.conversation_attachments (kind, file_name, file_type, mime_type, size_bytes)
         values ('document', 'x.pdf', 'pdf', 'application/pdf', 20971521)`,
      );
    });
  });

  it("binds only to the user's own conversation, and only once", async () => {
    await asUser(db, U.seller, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(NEW_UPLOAD);
      const id = rows[0].id;
      await expectDenied(tx, `update public.conversation_attachments set conversation_id = $2 where id = $1`, [
        id,
        C.mechanicConversation,
      ]);
      const bound = await tx.query(`update public.conversation_attachments set conversation_id = $2 where id = $1`, [
        id,
        C.sellerConversation,
      ]);
      expect(bound.affectedRows).toBe(1);
      await expectDenied(tx, `update public.conversation_attachments set conversation_id = $2 where id = $1`, [
        id,
        C.oldConversation,
      ]);
    });
  });
});

describe("conversation attachments: privacy", () => {
  it("only the owner can see, change or delete an attachment – not administrators or colleagues", async () => {
    const id = await readyAttachment(U.seller, C.sellerConversation, "Syntetisk offert: Testbil Gamma 412 900 kr.");
    for (const other of [U.admin, U.salesManager, U.mechanic, U.loner]) {
      await asUser(db, other, async (tx) => {
        expect((await tx.query(`select id from public.conversation_attachments where id = $1`, [id])).rows).toEqual([]);
        expect(
          (await tx.query(`select id from public.conversation_attachment_chunks where attachment_id = $1`, [id])).rows,
        ).toEqual([]);
        await expectDenied(tx, `delete from public.conversation_attachments where id = $1`, [id]);
      });
    }
    await asAnon(db, async (tx) => {
      await expectDenied(tx, `select id from public.conversation_attachments`);
    });
    await asUser(db, U.seller, async (tx) => {
      expect((await tx.query(`select id from public.conversation_attachments where id = $1`, [id])).rows).toHaveLength(1);
      expect(
        (await tx.query(`select id from public.conversation_attachment_chunks where attachment_id = $1`, [id])).rows,
      ).toHaveLength(2);
    });
  });

  it("users cannot write chunks or touch the deletion queue", async () => {
    const id = await readyAttachment(U.seller, C.sellerConversation, "Syntetisk text.");
    await asUser(db, U.seller, async (tx) => {
      await expectDenied(
        tx,
        `insert into public.conversation_attachment_chunks (attachment_id, chunk_index, content) values ($1, 9, 'Injicerat')`,
        [id],
      );
      await expectDenied(tx, `select * from public.storage_deletion_queue`);
      await expectDenied(tx, `insert into public.storage_deletion_queue (bucket, path, reason) values ('x', 'y', 'z')`);
    });
  });

  it("search finds chunks in the owner's own conversation only", async () => {
    await readyAttachment(U.seller, C.sellerConversation, "Syntetisk offert för Testbil Delta: 455 000 kr inklusive vinterhjul.", 5);
    const search = (tx: Transaction, conversation: string) =>
      tx
        .query<{ content: string; fts_match: boolean; file_name: string }>(
          `select content, fts_match, file_name from public.search_conversation_attachments($1, 'Testbil Delta vinterhjul', $2::extensions.halfvec, $3, 10)`,
          [conversation, vec(5), MODEL],
        )
        .then((r) => r.rows);
    await asUser(db, U.seller, async (tx) => {
      const hits = await search(tx, C.sellerConversation);
      expect(hits[0].content).toContain("Testbil Delta");
      expect(hits[0].fts_match).toBe(true);
      expect(hits.some((h) => h.fts_match === false)).toBe(true);
    });
    for (const other of [U.admin, U.mechanic]) {
      await asUser(db, other, async (tx) => {
        expect(await search(tx, C.sellerConversation)).toEqual([]);
      });
    }
  });

  it("the knowledge-base search never returns attachments", async () => {
    await readyAttachment(U.seller, C.sellerConversation, "Unikt bilageord Kvasirkampanj för Testbil Epsilon.", 7);
    await asUser(db, U.seller, async (tx) => {
      const { rows } = await tx.query<{ content: string }>(
        `select content from public.search_document_context($1, 'Kvasirkampanj Testbil Epsilon', $2::extensions.halfvec, $3, null, 150)`,
        [fx.assistants.sales, vec(7), MODEL],
      );
      expect(rows.some((r) => r.content.includes("Kvasirkampanj"))).toBe(false);
    });
    // And no attachment can ever become a knowledge-base document.
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.documents where id = $1`, [D.campaignApproved]);
    expect(rows[0].n).toBe(1);
  });
});

describe("conversation attachments: deletion queues the files", () => {
  const queued = async (path: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from public.storage_deletion_queue where path = $1`, [path])).rows[0].n;
  const pathOf = async (id: string) =>
    (await db.query<{ storage_path: string }>(`select storage_path from public.conversation_attachments where id = $1`, [id]))
      .rows[0].storage_path;
  /** Like asUser, but committed (so queue rows written by triggers remain). */
  const committedAs = (user: string, fn: (tx: Transaction) => Promise<unknown>) =>
    db.transaction(async (tx) => {
      const now = Math.floor(Date.now() / 1000);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({
          sub: user,
          role: "authenticated",
          aal: "aal2",
          amr: [
            { method: "password", timestamp: now - 60 },
            { method: "totp", timestamp: now - 59 },
          ],
        }),
      ]);
      await tx.exec("set local role authenticated");
      await fn(tx);
    });

  it("when the user removes an attachment", async () => {
    const id = await readyAttachment(U.seller, C.sellerConversation, "Syntetisk text att ta bort.");
    const path = await pathOf(id);
    await committedAs(U.seller, async (tx) => {
      expect((await tx.query(`delete from public.conversation_attachments where id = $1`, [id])).affectedRows).toBe(1);
    });
    expect(await queued(path)).toBe(1);
  });

  it("when the user deletes the conversation (cascade)", async () => {
    const conv = crypto.randomUUID();
    await db.query(`insert into public.conversations (id, user_id, assistant_id, title) values ($1, $2, $3, 'Tillfällig')`, [
      conv,
      U.seller,
      fx.assistants.sales,
    ]);
    const id = await readyAttachment(U.seller, conv, "Syntetisk text i en konversation som raderas.");
    const path = await pathOf(id);
    await committedAs(U.seller, async (tx) => {
      expect((await tx.query(`delete from public.conversations where id = $1`, [conv])).affectedRows).toBe(1);
    });
    expect(await queued(path)).toBe(1);
    expect((await db.query(`select id from public.conversation_attachment_chunks where attachment_id = $1`, [id])).rows).toEqual([]);
  });

  it("when an administrator purges old conversations", async () => {
    const id = await readyAttachment(U.seller, C.oldConversation, "Syntetisk text i en gammal konversation.");
    const path = await pathOf(id);
    await committedAs(U.admin, async (tx) => {
      await tx.query(`select public.purge_conversations(now() - interval '13 months')`);
    });
    expect((await db.query(`select id from public.conversations where id = $1`, [C.oldConversation])).rows).toEqual([]);
    expect(await queued(path)).toBe(1);
  });

  it("when the user account is deleted", async () => {
    const upload = await asService(db, async (tx) => {
      const { rows } = await tx.query<{ storage_path: string }>(
        `insert into public.conversation_attachments (user_id, kind, file_name, file_type, mime_type, size_bytes, storage_path, status)
         values ($1, 'image', 'syntetisk.png', 'png', 'image/png', 100, $2, 'ready') returning storage_path`,
        [U.loner, `${U.loner}/${crypto.randomUUID()}/syntetisk.png`],
      );
      return rows[0];
    });
    await db.query(`delete from public.profiles where id = $1`, [U.loner]);
    expect(await queued(upload.storage_path)).toBe(1);
  });
});

describe("storage and cost tracking", () => {
  it("has a private bucket limited to the supported types and 20 MB", async () => {
    const { rows } = await db.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'conversation-attachments'`,
    );
    expect(rows[0].public).toBe(false);
    expect(Number(rows[0].file_size_limit)).toBe(20 * 1024 * 1024);
    expect(rows[0].allowed_mime_types).toContain("image/png");
    expect(rows[0].allowed_mime_types).not.toContain("image/heic");
  });

  it("records embeddings of attachments as their own purpose", async () => {
    await asService(db, async (tx) => {
      await tx.query(
        `insert into public.ai_usage (user_id, provider, model, purpose) values ($1, 'openai', $2, 'attachment_indexing')`,
        [U.seller, MODEL],
      );
    });
    await expect(
      db.query(`insert into public.ai_usage (user_id, provider, model, purpose) values ($1, 'openai', $2, 'annat')`, [U.seller, MODEL]),
    ).rejects.toThrow();
  });

  it("records lead analysis as its own purpose, without an assistant (ADR-046)", async () => {
    await asService(db, async (tx) => {
      await tx.query(
        `insert into public.ai_usage (user_id, assistant_id, provider, model, purpose, data_class) values ($1, null, 'openai', $2, 'lead_analysis', 'internal')`,
        [U.admin, MODEL],
      );
    });
    // Ordinary users can neither write usage nor see an administrator's.
    await expect(
      asUser(db, U.seller, (tx) =>
        tx.query(`insert into public.ai_usage (user_id, provider, model, purpose) values ($1, 'openai', $2, 'lead_analysis')`, [U.seller, MODEL]),
      ),
    ).rejects.toThrow();
    const seen = await asUser(db, U.seller, (tx) => tx.query(`select 1 from public.ai_usage where purpose = 'lead_analysis'`));
    expect(seen.rows).toHaveLength(0);
  });
});
