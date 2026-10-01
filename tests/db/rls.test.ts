import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { C, D, G, U, seedFixture, type Fixture } from "./fixtures";
import { asAnon, asService, asUser, createTestDatabase } from "./harness";

let db: PGlite;
let fx: Fixture;

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedFixture(db);
}, 60_000);

const ids = async (tx: Transaction, sql: string, params: unknown[] = []) =>
  (await tx.query<{ id: string }>(sql, params)).rows.map((r) => r.id);

const count = async (tx: Transaction, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) s`, params)).rows[0].n;

/**
 * Expects the statement to fail (RLS violation or explicit exception). Runs
 * inside a savepoint so the surrounding transaction stays usable.
 */
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

describe("session requirements", () => {
  it("anonymous visitors cannot read anything", async () => {
    await asAnon(db, async (tx) => {
      await expectDenied(tx, "select * from public.profiles");
      await expectDenied(tx, "select * from public.conversations");
      await expectDenied(tx, "select * from public.documents");
      await expectDenied(tx, "select * from public.search_document_chunks($1, 'x')", [fx.assistants.warranty]);
    });
  });

  it("aal1 session (password without TOTP) sees only its own profile", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect(await ids(tx, "select id from public.profiles")).toEqual([U.mechanic]);
      expect(await count(tx, "select * from public.conversations")).toBe(0);
      expect(await count(tx, "select * from public.documents")).toBe(0);
      expect(await count(tx, "select * from public.groups")).toBe(0);
      expect(await count(tx, "select id from public.assistants")).toBe(0);
    }, { aal: "aal1" });
  });

  it("sessions older than 7 days are rejected", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect(await count(tx, "select * from public.conversations")).toBe(0);
      expect(await count(tx, "select * from public.documents")).toBe(0);
    }, { sessionAgeHours: 7 * 24 + 1 });
    await asUser(db, U.mechanic, async (tx) => {
      expect(await count(tx, "select * from public.conversations")).toBe(1);
    }, { sessionAgeHours: 6 * 24 });
  });

  it("a reset TOTP enrolment (lost phone) revokes access for existing aal2 sessions", async () => {
    await db.query("update public.profiles set mfa_enrolled_at = null where id = $1", [U.mechanic]);
    await asUser(db, U.mechanic, async (tx) => {
      expect(await count(tx, "select * from public.conversations")).toBe(0);
      expect(await count(tx, "select * from public.documents")).toBe(0);
    });
    await db.query("update public.profiles set mfa_enrolled_at = now() where id = $1", [U.mechanic]);
    await asUser(db, U.mechanic, async (tx) => {
      expect(await count(tx, "select * from public.conversations")).toBe(1);
    });
  });

  it("invited and disabled users get no data", async () => {
    for (const user of [U.invited, U.disabled]) {
      await asUser(db, user, async (tx) => {
        expect(await count(tx, "select * from public.groups")).toBe(0);
        expect(await count(tx, "select id from public.assistants")).toBe(0);
        expect(await count(tx, "select * from public.documents")).toBe(0);
      });
    }
  });
});

describe("conversations are private", () => {
  it("users only see their own conversations and messages", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect(await ids(tx, "select id from public.conversations")).toEqual([C.mechanicConversation]);
      const contents = (await tx.query<{ content: string }>("select content from public.messages")).rows;
      expect(contents.map((m) => m.content)).toEqual(["Hemlig fråga från teknikern"]);
    });
  });

  it("system administrators cannot read other users' conversations", async () => {
    await asUser(db, U.admin, async (tx) => {
      expect(await count(tx, "select * from public.conversations")).toBe(0);
      expect(await count(tx, "select * from public.messages")).toBe(0);
    });
  });

  it("users cannot write into or modify someone else's conversation", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(
        tx,
        "insert into public.messages (conversation_id, role, content) values ($1, 'user', 'x')",
        [C.sellerConversation],
      );
      const upd = await tx.query("update public.conversations set title = 'hack' where id = $1", [C.sellerConversation]);
      expect(upd.affectedRows).toBe(0);
      const del = await tx.query("delete from public.conversations where id = $1", [C.sellerConversation]);
      expect(del.affectedRows).toBe(0);
      const delMsg = await tx.query("delete from public.messages where conversation_id = $1", [C.sellerConversation]);
      expect(delMsg.affectedRows).toBe(0);
    });
  });

  it("users cannot create a conversation owned by someone else", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "insert into public.conversations (user_id, assistant_id) values ($1, $2)", [
        U.seller,
        fx.assistants.warranty,
      ]);
    });
  });

  it("users can only start conversations with assistants they are granted", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const created = await tx.query<{ id: string }>(
        "insert into public.conversations (assistant_id) values ($1) returning id",
        [fx.assistants.warranty],
      );
      expect(created.rows).toHaveLength(1);
      await tx.query("insert into public.conversations (assistant_id) values ($1)", [fx.assistants.meetings]);
      await expectDenied(tx, "insert into public.conversations (assistant_id) values ($1)", [fx.assistants.sales]);
    });
  });

  it("the assistant of a conversation cannot be switched", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "update public.conversations set assistant_id = $1 where id = $2", [
        fx.assistants.meetings,
        C.mechanicConversation,
      ]);
    });
  });
});

describe("assistants", () => {
  it("users see only granted assistants (direct, group or system group)", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const slugs = (await tx.query<{ slug: string }>("select slug from public.assistants order by slug")).rows;
      expect(slugs.map((s) => s.slug)).toEqual(["garanti", "mote"]);
    });
    await asUser(db, U.loner, async (tx) => {
      const slugs = (await tx.query<{ slug: string }>("select slug from public.assistants")).rows;
      expect(slugs.map((s) => s.slug)).toEqual(["mote"]);
    });
  });

  it("instructions are not readable through the API", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "select instructions from public.assistants");
      await expectDenied(tx, "select public.get_assistant_instructions($1)", [fx.assistants.warranty]);
    });
    await asUser(db, U.salesManager, async (tx) => {
      const r = await tx.query<{ t: string }>("select public.get_assistant_instructions($1) as t", [fx.assistants.sales]);
      expect(r.rows[0].t).toContain("Säljassistenten");
    });
  });
});

describe("documents", () => {
  it("group members see approved documents shared with their groups", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect((await ids(tx, "select id from public.documents")).sort()).toEqual(
        [D.warrantyApproved, D.warrantyExpired, D.salesSharedWithWorkshop].sort(),
      );
    });
    await asUser(db, U.seller, async (tx) => {
      expect((await ids(tx, "select id from public.documents")).sort()).toEqual(
        [D.campaignApproved, D.salesSharedWithWorkshop].sort(),
      );
    });
    await asUser(db, U.loner, async (tx) => {
      expect(await count(tx, "select * from public.documents")).toBe(0);
    });
  });

  it("pending documents are visible to the uploader, reviewers and admins only", async () => {
    const pending = "select id from public.documents where id = $1";
    await asUser(db, U.workshopManager, async (tx) => {
      expect(await ids(tx, pending, [D.warrantyPending])).toHaveLength(1);
    });
    await asUser(db, U.admin, async (tx) => {
      expect(await ids(tx, pending, [D.warrantyPending])).toHaveLength(1);
    });
    for (const user of [U.mechanic, U.salesManager, U.seller]) {
      await asUser(db, user, async (tx) => {
        expect(await ids(tx, pending, [D.warrantyPending])).toHaveLength(0);
      });
    }
  });

  it("only reviewers of the owning group (or admins) can approve", async () => {
    const approve = "update public.documents set review_status = 'approved' where id = $1";
    await asUser(db, U.mechanic, async (tx) => {
      expect((await tx.query(approve, [D.warrantyPending])).affectedRows).toBe(0);
    });
    await asUser(db, U.salesManager, async (tx) => {
      expect((await tx.query(approve, [D.warrantyPending])).affectedRows).toBe(0);
    });
    await asUser(db, U.workshopManager, async (tx) => {
      const r = await tx.query<{ review_status: string; reviewed_by: string }>(
        `${approve} returning review_status, reviewed_by`,
        [D.warrantyPending],
      );
      expect(r.rows[0]).toEqual({ review_status: "approved", reviewed_by: U.workshopManager });
    });
    await asUser(db, U.admin, async (tx) => {
      expect((await tx.query(approve, [D.warrantyPending])).affectedRows).toBe(1);
    });
  });

  it("members of a shared (non-owning) group cannot review", async () => {
    // The workshop manager sees the sales-owned document via sharing but does
    // not manage the owning group.
    await asUser(db, U.workshopManager, async (tx) => {
      const r = await tx.query("update public.documents set review_status = 'archived' where id = $1", [
        D.salesSharedWithWorkshop,
      ]);
      expect(r.affectedRows).toBe(0);
    });
  });

  it("group members cannot un-share or edit approved documents", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const del = await tx.query("delete from public.document_shares where document_id = $1", [D.warrantyApproved]);
      expect(del.affectedRows).toBe(0);
      const upd = await tx.query("update public.documents set title = 'x' where id = $1", [D.warrantyApproved]);
      expect(upd.affectedRows).toBe(0);
      const rm = await tx.query("delete from public.documents where id = $1", [D.warrantyApproved]);
      expect(rm.affectedRows).toBe(0);
    });
  });

  it("end users cannot write processing results or chunks", async () => {
    await asUser(db, U.workshopManager, async (tx) => {
      await expectDenied(tx, "update public.documents set processing_status = 'failed' where id = $1", [
        D.warrantyPending,
      ]);
      await expectDenied(
        tx,
        "insert into public.document_chunks (document_id, chunk_index, content) values ($1, 99, 'x')",
        [D.warrantyApproved],
      );
    });
  });

  it("upload rules: employees cannot upload; managers only to their own groups", async () => {
    const sql = `insert into public.documents (title, file_name, mime_type, file_type, size_bytes, collection_id,
        owner_group_id, internal_only_attested_at)
      values ('Nytt', 'nytt.pdf', 'application/pdf', 'pdf', 10, $1, $2, now()) returning id`;
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, sql, [fx.collections.warranty, G.workshop]);
    });
    await asUser(db, U.workshopManager, async (tx) => {
      await expectDenied(tx, sql, [fx.collections.warranty, G.sales]);
      const r = await tx.query<{ id: string }>(sql, [fx.collections.warranty, G.workshop]);
      const shares = await tx.query("select group_id from public.document_shares where document_id = $1", [
        r.rows[0].id,
      ]);
      // Shared within the owning group by default.
      expect(shares.rows).toEqual([{ group_id: G.workshop }]);
    });
  });

  it("uploads without the internal-only attestation are rejected", async () => {
    await asUser(db, U.workshopManager, async (tx) => {
      await expectDenied(
        tx,
        `insert into public.documents (title, file_name, mime_type, file_type, size_bytes, collection_id, owner_group_id)
         values ('X', 'x.pdf', 'application/pdf', 'pdf', 10, $1, $2)`,
        [fx.collections.warranty, G.workshop],
      );
    });
  });

  it("only reviewers or the uploader can change sharing", async () => {
    // A group member who can see the document cannot share it further.
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "insert into public.document_shares values ($1, $2)", [D.warrantyApproved, G.sales]);
    });
    // The reviewer of the owning group may share it with another group.
    await asUser(db, U.workshopManager, async (tx) => {
      await tx.query("insert into public.document_shares values ($1, $2)", [D.warrantyApproved, G.sales]);
    });
  });
});

describe("document search", () => {
  const search = (tx: Transaction, assistant: string, q: string) =>
    tx.query<{ document_id: string; content: string }>(
      "select * from public.search_document_chunks($1, $2, 10)",
      [assistant, q],
    );

  it("returns only approved, valid chunks shared with the user, via the assistant", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const docs = new Set((await search(tx, fx.assistants.warranty, "laddkabel garanti")).rows.map((r) => r.document_id));
      expect(docs).toEqual(new Set([D.warrantyApproved, D.salesSharedWithWorkshop]));
    });
  });

  it("returns nothing through an assistant the user is not granted", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect((await search(tx, fx.assistants.sales, "kampanj företagsleasing")).rows).toHaveLength(0);
    });
  });

  it("does not leak documents from groups the user is not in", async () => {
    await asUser(db, U.seller, async (tx) => {
      expect((await search(tx, fx.assistants.warranty, "laddkabel")).rows).toHaveLength(0);
      const rows = (await search(tx, fx.assistants.sales, "kampanj laddkabel")).rows;
      expect(new Set(rows.map((r) => r.document_id))).toEqual(new Set([D.campaignApproved]));
    });
  });

  it("returns nothing for stale or MFA-less sessions", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      expect((await search(tx, fx.assistants.warranty, "laddkabel")).rows).toHaveLength(0);
    }, { aal: "aal1" });
    await asUser(db, U.mechanic, async (tx) => {
      expect((await search(tx, fx.assistants.warranty, "laddkabel")).rows).toHaveLength(0);
    }, { sessionAgeHours: 200 });
  });

  it("uses Swedish stemming", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const rows = (await search(tx, fx.assistants.warranty, "gälla")).rows;
      expect(rows.map((r) => r.document_id)).toContain(D.warrantyApproved);
    });
  });
});

describe("administration", () => {
  it("users cannot change their own role; metadata cannot grant roles", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const r = await tx.query<{ role: string }>("select role from public.profiles where id = $1", [U.mechanic]);
      expect(r.rows[0].role).toBe("employee"); // despite role in user metadata
      await expectDenied(tx, "update public.profiles set role = 'system_admin' where id = $1", [U.mechanic]);
      await expectDenied(tx, "update public.profiles set status = 'invited' where id = $1", [U.mechanic]);
    });
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, "update public.profiles set role = 'employee' where id = $1", [U.admin]);
    });
  });

  it("users can edit their own profile details but not others'", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      const own = await tx.query("update public.profiles set title = 'Tekniker' where id = $1", [U.mechanic]);
      expect(own.affectedRows).toBe(1);
      const other = await tx.query("update public.profiles set title = 'x' where id = $1", [U.seller]);
      expect(other.affectedRows).toBe(0);
    });
  });

  it("only system administrators manage roles, groups and grants", async () => {
    await asUser(db, U.admin, async (tx) => {
      await tx.query("update public.profiles set role = 'assistant_manager' where id = $1", [U.mechanic]);
      await tx.query("insert into public.group_members (group_id, user_id) values ($1, $2)", [G.sales, U.loner]);
      await tx.query("insert into public.assistant_grants (assistant_id, user_id) values ($1, $2)", [
        fx.assistants.sales,
        U.loner,
      ]);
      await expectDenied(tx, "insert into public.group_members (group_id, user_id) values ($1, $2)", [
        fx.systemGroup,
        U.loner,
      ]);
    });
    await asUser(db, U.salesManager, async (tx) => {
      await expectDenied(tx, "insert into public.group_members (group_id, user_id) values ($1, $2)", [G.sales, U.loner]);
      await expectDenied(tx, "insert into public.assistant_grants (assistant_id, user_id) values ($1, $2)", [
        fx.assistants.sales,
        U.loner,
      ]);
      await expectDenied(tx, "insert into public.groups (name) values ('Ny grupp')");
    });
  });

  it("admin changes are written to the audit log, readable only by admins", async () => {
    await asUser(db, U.admin, async (tx) => {
      await tx.query("update public.profiles set status = 'disabled' where id = $1", [U.loner]);
      const log = await tx.query<{ action: string; actor_id: string; metadata: { status: string } }>(
        "select action, actor_id, metadata from public.audit_log where target_id = $1 and action = 'profiles.update'",
        [U.loner],
      );
      expect(log.rows.at(-1)).toMatchObject({
        action: "profiles.update",
        actor_id: U.admin,
        metadata: { status: "disabled" },
      });
    });
    await asUser(db, U.mechanic, async (tx) => {
      expect(await count(tx, "select * from public.audit_log")).toBe(0);
      await expectDenied(tx, "insert into public.audit_log (action) values ('fake')");
    });
  });

  it("users cannot write cost records; they see only their own", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "insert into public.ai_usage (user_id, provider, model) values ($1, 'x', 'y')", [
        U.mechanic,
      ]);
    });
    await asService(db, (tx) =>
      tx.query("insert into public.ai_usage (user_id, provider, model, input_tokens) values ($1, 'mock', 'mock', 10)", [
        U.seller,
      ]),
    );
    await asUser(db, U.mechanic, async (tx) => expect(await count(tx, "select * from public.ai_usage")).toBe(0));
    await asUser(db, U.seller, async (tx) => expect(await count(tx, "select * from public.ai_usage")).toBe(1));
    await asUser(db, U.admin, async (tx) => expect(await count(tx, "select * from public.ai_usage")).toBe(1));
  });
});

describe("retention review", () => {
  it("is restricted to admins, shows counts only and enforces the 12-month minimum", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "select * from public.conversation_retention_summary()");
      await expectDenied(tx, "select public.purge_conversations(now() - interval '13 months')");
    });
    await asUser(db, U.admin, async (tx) => {
      const summary = await tx.query("select * from public.conversation_retention_summary()");
      expect(summary.fields.map((f) => f.name)).toEqual(["inactive_since", "conversations", "messages"]);
      const rows = summary.rows as { inactive_since: string; conversations: number; messages: number }[];
      expect(rows.find((r) => r.inactive_since === "12–24 månader")).toMatchObject({
        conversations: 1,
        messages: 1,
      });
      await expectDenied(tx, "select public.purge_conversations(now() - interval '6 months')");
      const r = await tx.query<{ n: number }>("select public.purge_conversations(now() - interval '13 months')::int as n");
      expect(r.rows[0].n).toBe(1);
    });
  });
});

describe("table privileges (explicit grants, like current Supabase projects)", () => {
  it("lets the server (service role) set roles for bootstrap and invitations", async () => {
    await asService(db, async (tx) => {
      const r = await tx.query("update public.profiles set role = 'system_admin' where id = $1", [U.loner]);
      expect(r.affectedRows).toBe(1);
      await tx.query("select id from public.conversations limit 1");
    });
    // restore
    await asService(db, (tx) => tx.query("update public.profiles set role = 'employee' where id = $1", [U.loner]));
  });

  it("does not let users write protected profile columns at all", async () => {
    await asUser(db, U.mechanic, async (tx) => {
      await expectDenied(tx, "update public.profiles set email = 'x@folke.example' where id = $1", [U.mechanic]);
      await expectDenied(tx, "update public.profiles set mfa_enrolled_at = now() where id = $1", [U.mechanic]);
      await expectDenied(tx, "insert into public.profiles (id, email) values (gen_random_uuid(), 'x@folke.example')");
    });
  });

  it("gives users no write access to server-owned tables", async () => {
    await asUser(db, U.admin, async (tx) => {
      await expectDenied(tx, "update public.messages set content = 'x'");
      await expectDenied(tx, "delete from public.audit_log");
      await expectDenied(tx, "update public.ai_usage set cost_sek = 0");
      await expectDenied(tx, "delete from public.document_chunks");
    });
  });

  it("gives anonymous visitors no table privileges", async () => {
    const tables = (
      await db.query<{ t: string }>(
        "select relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
      )
    ).rows.map((r) => r.t);
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      const r = await db.query<{ any: boolean }>(
        "select has_table_privilege('anon', $1, 'SELECT') or has_table_privilege('anon', $1, 'INSERT') as any",
        [`public.${t}`],
      );
      expect(r.rows[0].any, `anon has privileges on ${t}`).toBe(false);
    }
  });

  it("grants every public table to the server role", async () => {
    const missing = await db.query<{ t: string }>(
      `select relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`,
    );
    expect(missing.rows).toEqual([]);
  });
});

describe("search excerpts", () => {
  it("returns the passage around the matching terms, not the chunk start", async () => {
    const preamble = "Inledning om planering, uppföljning och ansvarsfördelning under året. ".repeat(12);
    await db.query(
      `insert into public.document_chunks (document_id, chunk_index, content, location) values ($1, 50, $2, 's. 9')`,
      [D.warrantyApproved, `${preamble}Projekt Aurora har kodordet Blå Ekorre och leds av marknad. ${preamble}`],
    );
    await asUser(db, U.mechanic, async (tx) => {
      const rows = (
        await tx.query<{ snippet: string; location: string }>(
          "select snippet, location from public.search_document_chunks($1, $2, 5)",
          [fx.assistants.warranty, "Vad är kodordet för projekt Aurora?"],
        )
      ).rows;
      expect(rows[0].location).toBe("s. 9");
      expect(rows[0].snippet).toContain("Blå Ekorre");
      expect(rows[0].snippet.startsWith("Inledning")).toBe(false);
    });
    await db.query("delete from public.document_chunks where document_id = $1 and chunk_index = 50", [D.warrantyApproved]);
  });
});
