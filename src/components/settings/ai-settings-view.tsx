"use client";

import { FlaskConical, Play, RotateCcw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AnswerLengthPicker,
  MailPreview,
  WritingOptionsPicker,
  WritingTonePicker,
} from "@/components/ai-settings/pickers";
import { Markdown } from "@/components/chat/markdown";
import { Sources } from "@/components/chat/sources";
import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Panel } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ANSWER_LENGTH_LABELS,
  MAX_EXTRA_NOTES,
  MAX_WRITING_SAMPLE,
  WRITING_OPTION_LABELS,
  WRITING_TONE_LABELS,
  type AIPreferences,
  type AnswerLength,
  type WritingOption,
  type WritingTone,
} from "@/lib/domain/preferences";
import type { Assistant } from "@/lib/domain/types";
import {
  compareMyPreferencesAction,
  resetMyAIPreferencesAction,
  saveMyAIPreferencesAction,
  setOnboardingStatusAction,
  type PreferenceCompareResult,
} from "@/server/account/ai-preferences-actions";

interface FormState {
  answerLength: AnswerLength | null;
  writingTone: WritingTone | null;
  writingOptions: WritingOption[];
  extraNotes: string;
  writingSample: string;
}

const toForm = (p: AIPreferences | null): FormState => ({
  answerLength: p?.answerLength ?? null,
  writingTone: p?.writingTone ?? null,
  writingOptions: p?.writingOptions ?? [],
  extraNotes: p?.extraNotes ?? "",
  writingSample: p?.writingSample ?? "",
});

const same = (a: FormState, b: FormState) =>
  a.answerLength === b.answerLength &&
  a.writingTone === b.writingTone &&
  [...a.writingOptions].sort().join() === [...b.writingOptions].sort().join() &&
  a.extraNotes.trim() === b.extraNotes.trim() &&
  a.writingSample.trim() === b.writingSample.trim();

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-heading">{title}</h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

export function AISettingsView({
  initial,
  assistants,
  aiTestEnabled,
}: {
  initial: AIPreferences | null;
  assistants: Assistant[];
  aiTestEnabled: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<FormState>(toForm(initial));
  const [form, setForm] = useState<FormState>(toForm(initial));
  const [pending, start] = useTransition();
  const dirty = !same(form, saved);

  function save() {
    start(async () => {
      const result = await saveMyAIPreferencesAction({
        answerLength: form.answerLength,
        writingTone: form.writingTone,
        writingOptions: form.writingOptions,
        extraNotes: form.extraNotes,
        writingSample: form.writingSample,
      }).catch(() => ({ ok: false as const, error: "Inställningarna kunde inte sparas." }));
      if (result.ok) {
        setSaved(form);
        toast.success(result.message);
      } else {
        toast.error(result.error);
      }
    });
  }

  function reset() {
    if (!window.confirm("Återställa till Folkes standardinställningar? Dina val och egna önskemål tas bort.")) return;
    start(async () => {
      const result = await resetMyAIPreferencesAction().catch(() => ({ ok: false as const, error: "Det gick inte att återställa." }));
      if (result.ok) {
        const empty = toForm(null);
        setForm(empty);
        setSaved(empty);
        toast.success(result.message);
      } else {
        toast.error(result.error);
      }
    });
  }

  function restartOnboarding() {
    start(async () => {
      await setOnboardingStatusAction("not_started").catch(() => null);
      router.push("/onboarding?restart=1");
    });
  }

  const summary = [
    form.answerLength ? ANSWER_LENGTH_LABELS[form.answerLength] : `${ANSWER_LENGTH_LABELS.balanced} (standard)`,
    form.writingTone ? WRITING_TONE_LABELS[form.writingTone] : `${WRITING_TONE_LABELS.professional} (standard)`,
    ...form.writingOptions.map((o) => WRITING_OPTION_LABELS[o]),
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Mina AI-inställningar"
        description="Bestäm hur Folke svarar och skriver åt dig. Inställningarna gäller bara dig och påverkar aldrig assistenternas uppdrag, dina behörigheter eller Folkes regler."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={restartOnboarding} disabled={pending}>
              <Play />
              Starta introduktionen
            </Button>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              <RotateCcw />
              Återställ standard
            </Button>
          </div>
        }
      />

      <Panel className="mt-6 flex flex-wrap items-center gap-1.5 px-4 py-3">
        <span className="mr-1 text-sm text-muted-foreground">Nu gäller:</span>
        {summary.map((s) => (
          <StatusBadge key={s} tone="neutral">
            {s}
          </StatusBadge>
        ))}
      </Panel>

      <Section title="Så svarar Folke" description="Gäller svar på dina frågor. Assistentens obligatoriska format och källkrav gäller alltid.">
        <AnswerLengthPicker value={form.answerLength} onChange={(answerLength) => setForm((f) => ({ ...f, answerLength }))} />
      </Section>

      <Section title="Så skriver Folke åt dig" description="Gäller texter som Folke skriver för din räkning, till exempel mejl och meddelanden.">
        <WritingTonePicker
          value={form.writingTone}
          options={form.writingOptions}
          onChange={(writingTone) => setForm((f) => ({ ...f, writingTone }))}
        />
      </Section>

      <Section title="Egna önskemål" description="Frivilliga snabbval och önskemål. Exemplet till höger uppdateras direkt.">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-5">
            <WritingOptionsPicker value={form.writingOptions} onChange={(writingOptions) => setForm((f) => ({ ...f, writingOptions }))} />
            <div>
              <Label htmlFor="ai-notes">Finns det något mer du vill att Folke ska tänka på?</Label>
              <Textarea
                id="ai-notes"
                value={form.extraNotes}
                onChange={(e) => setForm((f) => ({ ...f, extraNotes: e.target.value }))}
                maxLength={MAX_EXTRA_NOTES}
                rows={3}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="ai-sample">Eget skrivexempel (frivilligt)</Label>
              <p className="text-caption">Folke efterliknar stilen, aldrig innehållet. Klistra inte in känsliga uppgifter.</p>
              <Textarea
                id="ai-sample"
                value={form.writingSample}
                onChange={(e) => setForm((f) => ({ ...f, writingSample: e.target.value }))}
                maxLength={MAX_WRITING_SAMPLE}
                rows={4}
                className="mt-1.5"
              />
            </div>
          </div>
          <div className="lg:sticky lg:top-6 lg:self-start">
            <MailPreview tone={form.writingTone} options={form.writingOptions} />
          </div>
        </div>
      </Section>

      {aiTestEnabled && assistants.length > 0 && (
        <Section
          title="Testa med riktig AI"
          description="Frivilligt. Jämför två svar från OpenAI på din egen fråga: med dina sparade inställningar och med valen ovan."
        >
          <AITest assistants={assistants} proposed={form} />
        </Section>
      )}

      <div className="sticky bottom-0 mt-10 -mx-4 flex items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <span className="text-sm text-muted-foreground">{dirty ? "Du har ändringar som inte är sparade." : "Alla ändringar är sparade."}</span>
        <Button className="ml-auto" onClick={save} disabled={pending || !dirty}>
          <Save />
          Spara
        </Button>
      </div>
      <p className="text-caption mt-4">
        Vill du se hur Folke fungerar? <Link href="/onboarding?step=intro" className="underline underline-offset-2">Visa introduktionen</Link>.
      </p>
    </PageContainer>
  );
}

