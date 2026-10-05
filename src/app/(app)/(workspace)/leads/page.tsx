import { Inbox, Unplug } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/common/empty-state";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { LeadAnalysis } from "@/components/leads/lead-analysis";
import { Button } from "@/components/ui/button";
import { resolvePeriod } from "@/lib/leads/periods";
import { leadAnalysisExternalAllowed } from "@/server/ai/guard";
import { listMyAssistants } from "@/server/data/assistants";
import { getThreadUrlTemplate } from "@/server/data/leads";
import { requireLeadAccessPage } from "@/server/leads/access";
import { stockholmTime } from "@/server/leads/business-hours";
import { aiState, inboxDetail } from "@/server/leads/detail";
import { hubSpotConfigured } from "@/server/leads/hubspot";
import { buildOverview, resolveScope } from "@/server/leads/overview";
import { MAX_SYNC_DAYS } from "@/server/leads/service";

export const metadata: Metadata = { title: "Leadanalys" };
// Updating from HubSpot and the AI analysis run in server actions on this page; a region analysis (ADR-053)
// runs its inboxes after the response, within this limit (Vercel Pro, Fluid compute).
export const maxDuration = 800;

function today() {
  const t = stockholmTime(new Date());
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access } = await requireLeadAccessPage();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  if (!hubSpotConfigured()) {
    return (
      <PageContainer>
        <PageHeader title="Leadanalys" />
        <Panel className="mt-8">
          <EmptyState icon={Unplug} title="HubSpot är inte anslutet" description="Leadanalysen kräver en servicenyckel med behörigheten conversations.read i serverns miljö." />
        </Panel>
      </PageContainer>
    );
  }

  const day = today();
  const period = resolvePeriod(one("period"), day, one("from"), one("to"));
  const regionParam = one("region");
  const inboxParam = one("inbox");
  const data = await resolveScope({
    regionId: regionParam && /^([0-9a-f-]{36}|none)$/.test(regionParam) ? regionParam : null,
    inboxId: inboxParam && /^\d{1,20}$/.test(inboxParam) ? inboxParam : null,
  });
  if (!data) notFound();

  if (data.inboxes.length === 0) {
    return (
      <PageContainer>
        <PageHeader title="Leadanalys" />
        <Panel className="mt-8">
          <EmptyState
            icon={Inbox}
            title="Inga inkorgar ingår ännu"
            description={access.isAdmin ? "Välj vilka HubSpot-inkorgar som ska ingå och vilken region de hör till." : "En administratör har inte valt några inkorgar för dina regioner ännu."}
            action={
              access.isAdmin ? (
                <Button asChild>
                  <Link href="/admin/leads">Välj inkorgar</Link>
                </Button>
              ) : undefined
            }
          />
        </Panel>
      </PageContainer>
    );
  }

  const [overview, detail, ai, template, assistants] = await Promise.all([
    buildOverview(data, period, day),
    data.scope.type === "inbox" ? inboxDetail(data, period) : Promise.resolve(null),
    // No AI analysis on Alla leads (ADR-053): it is made per region and inbox.
    data.scope.type === "all" ? Promise.resolve(null) : aiState(data, period),
    getThreadUrlTemplate(),
    listMyAssistants(),
  ]);
  // "Fråga Folke" only when the user may use the Leadanalys assistant (ADR-050).
  const leadAssistant = assistants.find((a) => a.kind === "lead_analysis" && a.status === "active");

  return (
    <PageContainer width="wide">
      <LeadAnalysis
        overview={overview}
        detail={detail ? { sellers: detail.sellers, leads: detail.leads } : null}
        ai={ai}
        aiEnabled={leadAnalysisExternalAllowed()}
        linkConfigured={!!template}
        maxSyncDays={MAX_SYNC_DAYS}
        today={day}
        askFolke={leadAssistant?.slug ?? null}
      />
    </PageContainer>
  );
}
