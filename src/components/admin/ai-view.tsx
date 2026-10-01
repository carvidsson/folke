"use client";

import { CircleCheck, CircleX, Database, FlaskConical, Search, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { DetailList } from "@/components/common/detail-list";
import { Panel, StatTile } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Assistant } from "@/lib/domain/types";
import {
  checkModelsAction,
  indexSyntheticEmbeddingsAction,
  loadSyntheticCorpusAction,
  removeSyntheticCorpusAction,
  setAITestAccessAction,
  setAssistantModelAction,
} from "@/server/admin/ai-actions";

import { useAdminAction } from "./use-admin-action";

const usd = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const usd2 = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export interface AIModelOption {
  id: string;
  label: string;
  description: string;
  costLevel: string;
  priceLabel: string;
  typicalAnswerUsd: number;
  isDefault: boolean;
}

interface Props {
  openAI: boolean;
  status: {
    provider: string;
    keyConfigured: boolean;
    project: string;
    organization: string;
    endpoint: string;
    dataPolicy: string;
    embeddingModel: string;
    limits: { userDailyUsd: number; monthlyUsd: number; concurrent: number; perMinute: number; maxOutputTokens: number };
    spend: { monthUsd: number; todayUsd: number };
  };
  models: AIModelOption[];
  assistants: { assistant: Assistant; modelId: string; storedModel: string | null }[];
  synthetic: {
    documents: number;
    chunks: number;
    embeddedChunks: number;
    staleEmbeddings: number;
    testUsers: number;
  } | null;
  users: { id: string; name: string; email: string; testAccess: boolean }[];
}

