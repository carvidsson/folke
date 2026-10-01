"use client";

import { Eye, FlaskConical, History, Save, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Markdown } from "@/components/chat/markdown";
import { Sources } from "@/components/chat/sources";
import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Panel } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Assistant } from "@/lib/domain/types";
import { formatDate } from "@/lib/format";
import {
  compareInstructionsAction,
  discardInstructionDraftAction,
  previewPromptAction,
  publishInstructionDraftAction,
  saveInstructionDraftAction,
  type CompareResult,
} from "@/server/admin/instruction-actions";
import type { InstructionDraft, InstructionRevision } from "@/server/data/instructions";

const MAX = 8000;
const usd = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

type Examples = "none" | "short" | "balanced" | "detailed";
const EXAMPLE_LABELS: Record<Examples, string> = {
  none: "Inga önskemål",
  short: "Exempel: korta svar",
  balanced: "Exempel: balanserade svar",
  detailed: "Exempel: utförliga svar",
};

export interface InstructionTarget {
  scope: "organization" | "assistant";
  assistantId: string | null;
  published: string;
  draft: InstructionDraft | null;
  revisions: InstructionRevision[];
  canEdit: boolean;
  minLength: number;
}

export interface AssistantInstructionsRow {
  assistant: Assistant;
  target: InstructionTarget;
}

