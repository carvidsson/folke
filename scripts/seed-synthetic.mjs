#!/usr/bin/env node
/**
 * Loads SYNTHETIC test data for development and pilot testing:
 * two test groups, access grants and a handful of approved text documents.
 * All names, figures and terms are invented.
 *
 *   npm run seed:synthetic            # add
 *   npm run seed:synthetic -- --remove  # remove everything this script added
 *
 * Everything is tagged "syntetisk" / prefixed "Test –" so it can be removed.
 * Requires an active system administrator (owner/reviewer of the documents).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Saknar NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SECRET_KEY i .env.local");
  process.exit(1);
}
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const TAG = "syntetisk";

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) {
    console.error(`${what}:`, error.message);
    process.exit(1);
  }
  return data;
}

// ---------------------------------------------------------------------------
if (process.argv.includes("--remove")) {
  const docs = await must(db.from("documents").select("id, storage_path").contains("tags", [TAG]), "Hämta dokument");
  const paths = docs.map((d) => d.storage_path).filter(Boolean);
  if (paths.length) await db.storage.from("documents").remove(paths);
  await must(db.from("documents").delete().contains("tags", [TAG]), "Ta bort dokument");
  await must(db.from("groups").delete().like("name", "Test – %"), "Ta bort grupper");
  console.log(`Borttaget: ${docs.length} dokument och testgrupperna.`);
  process.exit(0);
}

const admins = await must(
  db.from("profiles").select("id").eq("role", "system_admin").eq("status", "active").limit(1),
  "Hämta administratör",
);
if (!admins.length) {
  console.error("Ingen aktiv systemadministratör. Kör bootstrap:admin och logga in först.");
  process.exit(1);
}
const adminId = admins[0].id;

const assistants = Object.fromEntries(
  (await must(db.from("assistants").select("id, slug"), "Hämta assistenter")).map((a) => [a.slug, a.id]),
);
const collections = Object.fromEntries(
  (await must(db.from("collections").select("id, name"), "Hämta samlingar")).map((c) => [c.name, c.id]),
);
const systemGroup = (await must(db.from("groups").select("id").eq("is_system", true).single(), "Systemgrupp")).id;

async function group(name, description) {
  const existing = await must(db.from("groups").select("id").eq("name", name).maybeSingle(), "Grupp");
  if (existing) return existing.id;
  return (await must(db.from("groups").insert({ name, description }).select("id").single(), "Skapa grupp")).id;
}

const workshop = await group("Test – Verkstad", "Syntetisk testgrupp för garantiassistenten.");
const sales = await group("Test – Försäljning", "Syntetisk testgrupp för säljassistenten.");

await db.from("group_members").upsert(
  [
    { group_id: workshop, user_id: adminId, is_manager: true },
    { group_id: sales, user_id: adminId, is_manager: true },
  ],
  { onConflict: "group_id,user_id", ignoreDuplicates: true },
);
// Plain inserts: the uniqueness indexes are partial (PostgREST on_conflict
// cannot target them). Existing rows (23505) are fine.
async function insertIgnoringDuplicates(row) {
  const { error } = await db.from("assistant_grants").insert(row);
  if (error && error.code !== "23505") {
    console.error("Behörighet:", error.message);
    process.exit(1);
  }
}
for (const [slug, groupId] of [
  ["garanti", workshop],
  ["salj", sales],
  ["mote", systemGroup],
]) {
  await insertIgnoringDuplicates({ assistant_id: assistants[slug], group_id: groupId });
}
await insertIgnoringDuplicates({ assistant_id: assistants.analys, user_id: adminId });

const DOCS = [
  {
    title: "Test – Garantivillkor nybil 2026",
    collection: "Garanti", owner: workshop, assistant: "garanti",
    text: `Garantivillkor för nya personbilar (syntetiskt exempel)

Nybilsgarantin gäller i 24 månader från leveransdatum utan begränsning av körsträcka.

Medföljande laddutrustning, till exempel laddkabel för laddning i publika laddpunkter, räknas som originalutrustning och omfattas av nybilsgarantin i 24 månader. Garantin gäller inte om kabel eller kontakt har yttre mekanisk skada, till exempel klämskador eller brännmärken.

För garantiärenden krävs chassinummer, leveransdatum, mätarställning, felkod eller mätprotokoll samt foton på den defekta delen.`,
  },
  {
    title: "Test – Batterigaranti högvoltssystem",
    collection: "Garanti", owner: workshop, assistant: "garanti",
    text: `Batterigaranti (syntetiskt exempel)

Batterigarantin för högvoltssystemet gäller i 8 år eller 160 000 km, det som inträffar först.

Garantin omfattar battericeller, batterimoduler och batteriets styrenhet. Om kapaciteten understiger 70 procent av ursprunglig kapacitet inom garantitiden betraktas det som ett fel.

Extern laddutrustning omfattas inte av batterigarantin utan hanteras enligt nybilsgarantin.`,
  },
  {
    title: "Test – Rutin för garantiärenden",
    collection: "Garanti", owner: workshop, assistant: "garanti",
    text: `Rutin för garantiärenden (syntetiskt exempel)

Ett komplett garantiärende innehåller fem delar: fordonsuppgifter, symptom, diagnos, föreslagen åtgärd med hänvisning till villkorsavsnitt samt bilagor.

Ärendet skickas till tillverkaren inom 30 dagar från reparation. Ofullständiga ärenden returneras och måste kompletteras.`,
  },
  {
    title: "Test – Höstkampanj företagsleasing",
    collection: "Kampanjer", owner: sales, assistant: "salj",
    text: `Höstkampanj företagsleasing (syntetiskt exempel)

Kampanjen gäller nytecknade företagsleasingavtal för elbilar med leverans senast 31 oktober.

Kampanjen kan kombineras med serviceavtal men inte med andra rabatter. Kampanjpriset gäller endast avtal med 36 månaders löptid.`,
  },
  {
    title: "Test – Riktlinjer för inbytesvärdering",
    collection: "Riktlinjer", owner: sales, assistant: "salj",
    text: `Riktlinjer för inbytesvärdering (syntetiskt exempel)

Ett värderingsunderlag ska innehålla registreringsnummer, mätarställning, servicehistorik, antal nycklar, skador och anmärkningar med foton samt däckstatus.

Värderingen är ett underlag. Slutligt inbytespris sätts av begagnatansvarig.`,
  },
  {
    title: "Test – Mall för mötesprotokoll",
    collection: "Möten", owner: systemGroup, assistant: "mote",
    text: `Mall för mötesprotokoll (syntetiskt exempel)

Protokollet struktureras i fyra delar: sammanfattning, beslut, åtgärder med ansvarig och datum samt öppna frågor.

Protokollet skickas till deltagarna senast två arbetsdagar efter mötet.`,
  },
];

let added = 0;
for (const d of DOCS) {
  const exists = await must(db.from("documents").select("id").eq("title", d.title).maybeSingle(), "Dokument");
  if (exists) continue;

  const fileName = `${d.title.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}.txt`;
  const bytes = new TextEncoder().encode(d.text);
  const doc = await must(
    db
      .from("documents")
      .insert({
        title: d.title,
        file_name: fileName,
        mime_type: "text/plain",
        file_type: "txt",
        size_bytes: bytes.length,
        collection_id: collections[d.collection],
        owner_group_id: d.owner,
        uploaded_by: adminId,
        internal_only_attested_at: new Date().toISOString(),
        processing_status: "ready",
        tags: [TAG],
      })
      .select("id")
      .single(),
    "Skapa dokument",
  );
  const path = `${doc.id}/${fileName}`;
  await must(db.storage.from("documents").upload(path, bytes, { contentType: "text/plain" }), "Ladda upp fil");

  const paragraphs = d.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  await must(
    db.from("document_chunks").insert(
      paragraphs.map((content, i) => ({ document_id: doc.id, chunk_index: i, content, location: `Stycke ${i + 1}` })),
    ),
    "Indexera",
  );
  await must(db.from("document_assistants").insert({ document_id: doc.id, assistant_id: assistants[d.assistant] }), "Koppla assistent");
  await must(
    db
      .from("documents")
      .update({ storage_path: path, char_count: d.text.length, review_status: "approved", reviewed_by: adminId, reviewed_at: new Date().toISOString() })
      .eq("id", doc.id),
    "Godkänn",
  );
  added++;
}

console.log(`Klart. ${added} syntetiska dokument har lagts till. Ta bort allt med: npm run seed:synthetic -- --remove`);
