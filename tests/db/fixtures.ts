import type { PGlite } from "@electric-sql/pglite";

/**
 * Synthetic fixture for RLS tests. Inserted as the database owner (bypasses
 * RLS and column protection), mirroring what admin tooling would create.
 */

export const U = {
  admin: "00000000-0000-4000-8000-000000000001",
  workshopManager: "00000000-0000-4000-8000-000000000002",
  mechanic: "00000000-0000-4000-8000-000000000003",
  seller: "00000000-0000-4000-8000-000000000004",
  salesManager: "00000000-0000-4000-8000-000000000005",
  invited: "00000000-0000-4000-8000-000000000006",
  disabled: "00000000-0000-4000-8000-000000000007",
  loner: "00000000-0000-4000-8000-000000000008",
} as const;

export const G = {
  workshop: "10000000-0000-4000-8000-000000000001",
  sales: "10000000-0000-4000-8000-000000000002",
} as const;

export const D = {
  warrantyApproved: "20000000-0000-4000-8000-000000000001",
  warrantyPending: "20000000-0000-4000-8000-000000000002",
  warrantyExpired: "20000000-0000-4000-8000-000000000003",
  campaignApproved: "20000000-0000-4000-8000-000000000004",
  salesSharedWithWorkshop: "20000000-0000-4000-8000-000000000005",
} as const;

export const C = {
  mechanicConversation: "30000000-0000-4000-8000-000000000001",
  sellerConversation: "30000000-0000-4000-8000-000000000002",
  oldConversation: "30000000-0000-4000-8000-000000000003",
} as const;

export interface Fixture {
  assistants: { sales: string; warranty: string; meetings: string; analysis: string };
  collections: { warranty: string; campaigns: string };
  systemGroup: string;
}