export function InstructionsView({
  organization,
  organizationMeta,
  assistants,
  fixedRules,
  aiEnabled,
}: {
  organization: InstructionTarget | null;
  organizationMeta: string | null;
  assistants: AssistantInstructionsRow[];
  fixedRules: string[];
  /** OpenAI is enabled for approved documents (needed for the AI comparison). */
  aiEnabled: boolean;
}) {
  const [preview, setPreview] = useState<Assistant | null>(null);
  const [compare, setCompare] = useState<Assistant | null>(null);

  return (
    <PageContainer>
      <PageHeader
        title="AI-instruktioner"
        description="Gemensamma instruktioner för alla assistenter och instruktioner för varje assistent. Ändringar sparas som utkast och gäller först när de publiceras. Instruktionerna visas aldrig för användarna."
      />

      <Panel className="mt-6 p-5">
        <h2 className="text-heading">Så sätts instruktionerna ihop</h2>
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Gemensamma instruktioner</span> gäller alla assistenter.
          </li>
          <li>
            <span className="text-foreground">Assistentens instruktioner</span> beskriver uppdrag, arbetssätt och
            eventuella obligatoriska format.
          </li>
          <li>
            <span className="text-foreground">Användarens egna önskemål</span> om svarslängd, detaljnivå och ton går före
            allmänna stilanvisningar, men aldrig före uppdrag, obligatoriska format, regler, fakta, källkrav eller
            behörigheter.
          </li>
          <li>
            <span className="text-foreground">Fasta regler</span> om källor, säkerhet och sekretess läggs alltid till
            av Folke och kan inte ändras här.
          </li>
        </ol>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Visa de fasta reglerna</summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            {fixedRules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      </Panel>

      <section className="mt-8">
        <h2 className="text-heading mb-1">Gemensamma instruktioner</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {organization?.canEdit
            ? "Gäller alla assistenter. Skriv det som ska gälla oavsett uppgift, till exempel ton och hur känsliga uppgifter hanteras."
            : "Gäller alla assistenter. Endast systemadministratörer kan ändra dem."}
        </p>
        {organization ? (
          <InstructionEditor target={organization} label="Gemensamma instruktioner" meta={organizationMeta} />
        ) : (
          <p className="text-sm text-muted-foreground">Du har inte behörighet att se de gemensamma instruktionerna.</p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-heading mb-1">Assistenternas instruktioner</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Assistenter du administrerar. Förhandsgranska för att se hela instruktionen som modellen får, och testa ett
          utkast mot den publicerade versionen med riktig AI.
        </p>
        <div className="flex flex-col gap-6">
          {assistants.map((row) => (
            <Panel key={row.assistant.id} className="p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2.5">
                <AssistantAvatar assistant={row.assistant} size="sm" />
                <h3 className="font-medium">{row.assistant.name}</h3>
                <div className="ml-auto flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setPreview(row.assistant)}>
                    <Eye />
                    Förhandsgranska
                  </Button>
                  {aiEnabled && (
                    <Button variant="ghost" size="sm" onClick={() => setCompare(row.assistant)}>
                      <FlaskConical />
                      Testa med OpenAI
                    </Button>
                  )}
                </div>
              </div>
              <InstructionEditor target={row.target} label={`Instruktioner för ${row.assistant.name}`} />
            </Panel>
          ))}
          {assistants.length === 0 && <p className="text-sm text-muted-foreground">Du administrerar inga assistenter.</p>}
        </div>
      </section>

      <PromptPreviewDialog assistant={preview} onOpenChange={(open) => !open && setPreview(null)} />
      <CompareDialog assistant={compare} onOpenChange={(open) => !open && setCompare(null)} />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Editor: draft → publish, with conflict detection and safe restore
// ---------------------------------------------------------------------------

function InstructionEditor({ target, label, meta }: { target: InstructionTarget; label: string; meta?: string | null }) {
  const router = useRouter();
  const [draft, setDraft] = useState<InstructionDraft | null>(target.draft);
  const [text, setText] = useState(target.draft?.content ?? target.published);
  const [showHistory, setShowHistory] = useState(false);
  const [pending, start] = useTransition();

  const savedText = draft?.content ?? target.published;
  const dirty = text !== savedText;
  const tooShort = text.trim().length < target.minLength;
  const ids = { scope: target.scope, assistantId: target.assistantId };

  function saveDraft() {
    start(async () => {
      const result = await saveInstructionDraftAction({ ...ids, content: text, expectedUpdatedAt: draft?.updatedAt ?? null }).catch(
        () => ({ ok: false as const, error: "Utkastet kunde inte sparas." }),
      );
      if (result.ok) {
        setDraft({ content: text, updatedAt: result.updatedAt, updatedByName: "dig" });
        toast.success(result.message);
      } else {
        toast.error(result.error);
      }
    });
  }

  function publish() {
    if (!draft) return;
    if (!window.confirm("Publicera utkastet? Instruktionerna gäller direkt för nya svar.")) return;
    start(async () => {
      const result = await publishInstructionDraftAction({ ...ids, expectedUpdatedAt: draft.updatedAt }).catch(() => ({
        ok: false as const,
        error: "Instruktionerna kunde inte publiceras.",
      }));
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function discard() {
    if (!draft) return;
    if (!window.confirm("Kasta utkastet? Den publicerade versionen fortsätter att gälla.")) return;
    start(async () => {
      const result = await discardInstructionDraftAction({ ...ids, expectedUpdatedAt: draft.updatedAt }).catch(() => ({
        ok: false as const,
        error: "Utkastet kunde inte kastas.",
      }));
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function loadRevision(revision: InstructionRevision) {
    // Restoring only loads the text into the editor; it is saved as a draft
    // (with conflict detection) and published like any other change.
    if (
      (draft || dirty) &&
      !window.confirm(
        draft
          ? "Det finns ett utkast. Vill du ersätta texten i redigeraren med den tidigare versionen? Utkastet ändras först när du klickar Spara utkast."
          : "Du har ändringar som inte är sparade. Vill du ersätta dem med den tidigare versionen?",
      )
    ) {
      return;
    }
    setText(revision.content);
    toast.info("Den tidigare versionen är inläst. Spara utkast och publicera för att återställa den.");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {draft ? (
          <StatusBadge tone="warning">
            Utkast, inte publicerat · sparat {formatDate(draft.updatedAt)}
            {draft.updatedByName ? ` av ${draft.updatedByName}` : ""}
          </StatusBadge>
        ) : (
          <StatusBadge tone="success">Publicerad version</StatusBadge>
        )}
        {dirty && <StatusBadge tone="info">Osparade ändringar</StatusBadge>}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={!target.canEdit}
        rows={7}
        maxLength={MAX}
        aria-label={label}
        className="font-mono text-[0.8125rem] leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption">
          {text.length} / {MAX} tecken{meta ? ` · ${meta}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {target.revisions.length > 1 && (
            <Button variant="ghost" size="sm" onClick={() => setShowHistory((v) => !v)}>
              <History />
              {showHistory ? "Dölj historik" : "Historik"}
            </Button>
          )}
          {target.canEdit && draft && (
            <Button variant="ghost" size="sm" className="text-destructive" disabled={pending} onClick={discard}>
              <Trash2 />
              Kasta utkast
            </Button>
          )}
          {target.canEdit && (
            <Button variant="outline" size="sm" disabled={pending || !dirty || tooShort} onClick={saveDraft}>
              <Save />
              Spara utkast
            </Button>
          )}
          {target.canEdit && (
            <Button
              size="sm"
              disabled={pending || !draft || dirty || tooShort}
              onClick={publish}
              title={dirty ? "Spara utkastet innan du publicerar" : undefined}
            >
              <Send />
              Publicera
            </Button>
          )}
        </div>
      </div>
      {showHistory && (
        <ul className="mt-1 flex flex-col divide-y rounded-lg border text-sm">
          {target.revisions.map((r, i) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-caption">
                  {i === 0 ? "Publicerad nu · " : ""}
                  {formatDate(r.createdAt)}
                  {r.createdByName ? ` · ${r.createdByName}` : " · Folke"}
                </p>
                <p className="mt-1 line-clamp-2 text-muted-foreground">{r.content || "(tom)"}</p>
              </div>
              {target.canEdit && i > 0 && (
                <Button variant="outline" size="sm" onClick={() => loadRevision(r)}>
                  Använd
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview (text only, no AI call)
// ---------------------------------------------------------------------------

function ExampleSelect({ value, onChange, disabled }: { value: Examples; onChange: (v: Examples) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Examples)} disabled={disabled}>
      <SelectTrigger className="w-56" aria-label="Exempel på användarens önskemål">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(EXAMPLE_LABELS) as Examples[]).map((k) => (
          <SelectItem key={k} value={k}>
            {EXAMPLE_LABELS[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PromptPreviewDialog({ assistant, onOpenChange }: { assistant: Assistant | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={assistant !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">{assistant && <PromptPreview key={assistant.id} assistant={assistant} />}</DialogContent>
    </Dialog>
  );
}

function PromptPreview({ assistant }: { assistant: Assistant }) {
  const [version, setVersion] = useState<"published" | "draft">("published");
  const [examples, setExamples] = useState<Examples>("none");
  const [result, setResult] = useState<{ prompt: string; hasDraft: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    previewPromptAction({ assistantId: assistant.id, version, examplePreferences: examples })
      .then((r) => {
        if (!active) return;
        if (r.ok) setResult({ prompt: r.prompt, hasDraft: r.hasDraft });
        else toast.error(r.error);
      })
      .catch(() => active && toast.error("Förhandsgranskningen kunde inte visas."));
    return () => {
      active = false;
    };
  }, [assistant.id, version, examples]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Instruktion till modellen: {assistant.name}</DialogTitle>
        <DialogDescription>
          Utan källor. Vid en fråga läggs de hämtade dokumentutdragen till sist. Önskemålen är fasta exempel, aldrig
          någon verklig användares inställningar.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-2">
        <Select value={version} onValueChange={(v) => setVersion(v as "published" | "draft")}>
          <SelectTrigger className="w-48" aria-label="Version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="published">Publicerad version</SelectItem>
            <SelectItem value="draft">Med utkast</SelectItem>
          </SelectContent>
        </Select>
        <ExampleSelect value={examples} onChange={setExamples} />
      </div>
      {version === "draft" && result && !result.hasDraft && (
        <p className="text-sm text-muted-foreground">Det finns inget sparat utkast, så den publicerade versionen visas.</p>
      )}
      <pre className="scrollbar-thin max-h-[60vh] overflow-y-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {result?.prompt ?? "Laddar…"}
      </pre>
    </>
  );
}

// ---------------------------------------------------------------------------
// Side-by-side test with real OpenAI
// ---------------------------------------------------------------------------

function CompareDialog({ assistant, onOpenChange }: { assistant: Assistant | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={assistant !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        {assistant && <Compare key={assistant.id} assistant={assistant} />}
      </DialogContent>
    </Dialog>
  );
}

function Compare({ assistant }: { assistant: Assistant }) {
  const [question, setQuestion] = useState("");
  const [examples, setExamples] = useState<Examples>("none");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setResult(null);
    start(async () => {
      const r = await compareInstructionsAction({ assistantId: assistant.id, question, examplePreferences: examples }).catch(
        () => ({ ok: false as const, error: "Jämförelsen kunde inte genomföras." }),
      );
      setResult(r);
      if (!r.ok) toast.error(r.error);
    });
  }

  const data = result?.ok ? result.result : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Testa instruktionerna: {assistant.name}</DialogTitle>
        <DialogDescription>
          Två riktiga OpenAI-svar på samma fråga: ett med publicerade instruktioner och ett med ditt utkast. Båda använder
          samma modell, dina behörigheter och exakt samma hämtade dokumentutdrag, så den enda avsiktliga skillnaden är
          instruktionerna. Svaren kan ändå variera mellan anrop. Inget sparas som konversation, men anropen räknas mot
          din AI-budget.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <Label htmlFor="compare-question">Testfråga</Label>
        <Textarea
          id="compare-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Skriv en fråga som en användare skulle kunna ställa"
        />
        <div className="flex flex-wrap items-center gap-2">
          <ExampleSelect value={examples} onChange={setExamples} disabled={pending} />
          <Button className="ml-auto" disabled={pending || question.trim().length < 3} onClick={run}>
            <FlaskConical />
            {pending ? "Kör två AI-anrop…" : "Jämför svaren"}
          </Button>
        </div>
      </div>

      {data && (
        <div className="mt-2 flex flex-col gap-4">
          <div className="rounded-lg border bg-surface px-4 py-3 text-sm">
            <p className="font-medium">
              Underlag:{" "}
              {data.basis.length
                ? `samma ${data.basis.length} dokumentutdrag användes för båda svaren`
                : "inga dokument användes"}
            </p>
            {data.basis.length ? (
              <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5 text-muted-foreground">
                {data.basis.map((s) => (
                  <li key={s.id}>
                    {s.title}
                    {s.location ? `, ${s.location}` : ""}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-muted-foreground">
                Inga godkända dokument matchade frågan via assistenten med dina behörigheter. Båda svaren bygger bara på
                instruktionerna.
              </p>
            )}
            <p className="text-caption mt-2">
              Modell: {data.model} · Sökning: {data.usedVectorSearch ? "fulltext och semantisk" : "endast fulltext"} ·{" "}
              {EXAMPLE_LABELS[examples]}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <AnswerColumn title="Publicerade instruktioner" answer={data.published} idPrefix="cmp-pub" />
            <AnswerColumn title="Utkast" answer={data.draft} idPrefix="cmp-draft" />
          </div>
        </div>
      )}
    </>
  );
}

function AnswerColumn({
  title,
  answer,
  idPrefix,
}: {
  title: string;
  answer: Extract<CompareResult, { ok: true }>["result"]["published"];
  idPrefix: string;
}) {
  return (
    <Panel className="flex flex-col p-4">
      <h3 className="text-overline mb-2">{title}</h3>
      {answer.error ? (
        <p className="text-sm text-destructive">{answer.error}</p>
      ) : (
        <>
          <Markdown idPrefix={idPrefix} className="text-sm">
            {answer.answer}
          </Markdown>
          <Sources sources={answer.sources} idPrefix={idPrefix} />
          {answer.sources.length === 0 && <p className="text-caption mt-3">Svaret hänvisar inte till någon källa.</p>}
        </>
      )}
      <p className="text-caption mt-auto pt-3">
        {answer.inputTokens} tokens in · {answer.outputTokens} ut · {usd.format(answer.costUsd)}
        {answer.removedCitations ? ` · ${answer.removedCitations} ogiltiga källnummer borttagna` : ""}
      </p>
    </Panel>
  );
}
