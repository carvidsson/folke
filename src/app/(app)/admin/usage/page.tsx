import type { Metadata } from "next";
import Link from "next/link";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Panel, StatTile } from "@/components/common/panel";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { externalProviderConfigured } from "@/server/ai/guard";
import { requireSystemAdminPage } from "@/server/auth/session";
import { listAssistants } from "@/server/data/assistants";
import { listUsageForDays, type UsageRow } from "@/server/data/operations";
import { listUsers } from "@/server/data/users";

export const metadata: Metadata = { title: "Användning och kostnad" };

const PERIODS = { "30": "30 dagar", "90": "90 dagar", "365": "12 månader" } as const;
type Period = keyof typeof PERIODS;

const number = new Intl.NumberFormat("sv-SE");
const sek = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

interface Totals {
  requests: number;
  embeddings: number;
  inputTokens: number;
  outputTokens: number;
  costSek: number;
  costUsd: number;
  estimated: number;
}

function sum(rows: UsageRow[]): Totals {
  return rows.reduce(
    (t, r) => ({
      requests: t.requests + (r.kind === "chat" ? 1 : 0),
      embeddings: t.embeddings + (r.kind === "embedding" ? 1 : 0),
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      costSek: t.costSek + r.costSek,
      costUsd: t.costUsd + r.costUsd,
      estimated: t.estimated + (r.estimated && r.provider !== "mock" ? 1 : 0),
    }),
    { requests: 0, embeddings: 0, inputTokens: 0, outputTokens: 0, costSek: 0, costUsd: 0, estimated: 0 },
  );
}

function groupBy(rows: UsageRow[], key: (r: UsageRow) => string) {
  const map = new Map<string, UsageRow[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return [...map].map(([k, v]) => ({ key: k, ...sum(v) })).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

export default async function UsagePage({ searchParams }: PageProps<"/admin/usage">) {
  await requireSystemAdminPage();
  const { period: raw } = await searchParams;
  const period: Period = typeof raw === "string" && raw in PERIODS ? (raw as Period) : "30";
  const [rows, assistants, users] = await Promise.all([
    listUsageForDays(Number(period)),
    listAssistants(),
    listUsers(),
  ]);
  const totals = sum(rows);
  const chat = sum(rows.filter((r) => r.kind === "chat"));
  const embeddings = sum(rows.filter((r) => r.kind === "embedding"));
  const assistantById = new Map(assistants.map((a) => [a.id, a]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const openAI = externalProviderConfigured();

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Användning och kostnad"
        description="AI-anrop, tokens och uppskattad kostnad. Innehållet i konversationerna visas aldrig här."
        actions={
          <nav className="inline-flex rounded-lg bg-muted p-[3px]" aria-label="Period">
            {(Object.keys(PERIODS) as Period[]).map((p) => (
              <Link
                key={p}
                href={`/admin/usage?period=${p}`}
                aria-current={p === period ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  p === period && "bg-background text-foreground shadow-xs",
                )}
              >
                {PERIODS[p]}
              </Link>
            ))}
          </nav>
        }
      />

      <p className="mt-6 rounded-xl border bg-brand-subtle px-4 py-3 text-sm">
        {openAI
          ? "OpenAI används bara för syntetiska testkonversationer. Övriga svar ges i mockläge utan kostnad. "
          : "Folke körs i mockläge. Ingen AI-leverantör anropas, så kostnaden är 0 kr. "}
        Kostnaden är en uppskattning utifrån tokens och prislistan i Folke. Fakturan från leverantören gäller.
        {totals.estimated > 0 &&
          ` ${number.format(totals.estimated)} anrop saknade slutlig tokenrapport (t.ex. avbrutna svar) och är uppskattade.`}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Uppskattad kostnad" value={sek.format(totals.costSek)} hint={usd.format(totals.costUsd)} />
        <StatTile label="Svar" value={number.format(totals.requests)} hint={usd.format(chat.costUsd)} />
        <StatTile label="Embeddings" value={number.format(totals.embeddings)} hint={usd.format(embeddings.costUsd)} />
        <StatTile
          label="Tokens in / ut"
          value={`${number.format(totals.inputTokens)} / ${number.format(totals.outputTokens)}`}
        />
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-2">
        <section>
          <h2 className="text-heading mb-3">Per assistent</h2>
          <Panel>
            <UsageTable
              rows={groupBy(rows, (r) => r.assistantId ?? "–")}
              label="Assistent"
              render={(key) => {
                const a = assistantById.get(key);
                return a ? (
                  <span className="flex items-center gap-2.5">
                    <AssistantAvatar assistant={a} size="sm" />
                    {a.name}
                  </span>
                ) : (
                  "Borttagen assistent"
                );
              }}
            />
          </Panel>
        </section>
        <section>
          <h2 className="text-heading mb-3">Per användare</h2>
          <Panel>
            <UsageTable
              rows={groupBy(rows, (r) => r.userId ?? "–")}
              label="Användare"
              render={(key) => {
                const u = userById.get(key);
                return u ? (
                  <span className="flex items-center gap-2.5">
                    <UserAvatar name={u.name} size="sm" />
                    {u.name}
                  </span>
                ) : (
                  "Borttagen användare"
                );
              }}
            />
          </Panel>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="text-heading mb-3">Per modell</h2>
        <Panel>
          <UsageTable
            rows={groupBy(rows, (r) => `${r.provider} · ${r.model}${r.kind === "embedding" ? " (embeddings)" : ""}`)}
            label="Leverantör och modell"
            render={(k) => k}
          />
        </Panel>
      </section>
    </PageContainer>
  );
}

function UsageTable({
  rows,
  label,
  render,
}: {
  rows: ({ key: string } & Totals)[];
  label: string;
  render: (key: string) => React.ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">Ingen användning under perioden.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Anrop</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Tokens</TableHead>
          <TableHead className="text-right">Kostnad</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">{render(r.key)}</TableCell>
            <TableCell className="text-right tabular-nums">{number.format(r.requests + r.embeddings)}</TableCell>
            <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
              {number.format(r.inputTokens + r.outputTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {sek.format(r.costSek)}
              <span className="block text-xs text-muted-foreground">{usd.format(r.costUsd)}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
