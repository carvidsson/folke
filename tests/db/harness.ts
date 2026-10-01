/**
 * Database test harness.
 *
 * Runs the real migrations in supabase/migrations against PGlite (PostgreSQL
 * compiled to WASM) with minimal stand-ins for the Supabase-managed `auth`
 * and `storage` schemas. Queries can then be executed as a given user with a
 * given JWT (role `authenticated`), exactly like PostgREST does, so RLS
 * policies are exercised for real.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite, type Transaction } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Minimal emulation of what Supabase provides before our migrations run. */
const SUPABASE_BOOTSTRAP = /* sql */ `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
  );

  -- Like current Supabase projects: schema usage, but NO automatic table or
  -- sequence privileges for the API roles. Migrations must grant explicitly.
  grant usage on schema public to anon, authenticated, service_role;
`;

export async function createTestDatabase(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return db;
}

export interface JwtOptions {
  /** Authenticator assurance level. Default aal2 (password + TOTP). */
  aal?: "aal1" | "aal2";
  /** How long ago the session started. Default 1 hour. */
  sessionAgeHours?: number;
}

function claims(userId: string, { aal = "aal2", sessionAgeHours = 1 }: JwtOptions) {
  const started = Math.floor(Date.now() / 1000) - sessionAgeHours * 3600;
  const amr =
    aal === "aal2"
      ? [
          { method: "password", timestamp: started },
          { method: "totp", timestamp: started + 30 },
        ]
      : [{ method: "password", timestamp: started }];
  return JSON.stringify({ sub: userId, role: "authenticated", aal, amr });
}

/** Run `fn` as an authenticated user (inside a transaction that is rolled back). */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
  jwt: JwtOptions = {},
): Promise<T> {
  let result: T;
  let failure: unknown;
  await db
    .transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [claims(userId, jwt)]);
      await tx.exec("set local role authenticated");
      try {
        result = await fn(tx);
      } catch (error) {
        failure = error;
      }
      await tx.rollback();
    })
    .catch(() => undefined);
  if (failure) throw failure;
  return result!;
}

/** Run `fn` as an anonymous visitor. */
export async function asAnon<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T;
  let failure: unknown;
  await db
    .transaction(async (tx) => {
      await tx.exec("set local role anon");
      try {
        result = await fn(tx);
      } catch (error) {
        failure = error;
      }
      await tx.rollback();
    })
    .catch(() => undefined);
  if (failure) throw failure;
  return result!;
}

/** Run `fn` with the service role (bypasses RLS, like the server's admin client). */
export async function asService<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T;
  await db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    result = await fn(tx);
  });
  return result!;
}
