/**
 * Helpers for LIVE tests against the real Supabase project.
 *
 * Safety rules (see docs/SETUP.md, "Testdata"):
 *   - Only synthetic users: live-<label>-<run>@folke.example (never e-mailed;
 *     created with the admin API, so no invitation is sent).
 *   - Only synthetic groups ("Test – live …") and documents (tag "syntetisk").
 *   - Everything created is tracked and removed in cleanup().
 *   - Existing users, groups, documents and audit logs are never modified.
 */
import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const RUN = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;

/** AI tests change data classes and need the AI migration: development project only. */
export const isDevelopmentProject = process.env.FOLKE_ENVIRONMENT === "development";

export function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !publishable || !secret) throw new Error("Live tests need .env.local (run via npm run test:live)");
  return { url, publishable, secret };
}

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export const service = () => createClient(env().url, env().secret, opts);
export const anonClient = () => createClient(env().url, env().publishable, opts);

// --- TOTP (RFC 6238), same algorithm as authenticator apps -----------------

function base32Decode(s: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// --- Tracking for cleanup ---------------------------------------------------

const created = { users: [] as string[], groups: [] as string[], documents: [] as { id: string; path: string | null }[] };

export interface LiveUser {
  id: string;
  email: string;
  password: string;
  /** Client signed in as this user (aal2 unless mfa: false). */
  client: SupabaseClient;
  totpSecret: string | null;
}

/**
 * Creates a synthetic user (no e-mail is sent), signs in with password and,
 * by default, enrols + verifies TOTP so the session is aal2.
 */
export async function createUser(
  label: string,
  { role = "employee", mfa = true }: { role?: "employee" | "assistant_manager" | "system_admin"; mfa?: boolean } = {},
): Promise<LiveUser> {
  const admin = service();
  const email = `live-${label}-${RUN}@folke.example`;
  const password = `Live-${crypto.randomBytes(12).toString("base64url")}9a`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Live ${label}` },
  });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  created.users.push(data.user.id);

  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`signIn ${label}: ${signIn.error.message}`);

  let totpSecret: string | null = null;
  if (mfa) {
    const enroll = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `live-${label}` });
    if (enroll.error) throw new Error(`enroll ${label}: ${enroll.error.message}`);
    totpSecret = enroll.data.totp.secret;
    const verify = await client.auth.mfa.challengeAndVerify({ factorId: enroll.data.id, code: totp(totpSecret) });
    if (verify.error) throw new Error(`verify ${label}: ${verify.error.message}`);
    // Profile becomes active the way the app does it after TOTP.
    await admin
      .from("profiles")
      .update({ status: "active", role, mfa_enrolled_at: new Date().toISOString() })
      .eq("id", data.user.id);
  } else {
    await admin.from("profiles").update({ status: "active", role }).eq("id", data.user.id);
  }
  return { id: data.user.id, email, password, client, totpSecret };
}

export async function createGroup(name: string) {
  const { data, error } = await service()
    .from("groups")
    .insert({ name: `Test – live ${name} ${RUN}` })
    .select("id")
    .single();
  if (error) throw new Error(`group: ${error.message}`);
  created.groups.push(data.id);
  return data.id as string;
}

/** Inserts an approved, processed synthetic document with chunks and a stored file. */
export async function createDocument({
  title,
  ownerGroupId,
  uploadedBy,
  assistantIds,
  chunks,
  reviewStatus = "approved",
  validFrom = "2026-01-01",
  validUntil = null,
  dataClass = "internal",
  locationLabel = "Stycke",
}: {
  title: string;
  ownerGroupId: string;
  uploadedBy: string;
  assistantIds: string[];
  chunks: string[];
  reviewStatus?: "pending" | "approved" | "rejected" | "archived";
  validFrom?: string;
  validUntil?: string | null;
  /** Prefix for chunk locations, e.g. "Sida" gives "Sida 1", "Sida 2" … */
  locationLabel?: string;
  /** "synthetic" may only be set by the server (service role), as here. */
  dataClass?: "internal" | "synthetic";
}) {
  const admin = service();
  const text = chunks.join("\n\n");
  const { data: doc, error } = await admin
    .from("documents")
    .insert({
      title: `Test – live ${title}`,
      file_name: "live.txt",
      mime_type: "text/plain",
      file_type: "txt",
      size_bytes: Buffer.byteLength(text),
      collection_id: (await admin.from("collections").select("id").eq("name", "Riktlinjer").single()).data!.id,
      owner_group_id: ownerGroupId,
      uploaded_by: uploadedBy,
      internal_only_attested_at: new Date().toISOString(),
      processing_status: "ready",
      review_status: reviewStatus,
      valid_from: validFrom,
      valid_until: validUntil,
      tags: ["syntetisk"],
      ai_data_class: dataClass,
    })
    .select("id")
    .single();
  if (error) throw new Error(`document: ${error.message}`);
  const path = `${doc.id}/live.txt`;
  created.documents.push({ id: doc.id, path });
  const up = await admin.storage.from("documents").upload(path, Buffer.from(text), { contentType: "text/plain" });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  await admin.from("documents").update({ storage_path: path }).eq("id", doc.id);
  await admin.from("document_chunks").insert(chunks.map((content, i) => ({ document_id: doc.id, chunk_index: i, content, location: `${locationLabel} ${i + 1}` })));
  await admin.from("document_assistants").insert(assistantIds.map((assistant_id) => ({ document_id: doc.id, assistant_id })));
  return { id: doc.id as string, path };
}

export async function assistantId(slug: string) {
  return (await service().from("assistants").select("id").eq("slug", slug).single()).data!.id as string;
}

/** Removes everything this run created. Audit log rows are kept (append-only). */
export async function cleanup() {
  const admin = service();
  for (const d of created.documents) {
    if (d.path) await admin.storage.from("documents").remove([d.path]);
    await admin.from("documents").delete().eq("id", d.id);
  }
  // Documents uploaded through other paths by test users.
  if (created.users.length) {
    const { data: extra } = await admin.from("documents").select("id, storage_path").in("uploaded_by", created.users);
    for (const d of extra ?? []) {
      if (d.storage_path) await admin.storage.from("documents").remove([d.storage_path]);
      await admin.from("documents").delete().eq("id", d.id);
    }
  }
  for (const g of created.groups) await admin.from("groups").delete().eq("id", g);
  if (created.users.length) await admin.from("ai_requests").delete().in("user_id", created.users);
  // Usage rows would otherwise survive as "deleted user" in cost statistics.
  if (created.users.length) await admin.from("ai_usage").delete().in("user_id", created.users);
  for (const u of created.users) await admin.auth.admin.deleteUser(u);
}

/** Decodes a JWT payload (no verification – for inspecting claims only). */
export function jwtClaims(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}