function AITest({ assistants, proposed }: { assistants: Assistant[]; proposed: FormState }) {
  const [assistantId, setAssistantId] = useState(assistants[0].id);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<PreferenceCompareResult | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setResult(null);
    start(async () => {
      const r = await compareMyPreferencesAction({
        assistantId,
        question,
        proposed: {
          answerLength: proposed.answerLength,
          writingTone: proposed.writingTone,
          writingOptions: proposed.writingOptions,
          extraNotes: proposed.extraNotes,
          writingSample: proposed.writingSample,
        },
      }).catch(() => ({ ok: false as const, error: "Testet kunde inte genomföras." }));
      setResult(r);
      if (!r.ok) toast.error(r.error);
    });
  }

  const data = result?.ok ? result.result : null;
  return (
    <Panel className="p-4 sm:p-5">
      <p className="rounded-lg bg-warning-subtle px-3 py-2 text-sm">
        Ett riktigt AI-test gör två anrop till OpenAI och kan medföra en liten kostnad. Det räknas mot din AI-budget och
        sparas inte som en konversation.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div>
          <Label htmlFor="test-assistant">Assistent</Label>
          <Select value={assistantId} onValueChange={setAssistantId}>
            <SelectTrigger id="test-assistant" className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <AssistantAvatar assistant={a} size="xs" />
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="test-question">Din fråga eller mejluppgift</Label>
          <Textarea
            id="test-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Till exempel: Skriv ett kort mejl till en kund om vår höstkampanj."
            className="mt-1.5"
          />
        </div>
      </div>
      <div className="mt-3 flex">
        <Button className="ml-auto" onClick={run} disabled={pending || question.trim().length < 3}>
          <FlaskConical />
          {pending ? "Kör två AI-anrop…" : "Jämför svaren"}
        </Button>
      </div>

      {data && (
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Samma modell ({data.model}) och{" "}
            {data.basis.length ? `samma ${data.basis.length} dokumentutdrag` : "inga dokument"} för båda svaren. Svaren kan
            ändå variera mellan anrop.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { title: "Dina sparade inställningar", answer: data.a, id: "pref-a" },
              { title: "Valen ovan", answer: data.b, id: "pref-b" },
            ].map(({ title, answer, id }) => (
              <Panel key={id} className="flex flex-col p-4">
                <h3 className="text-overline mb-2">{title}</h3>
                {answer.error ? (
                  <p className="text-sm text-destructive">{answer.error}</p>
                ) : (
                  <>
                    <Markdown idPrefix={id} className="text-sm">
                      {answer.answer}
                    </Markdown>
                    <Sources sources={answer.sources} idPrefix={id} />
                  </>
                )}
                <p className="text-caption mt-auto pt-3">{answer.answer.split(/\s+/).filter(Boolean).length} ord</p>
              </Panel>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
