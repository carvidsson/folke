"use client";

import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AnswerLengthPicker,
  IntroSteps,
  MailPreview,
  WritingOptionsPicker,
  WritingTonePicker,
} from "@/components/ai-settings/pickers";
import { FolkeSymbol } from "@/components/brand/folke-logo";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_EXTRA_NOTES, MAX_WRITING_SAMPLE, type AIPreferences } from "@/lib/domain/preferences";
import { cn } from "@/lib/utils";
import {
  postponeOnboardingAction,
  saveMyAIPreferencesAction,
  setOnboardingStatusAction,
} from "@/server/account/ai-preferences-actions";

type Step = "welcome" | "answers" | "writing" | "wishes" | "intro";
const STEPS: Step[] = ["welcome", "answers", "writing", "wishes", "intro"];
const TITLES: Record<Exclude<Step, "welcome">, { title: string; text: string }> = {
  answers: {
    title: "Hur vill du få dina svar?",
    text: "Välj det exempel som känns mest naturligt. Du kan ändra det när som helst.",
  },
  writing: {
    title: "Hur vill du att Folke skriver åt dig?",
    text: "Välj det mejl som ligger närmast din egen stil. Det gäller texter Folke skriver åt dig, inte faktasvar.",
  },
  wishes: {
    title: "Vill du lägga till något?",
    text: "Allt här är frivilligt. Exemplet uppdateras direkt när du ändrar ett val.",
  },
  intro: {
    title: "Så hittar du i Folke",
    text: "En snabb översikt. Hoppa gärna över den om du redan känner dig hemma.",
  },
};

/** First step without a choice yet, so "Fortsätt senare" resumes where the user left off. */
function resumeStep(prefs: AIPreferences | null, restart: boolean): Step {
  if (restart || !prefs || !prefs.answerLength) return "welcome";
  if (!prefs.writingTone) return "writing";
  return "wishes";
}