export function AIAdminView({ openAI, status, models, assistants, synthetic, users }: Props) {
  return (
    <PageContainer width="wide">
      <PageHeader
        title="AI och modeller"
        description="Leverantör, modellval per assistent, kostnadsgränser och syntetiska tester."
      />

      <p className="mt-6 rounded-xl border bg-warning-subtle px-4 py-3 text-sm">
        {openAI
          ? "OpenAI är aktiverat enbart för syntetiska testdata. Interna dokument och vanliga konversationer skickas aldrig till OpenAI – de besvaras i mockläge. Spärren gäller tills leverantörsavtal och behandling av intern information är godkända."
          : "Folke körs i mockläge. Ingen AI-leverantör anropas. Modellvalen nedan sparas och används först när OpenAI aktiveras för syntetiska tester."}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Kostnad denna månad"
          value={usd2.format(status.spend.monthUsd)}
          hint={`Spärr vid ${usd2.format(status.limits.monthlyUsd)}`}
        />
        <StatTile label="Kostnad i dag (alla)" value={usd2.format(status.spend.todayUsd)} />
        <StatTile
          label="Gräns per användare och dag"
          value={usd2.format(status.limits.userDailyUsd)}
          hint={`${status.limits.perMinute} frågor per minut, ${status.limits.concurrent} samtidiga`}
        />
        <StatTile label="Max längd på svar" value={`${status.limits.maxOutputTokens} tokens`} />
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className="text-heading mb-1">Modell per assistent</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Välj bland godkända modeller. Börja med den billigaste och byt bara där kvalitetstesterna visar att det
            behövs. Bytet gäller direkt för nya svar.
          </p>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Assistent</TableHead>
                  <TableHead>Modell</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assistants.map((row) => (
                  <AssistantModelRow key={row.assistant.id} row={row} models={models} />
                ))}
              </TableBody>
            </Table>
          </Panel>

          <h3 className="text-heading mt-8 mb-3">Godkända modeller</h3>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Modell</TableHead>
                  <TableHead>Kostnadsnivå</TableHead>
                  <TableHead className="text-right">Ca per svar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <span className="font-medium">{m.label}</span>
                      {m.isDefault && (
                        <StatusBadge tone="brand" className="ml-2">
                          Standard
                        </StatusBadge>
                      )}
                      <span className="block text-xs text-muted-foreground">{m.description}</span>
                    </TableCell>
                    <TableCell>
                      {m.costLevel}
                      <span className="block text-xs text-muted-foreground">{m.priceLabel}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{usd.format(m.typicalAnswerUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <p className="text-caption mt-2">
            Ca per svar: 3 000 tokens in och 500 ut. Priser enligt OpenAI:s prislista, kontrollerade 2026-10-01.
          </p>
        </section>

        <section className="flex flex-col gap-8">
          <div>
            <h2 className="text-heading mb-3">Leverantör</h2>
            <Panel className="p-5">
              <DetailList
                items={[
                  { label: "Aktiv leverantör", value: status.provider === "openai" ? "OpenAI (endast syntetiska data)" : "Mockläge" },
                  { label: "API-nyckel", value: status.keyConfigured ? "Konfigurerad på servern" : "Saknas" },
                  { label: "Projekt", value: status.project },
                  { label: "Organisation", value: status.organization },
                  { label: "Endpoint", value: status.endpoint },
                  { label: "Datapolicy", value: status.dataPolicy === "synthetic-only" ? "Endast syntetiska testdata" : status.dataPolicy },
                  { label: "Embeddings", value: status.embeddingModel },
                ]}
              />
              <ModelCheck enabled={openAI} />
            </Panel>
          </div>

          {openAI && synthetic && <SyntheticPanel synthetic={synthetic} />}
          {openAI && <TestAccessPanel users={users} />}
        </section>
      </div>
    </PageContainer>
  );
}

function AssistantModelRow({
  row,
  models,
}: {
  row: Props["assistants"][number];
  models: AIModelOption[];
}) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(row.modelId);
  const fallback = row.storedModel && row.storedModel !== row.modelId;

  function change(next: string) {
    const previous = value;
    setValue(next);
    start(async () => {
      const result = await setAssistantModelAction(row.assistant.id, next).catch(() => ({
        ok: false as const,
        error: "Modellen kunde inte sparas.",
      }));
      if (result.ok) {
        toast.success(result.message);
      } else {
        setValue(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2.5 font-medium">
          <AssistantAvatar assistant={row.assistant} size="sm" />
          {row.assistant.name}
        </span>
      </TableCell>
      <TableCell>
        <Select
          value={value}
          disabled={pending}
          onValueChange={change}
        >
          <SelectTrigger className="w-full max-w-72" aria-label={`Modell för ${row.assistant.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label} · {m.costLevel.toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fallback && (
          <span className="mt-1 block text-xs text-warning">
            Sparat värde är inte längre godkänt. Standardmodellen används.
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

function ModelCheck({ enabled }: { enabled: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ id: string; available: boolean }[] | null>(null);

  if (!enabled) return null;
  return (
    <div className="mt-5 border-t pt-4">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await checkModelsAction().catch(() => ({ ok: false as const, error: "Kontrollen misslyckades." }));
            if (r.ok) setResult(r.checked);
            else toast.error(r.error);
          })
        }
      >
        <Search />
        {pending ? "Kontrollerar…" : "Kontrollera modeller"}
      </Button>
      <p className="text-caption mt-2">Hämtar projektets modellista. Inga tokens förbrukas.</p>
      {result && (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {result.map((m) => (
            <li key={m.id} className="flex items-center gap-2">
              {m.available ? <CircleCheck className="size-4 text-success" /> : <CircleX className="size-4 text-destructive" />}
              {m.id}
              <span className="text-muted-foreground">{m.available ? "tillgänglig" : "saknas i projektet"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SyntheticPanel({ synthetic }: { synthetic: NonNullable<Props["synthetic"]> }) {
  const { pending, run } = useAdminAction();
  return (
    <div>
      <h2 className="text-heading mb-1">Syntetiska testdata</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Fiktiva dokument för alla fyra assistenter, inklusive ett injektionsförsök, ett utgånget och ett ogranskat
        dokument. Endast dessa kan skickas till OpenAI.
      </p>
      <Panel className="p-5">
        <DetailList
          items={[
            { label: "Dokument", value: synthetic.documents },
            { label: "Textavsnitt", value: synthetic.chunks },
            {
              label: "Med embeddings",
              value: `${synthetic.embeddedChunks} av ${synthetic.chunks}${synthetic.staleEmbeddings ? ` (${synthetic.staleEmbeddings} från annan modell)` : ""}`,
            },
            { label: "Testanvändare", value: synthetic.testUsers },
          ]}
        />
        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(loadSyntheticCorpusAction)}>
            <FlaskConical />
            Läs in testdokument
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || synthetic.chunks === 0 || synthetic.embeddedChunks === synthetic.chunks}
            onClick={() => run(indexSyntheticEmbeddingsAction)}
          >
            <Database />
            Skapa embeddings
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={pending || synthetic.documents === 0}
            onClick={() => {
              if (window.confirm("Ta bort alla syntetiska testdokument, testgruppen och all AI-testbehörighet?")) {
                run(removeSyntheticCorpusAction);
              }
            }}
          >
            <Trash2 />
            Ta bort testdata
          </Button>
        </div>
        <p className="text-caption mt-2">Embeddings skapas med OpenAI och kostar några öre för hela testsamlingen.</p>
      </Panel>
    </div>
  );
}

function TestAccessPanel({ users }: { users: Props["users"] }) {
  const { pending, run } = useAdminAction();
  return (
    <div>
      <h2 className="text-heading mb-1">AI-testbehörighet</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Användare med behörighet kan starta syntetiska testkonversationer som besvaras av OpenAI. Ge den bara till
        personer som testar och vet att de inte får skriva in verklig information.
      </p>
      <Panel>
        <Table>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <span className="flex items-center gap-2.5">
                    <UserAvatar name={u.name} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{u.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                    </span>
                  </span>
                </TableCell>
                <TableCell className="w-16 text-right">
                  <Switch
                    checked={u.testAccess}
                    disabled={pending}
                    aria-label={`AI-testbehörighet för ${u.name}`}
                    onCheckedChange={(checked) => run(() => setAITestAccessAction(u.id, checked))}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