export async function seedFixture(db: PGlite): Promise<Fixture> {
  const users: [string, string, string, string][] = [
    [U.admin, "admin@folke.example", "system_admin", "active"],
    [U.workshopManager, "verkstadschef@folke.example", "employee", "active"],
    [U.mechanic, "tekniker@folke.example", "employee", "active"],
    [U.seller, "saljare@folke.example", "employee", "active"],
    [U.salesManager, "saljchef@folke.example", "assistant_manager", "active"],
    [U.invited, "inbjuden@folke.example", "employee", "invited"],
    [U.disabled, "inaktiv@folke.example", "employee", "disabled"],
    [U.loner, "ensam@folke.example", "employee", "active"],
  ];
  for (const [id, email, role, status] of users) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id, email, JSON.stringify({ full_name: email.split("@")[0], role: "system_admin" })],
    );
    await db.query(
      `update public.profiles set role = $2::public.app_role, status = $3::public.user_status,
         mfa_enrolled_at = case when $3::text = 'invited' then null else now() end
       where id = $1`,
      [id, role, status],
    );
  }

  const a = (
    await db.query<{ slug: string; id: string }>(`select slug, id from public.assistants`)
  ).rows;
  const assistants = {
    sales: a.find((x) => x.slug === "salj")!.id,
    warranty: a.find((x) => x.slug === "garanti")!.id,
    meetings: a.find((x) => x.slug === "mote")!.id,
    analysis: a.find((x) => x.slug === "analys")!.id,
  };
  const c = (await db.query<{ name: string; id: string }>(`select name, id from public.collections`)).rows;
  const collections = {
    warranty: c.find((x) => x.name === "Garanti")!.id,
    campaigns: c.find((x) => x.name === "Kampanjer")!.id,
  };
  const systemGroup = (
    await db.query<{ id: string }>(`select id from public.groups where is_system`)
  ).rows[0].id;

  await db.exec(`
    insert into public.groups (id, name) values
      ('${G.workshop}', 'Verkstad'), ('${G.sales}', 'Försäljning');
    insert into public.group_members (group_id, user_id, is_manager) values
      ('${G.workshop}', '${U.workshopManager}', true),
      ('${G.workshop}', '${U.mechanic}', false),
      ('${G.workshop}', '${U.disabled}', false),
      ('${G.sales}', '${U.seller}', false),
      ('${G.sales}', '${U.salesManager}', true);
    insert into public.assistant_grants (assistant_id, group_id) values
      ('${assistants.warranty}', '${G.workshop}'),
      ('${assistants.sales}', '${G.sales}'),
      ('${assistants.meetings}', '${systemGroup}');
    insert into public.assistant_grants (assistant_id, user_id) values
      ('${assistants.analysis}', '${U.admin}');
    insert into public.assistant_managers (assistant_id, user_id) values
      ('${assistants.sales}', '${U.salesManager}');
  `);

  const doc = async (
    id: string,
    title: string,
    ownerGroup: string,
    uploader: string,
    collection: string,
    assistant: string,
    review: string,
    validUntil: string | null,
    chunks: string[],
  ) => {
    await db.query(
      `insert into public.documents
         (id, title, file_name, mime_type, file_type, size_bytes, storage_path, collection_id,
          owner_group_id, uploaded_by, internal_only_attested_at, review_status,
          processing_status, valid_from, valid_until)
       values ($1, $2, $3, 'application/pdf', 'pdf', 1000, $4, $5, $6, $7, now(), $8, 'ready',
               '2026-01-01', $9)`,
      [id, title, `${id}.pdf`, `${id}/${id}.pdf`, collection, ownerGroup, uploader, review, validUntil],
    );
    await db.query(`insert into public.document_assistants values ($1, $2)`, [id, assistant]);
    for (const [i, content] of chunks.entries()) {
      await db.query(
        `insert into public.document_chunks (document_id, chunk_index, content, location) values ($1, $2, $3, $4)`,
        [id, i, content, `s. ${i + 1}`],
      );
    }
  };

  await doc(D.warrantyApproved, "Garantivillkor nybil", G.workshop, U.workshopManager, collections.warranty,
    assistants.warranty, "approved", null,
    ["Medföljande laddkabel omfattas av nybilsgarantin i 24 månader.", "Batterigarantin gäller i åtta år."]);
  await doc(D.warrantyPending, "Utkast garantirutin", G.workshop, U.workshopManager, collections.warranty,
    assistants.warranty, "pending", null, ["Utkast: laddkabel hanteras enligt ny rutin."]);
  await doc(D.warrantyExpired, "Gammal bulletin", G.workshop, U.workshopManager, collections.warranty,
    assistants.warranty, "approved", "2026-02-01", ["Bulletin om laddkabel som inte längre gäller."]);
  await doc(D.campaignApproved, "Höstkampanj företagsleasing", G.sales, U.salesManager, collections.campaigns,
    assistants.sales, "approved", null, ["Kampanjen gäller företagsleasing med leverans senast oktober."]);
  await doc(D.salesSharedWithWorkshop, "Laddkabel som tillbehör", G.sales, U.salesManager, collections.warranty,
    assistants.warranty, "approved", null, ["Extra laddkabel kan köpas som tillbehör."]);
  await db.query(`insert into public.document_shares values ($1, $2)`, [D.salesSharedWithWorkshop, G.workshop]);

  await db.exec(`
    insert into public.conversations (id, user_id, assistant_id, title, last_message_at) values
      ('${C.mechanicConversation}', '${U.mechanic}', '${assistants.warranty}', 'Teknikerns privata fråga', now()),
      ('${C.sellerConversation}', '${U.seller}', '${assistants.sales}', 'Säljarens privata fråga', now()),
      ('${C.oldConversation}', '${U.seller}', '${assistants.sales}', 'Gammal konversation', now() - interval '20 months');
    insert into public.messages (conversation_id, role, content, created_at) values
      ('${C.mechanicConversation}', 'user', 'Hemlig fråga från teknikern', now()),
      ('${C.sellerConversation}', 'user', 'Hemlig fråga från säljaren', now()),
      ('${C.oldConversation}', 'user', 'Gammalt meddelande', now() - interval '20 months');
  `);

  return { assistants, collections, systemGroup };
}
