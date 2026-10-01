import type { Metadata } from "next";

import { SettingsView } from "@/components/settings/settings-view";
import { MAX_SESSION_MS } from "@/lib/auth/session-age";
import { ROLE_LABELS } from "@/lib/domain/labels";
import { getSession } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "Inställningar" };

export default async function SettingsPage() {
  const { user, sessionStartedAt } = await getSession();
  const supabase = await createSupabaseServerClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("mfa_enrolled_at")
    .eq("id", user.id)
    .maybeSingle<{ mfa_enrolled_at: string | null }>();

  return (
    <SettingsView
      user={{
        name: user.name,
        email: user.email,
        title: user.title,
        department: user.department,
        location: user.location,
        roleLabel: ROLE_LABELS[user.role],
      }}
      security={{
        mfaEnrolledAt: profile?.mfa_enrolled_at ?? null,
        sessionStartedAt: sessionStartedAt.toISOString(),
        sessionExpiresAt: new Date(sessionStartedAt.getTime() + MAX_SESSION_MS).toISOString(),
      }}
    />
  );
}
