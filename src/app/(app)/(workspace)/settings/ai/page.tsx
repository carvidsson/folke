import type { Metadata } from "next";

import { AISettingsView } from "@/components/settings/ai-settings-view";
import { approvedDocumentsEnabled } from "@/server/ai/guard";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { getMyAIPreferences } from "@/server/data/instructions";

export const metadata: Metadata = { title: "Mina AI-inställningar" };

export default async function AISettingsPage() {
  const { user } = await getSession();
  const [prefs, assistants] = await Promise.all([getMyAIPreferences(user.id), listMyAssistants()]);
  return <AISettingsView initial={prefs} assistants={assistants} aiTestEnabled={approvedDocumentsEnabled()} />;
}
