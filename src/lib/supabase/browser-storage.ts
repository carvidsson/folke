"use client";

import { createClient } from "@supabase/supabase-js";

/**
 * Uploads a file to a one-time signed URL created by the server. The
 * browser never gets general storage access: the token is valid for one
 * object path only, and the bucket has no end-user policies.
 */
export async function uploadToSignedUrl(bucket: string, path: string, token: string, file: File) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase är inte konfigurerat");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.storage.from(bucket).uploadToSignedUrl(path, token, file, {
    contentType: file.type || undefined,
  });
  if (error) throw error;
}
