import type { Metadata } from "next";

import { SettingsView } from "@/components/settings/settings-view";
import { ROLE_LABELS } from "@/lib/domain/labels";
import { getSession } from "@/server/auth/session";
import { listAssistantsForUser } from "@/server/data/assistants";

export const metadata: Metadata = { title: "Inställningar" };

export default async function SettingsPage() {
  const { user } = await getSession();
  const assistants = await listAssistantsForUser(user.id);

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
      assistants={assistants}
    />
  );
}