export function OnboardingFlow({
  firstName,
  initial,
  restart,
  startAt,
}: {
  firstName: string;
  initial: AIPreferences | null;
  restart: boolean;
  startAt?: Step;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(startAt ?? resumeStep(initial, restart));
  const [prefs, setPrefs] = useState({
    answerLength: initial?.answerLength ?? null,
    writingTone: initial?.writingTone ?? null,
    writingOptions: initial?.writingOptions ?? [],
    extraNotes: initial?.extraNotes ?? "",
    writingSample: initial?.writingSample ?? "",
  });
  const [showSample, setShowSample] = useState(Boolean(initial?.writingSample));
  const [pending, start] = useTransition();
  const index = STEPS.indexOf(step);

  function go(next: Step) {
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  /** Saves the current step's choices, then moves on. */
  function saveAndContinue(fields: Parameters<typeof saveMyAIPreferencesAction>[0], next: Step) {
    start(async () => {
      const result = await saveMyAIPreferencesAction(fields).catch(() => ({ ok: false as const, error: "Det gick inte att spara." }));
      if (!result.ok) return void toast.error(result.error);
      go(next);
    });
  }

  function finish(status: "completed" | "skipped") {
    start(async () => {
      const result = await setOnboardingStatusAction(status).catch(() => ({ ok: false as const, error: "Det gick inte att spara." }));
      if (!result.ok) return void toast.error(result.error);
      if (status === "completed") toast.success("Klart! Folke använder nu dina inställningar.");
      router.push("/");
      router.refresh();
    });
  }

  function later() {
    start(async () => {
      await postponeOnboardingAction().catch(() => null);
      router.push("/");
      router.refresh();
    });
  }

  if (step === "welcome") {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center text-center">
        <FolkeSymbol className="size-12" />
        <h1 className="text-display mt-6">Välkommen till Folke, {firstName}</h1>
        <p className="mt-3 text-muted-foreground">
          Gör Folke till din på ungefär en minut. Du väljer bland färdiga exempel hur du vill få svar och hur Folke ska
          skriva åt dig. Allt går att ändra senare.
        </p>
        <div className="mt-8 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button size="lg" onClick={() => go("answers")} disabled={pending}>
            <Sparkles />
            Kom igång
          </Button>
          <Button size="lg" variant="outline" onClick={later} disabled={pending}>
            Senare
          </Button>
        </div>
        <button
          type="button"
          onClick={() => finish("skipped")}
          disabled={pending}
          className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Hoppa över, jag använder standardinställningarna
        </button>
      </div>
    );
  }

  const { title, text } = TITLES[step];
  const next = STEPS[index + 1];

  return (
    <div className="mx-auto max-w-5xl pb-28">
      <div className="mb-6 flex items-center gap-3">
        <ol className="flex flex-1 gap-1.5" aria-label={`Steg ${index} av ${STEPS.length - 1}`}>
          {STEPS.slice(1).map((s, i) => (
            <li key={s} className={cn("h-1.5 flex-1 rounded-full bg-muted", i < index && "bg-brand")} />
          ))}
        </ol>
        <span className="text-caption shrink-0">
          {index} av {STEPS.length - 1}
        </span>
      </div>
      <h1 className="text-display">{title}</h1>
      <p className="mt-2 text-muted-foreground">{text}</p>

      <div className="mt-6">
        {step === "answers" && (
          <AnswerLengthPicker value={prefs.answerLength} onChange={(answerLength) => setPrefs((p) => ({ ...p, answerLength }))} />
        )}
        {step === "writing" && (
          <WritingTonePicker
            value={prefs.writingTone}
            options={prefs.writingOptions}
            onChange={(writingTone) => setPrefs((p) => ({ ...p, writingTone }))}
          />
        )}
        {step === "wishes" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-5">
              <WritingOptionsPicker value={prefs.writingOptions} onChange={(writingOptions) => setPrefs((p) => ({ ...p, writingOptions }))} />
              <div>
                <label htmlFor="extra-notes" className="text-sm font-medium">
                  Finns det något mer du vill att Folke ska tänka på?
                </label>
                <Textarea
                  id="extra-notes"
                  value={prefs.extraNotes}
                  onChange={(e) => setPrefs((p) => ({ ...p, extraNotes: e.target.value }))}
                  maxLength={MAX_EXTRA_NOTES}
                  rows={3}
                  placeholder="Till exempel: skriv gärna punktlistor när det finns flera steg."
                  className="mt-1.5"
                />
              </div>
              {showSample ? (
                <div>
                  <label htmlFor="writing-sample" className="text-sm font-medium">
                    Eget skrivexempel
                  </label>
                  <p className="text-caption">Folke efterliknar stilen, aldrig innehållet. Klistra inte in känsliga uppgifter.</p>
                  <Textarea
                    id="writing-sample"
                    value={prefs.writingSample}
                    onChange={(e) => setPrefs((p) => ({ ...p, writingSample: e.target.value }))}
                    maxLength={MAX_WRITING_SAMPLE}
                    rows={5}
                    className="mt-1.5"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSample(true)}
                  className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Lägg till ett eget skrivexempel (frivilligt)
                </button>
              )}
            </div>
            <div className="lg:sticky lg:top-6 lg:self-start">
              <MailPreview tone={prefs.writingTone} options={prefs.writingOptions} />
            </div>
          </div>
        )}
        {step === "intro" && <IntroSteps />}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:px-6">
          <Button variant="ghost" onClick={() => go(STEPS[index - 1])} disabled={pending}>
            <ArrowLeft />
            Tillbaka
          </Button>
          <div className="ml-auto flex gap-2">
            {step === "intro" ? (
              <Button onClick={() => finish("completed")} disabled={pending}>
                Klart
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => go(next)} disabled={pending} className="hidden sm:inline-flex">
                  Hoppa över steget
                </Button>
                <Button
                  disabled={pending}
                  onClick={() =>
                    saveAndContinue(
                      step === "answers"
                        ? { answerLength: prefs.answerLength ?? "balanced" }
                        : step === "writing"
                          ? { writingTone: prefs.writingTone ?? "professional" }
                          : {
                              writingOptions: prefs.writingOptions,
                              extraNotes: prefs.extraNotes,
                              writingSample: showSample ? prefs.writingSample : null,
                            },
                      next,
                    )
                  }
                >
                  Fortsätt
                  <ArrowRight />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
