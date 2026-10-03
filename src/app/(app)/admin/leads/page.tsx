import { Unplug } from "lucide-react";
import type { Metadata } from "next";

import { LeadAnalysisView } from "@/components/admin/lead-analysis-view";
import { EmptyState } from "@/components/common/empty-state";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import type { InboxOption } from "@/lib/leads/types";
import { leadAnalysisExternalAllowed } from "@/server/ai/guard";
import { defaultChatModel } from "@/server/ai/models";
import { requireSystemAdminPage } from "@/server/auth/session";
import { stockholmTime } from "@/server/leads/business-hours";
import { hubSpotConfigured } from "@/server/leads/hubspot";
import { inboxOptions, MAX_AI_DIALOGUES, MAX_PERIOD_DAYS } from "@/server/leads/service";

export const metadata: Metadata = { title: "Leadanalys" };
// The AI analysis runs in a server action on this page: allow the platform maximum.
export const maxDuration = 300;

function isoDate(date: Date) {
  const t = stockholmTime(date);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

export default async function LeadAnalysisPage() {
  await requireSystemAdminPage();

  const header = (
    <PageHeader
      eyebrow="Experiment"
      title="Leadanalys"
      description="Hur leads i en HubSpot-inkorg tas emot och besvaras. Statistiken räknas fram direkt ur HubSpot. AI-analysen är en separat, kvalitativ läsning av dialogerna."
    />
  );

  if (!hubSpotConfigured()) {
    return (
      <PageContainer>
        {header}
        <Panel className="mt-8">
          <EmptyState
            icon={Unplug}
            title="HubSpot är inte anslutet"
            description="Leadanalysen kräver en servicenyckel med behörigheten conversations.read i serverns miljö."
          />
        </Panel>
      </PageContainer>
    );
  }

  let inboxes: InboxOption[] = [];
  let loadError = false;
  try {
    inboxes = await inboxOptions();
  } catch {
    loadError = true;
  }

  const today = new Date();
  return (
    <PageContainer>
      {header}
      <LeadAnalysisView
        inboxes={inboxes}
        loadError={loadError}
        defaultFrom={isoDate(new Date(today.getTime() - 29 * 86_400_000))}
        defaultTo={isoDate(today)}
        maxPeriodDays={MAX_PERIOD_DAYS}
        ai={{ enabled: leadAnalysisExternalAllowed(), model: defaultChatModel().label, maxDialogues: MAX_AI_DIALOGUES }}
      />
    </PageContainer>
  );
}
