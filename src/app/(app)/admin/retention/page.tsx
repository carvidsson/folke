import type { Metadata } from "next";

import { RetentionPurgeForm } from "@/components/admin/retention-purge-form";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSystemAdminPage } from "@/server/auth/session";
import { getRetentionSummary } from "@/server/data/operations";

export const metadata: Metadata = { title: "Gallring" };

const ORDER = ["< 6 månader", "6–12 månader", "12–24 månader", "> 24 månader"];
const number = new Intl.NumberFormat("sv-SE");

export default async function RetentionPage() {
  await requireSystemAdminPage();
  const summary = await getRetentionSummary();
  const rows = ORDER.map((bucket) => summary.find((s) => s.inactiveSince === bucket) ?? {
    inactiveSince: bucket,
    conversations: 0,
    messages: 0,
  });

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Gallring av konversationer"
        description="Konversationer sparas och granskas årligen. Du ser endast antal – aldrig titlar, innehåll eller vems konversationerna är."
      />

      <Panel className="mt-8">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Senast aktiv för</TableHead>
              <TableHead className="text-right">Konversationer</TableHead>
              <TableHead className="text-right">Meddelanden</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.inactiveSince}>
                <TableCell className="font-medium">{r.inactiveSince}</TableCell>
                <TableCell className="text-right tabular-nums">{number.format(r.conversations)}</TableCell>
                <TableCell className="text-right tabular-nums">{number.format(r.messages)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <section className="mt-10">
        <h2 className="text-heading">Gallra</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tar bort konversationer som inte har använts sedan valt datum, inklusive alla meddelanden.
          Datumet måste ligga minst 12 månader bakåt i tiden. Åtgärden loggas och kan inte ångras.
        </p>
        <RetentionPurgeForm />
      </section>
    </PageContainer>
  );
}
