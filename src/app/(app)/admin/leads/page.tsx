import { Unplug } from "lucide-react";
import type { Metadata } from "next";

import { EmptyState } from "@/components/common/empty-state";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { LeadAdmin } from "@/components/leads/lead-admin";
import type { InboxOption, LeadInboxConfig } from "@/lib/leads/types";
import { requireSystemAdminPage } from "@/server/auth/session";
import { getLeadSettings, listLeadGrants, listLeadInboxes, listLeadRegions } from "@/server/data/leads";
import { listGroups, listUsers } from "@/server/data/users";
import { hubSpotConfigured } from "@/server/leads/hubspot";
import { inboxOptions } from "@/server/leads/service";

export const metadata: Metadata = { title: "Leadanalys – inkorgar och åtkomst" };

export default async function LeadAdminPage() {
  await requireSystemAdminPage();

  const header = (
    <PageHeader
      eyebrow="Leadanalys"
      title="Inkorgar och åtkomst"
      description="Välj vilka HubSpot-inkorgar som ingår i leadanalysen, vilken region de hör till, och vem som får se vad."
    />
  );

  if (!hubSpotConfigured()) {
    return (
      <PageContainer>
        {header}
        <Panel className="mt-8">
          <EmptyState icon={Unplug} title="HubSpot är inte anslutet" description="Leadanalysen kräver en servicenyckel med behörigheten conversations.read i serverns miljö." />
        </Panel>
      </PageContainer>
    );
  }

  let hubspot: InboxOption[] = [];
  let loadError = false;
  try {
    hubspot = await inboxOptions();
  } catch {
    loadError = true;
  }
  const [configured, regions, grants, groups, users, settings] = await Promise.all([
    listLeadInboxes(),
    listLeadRegions(),
    listLeadGrants(),
    listGroups(),
    listUsers(),
    getLeadSettings(),
  ]);

  // Every HubSpot inbox, with Folke's configuration where there is one.
  const byId = new Map(configured.map((c) => [c.id, c]));
  const inboxes: LeadInboxConfig[] = hubspot.map((h) => byId.get(h.id) ?? { id: h.id, name: h.name, configured: false, active: false, regionId: null, facility: null, brand: null });

  return (
    <PageContainer>
      {header}
      <LeadAdmin
        inboxes={inboxes}
        loadError={loadError}
        regions={regions}
        grants={grants}
        groups={groups.map((g) => ({ id: g.id, name: g.name, members: g.memberIds.length }))}
        users={users.filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, email: u.email }))}
        threadTemplate={settings.template}
      />
    </PageContainer>
  );
}
