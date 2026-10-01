"use client";

import { Bot, Check, FileText, History, MessageSquarePlus, SlidersHorizontal } from "lucide-react";

import { Markdown } from "@/components/chat/markdown";
import {
  ANSWER_LENGTHS,
  ANSWER_LENGTH_LABELS,
  WRITING_OPTIONS,
  WRITING_OPTION_LABELS,
  WRITING_TONES,
  WRITING_TONE_LABELS,
  type AnswerLength,
  type WritingOption,
  type WritingTone,
} from "@/lib/domain/preferences";
import {
  ANSWER_EXAMPLES,
  ANSWER_EXAMPLE_QUESTION,
  INTRO_STEPS,
  WRITING_EXAMPLE_CONTEXT,
  WRITING_OPTION_EXAMPLES,
  composeExampleMail,
  type IntroIcon,
} from "@/lib/onboarding/catalog";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the onboarding and Mina AI-inställningar. Everything
 * here is static: choosing and previewing never calls an AI model.
 */

/** Folke's defaults when the user has made no choice. */
export const DEFAULT_ANSWER_LENGTH: AnswerLength = "balanced";
export const DEFAULT_WRITING_TONE: WritingTone = "professional";

function ChoiceCard({
  selected,
  onSelect,
  title,
  badge,
  children,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group relative flex h-full flex-col rounded-xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] outline-none hover:border-navy-300 focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5",
        selected && "border-brand bg-brand-subtle/40 ring-3 ring-brand/15 hover:border-brand",
        className,
      )}
    >
      <span className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            selected ? "border-brand bg-brand text-white" : "bg-background",
          )}
        >
          {selected && <Check className="size-3" strokeWidth={3} />}
        </span>
        <span className="font-medium">{title}</span>
        {badge && <span className="text-caption ml-auto">{badge}</span>}
      </span>
      {children}
    </button>
  );
}

export function AnswerLengthPicker({
  value,
  onChange,
}: {
  value: AnswerLength | null;
  onChange: (value: AnswerLength) => void;
}) {
  const current = value ?? DEFAULT_ANSWER_LENGTH;
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Exempelfråga: <span className="font-medium text-foreground">{ANSWER_EXAMPLE_QUESTION}</span>
      </p>
      <div role="radiogroup" aria-label="Svarslängd" className="grid gap-3 md:grid-cols-3">
        {ANSWER_LENGTHS.map((length) => (
          <ChoiceCard
            key={length}
            selected={current === length}
            onSelect={() => onChange(length)}
            title={ANSWER_LENGTH_LABELS[length]}
            badge={length === DEFAULT_ANSWER_LENGTH ? "Standard" : undefined}
          >
            <Markdown idPrefix={`answer-${length}`} className="text-sm leading-6 text-muted-foreground">
              {ANSWER_EXAMPLES[length]}
            </Markdown>
          </ChoiceCard>
        ))}
      </div>
    </div>
  );
}

export function MailCard({ tone, options }: { tone: WritingTone; options: readonly WritingOption[] }) {
  const mail = composeExampleMail(tone, options);
  return (
    <div className="text-sm">
      <p className="text-caption mb-1">Ämne: {mail.subject}</p>
      <p className="leading-6 whitespace-pre-line text-muted-foreground">{mail.body}</p>
    </div>
  );
}

export function WritingTonePicker({
  value,
  options,
  onChange,
}: {
  value: WritingTone | null;
  options: readonly WritingOption[];
  onChange: (value: WritingTone) => void;
}) {
  const current = value ?? DEFAULT_WRITING_TONE;
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Uppgift: <span className="font-medium text-foreground">{WRITING_EXAMPLE_CONTEXT}</span>
      </p>
      <div role="radiogroup" aria-label="Skrivstil" className="grid gap-3 md:grid-cols-3">
        {WRITING_TONES.map((tone) => (
          <ChoiceCard
            key={tone}
            selected={current === tone}
            onSelect={() => onChange(tone)}
            title={WRITING_TONE_LABELS[tone]}
            badge={tone === DEFAULT_WRITING_TONE ? "Standard" : undefined}
          >
            <MailCard tone={tone} options={options} />
          </ChoiceCard>
        ))}
      </div>
    </div>
  );
}

export function WritingOptionsPicker({
  value,
  onChange,
}: {
  value: readonly WritingOption[];
  onChange: (value: WritingOption[]) => void;
}) {
  return (
    <div role="group" aria-label="Snabbval" className="grid gap-2 sm:grid-cols-2">
      {WRITING_OPTIONS.map((option) => {
        const on = value.includes(option);
        const example = WRITING_OPTION_EXAMPLES[option];
        return (
          <button
            key={option}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onChange(on ? value.filter((o) => o !== option) : [...value, option])}
            className={cn(
              "flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs transition-colors outline-none hover:border-navy-300 focus-visible:ring-3 focus-visible:ring-ring/50",
              on && "border-brand bg-brand-subtle/40 hover:border-brand",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-md border transition-colors",
                on ? "border-brand bg-brand text-white" : "bg-background",
              )}
            >
              {on && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{WRITING_OPTION_LABELS[option]}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                <span className="line-through decoration-muted-foreground/50">{example.before}</span>
                <span aria-hidden> → </span>
                <span className="sr-only">blir</span>
                <span className="text-foreground">{example.after}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Live preview of a written text with the chosen tone and quick options. */
export function MailPreview({ tone, options }: { tone: WritingTone | null; options: readonly WritingOption[] }) {
  const t = tone ?? DEFAULT_WRITING_TONE;
  const mail = composeExampleMail(t, options);
  return (
    <div className="rounded-xl border bg-surface p-4 sm:p-5" aria-live="polite">
      <p className="text-overline mb-2">Så här kan Folke skriva åt dig</p>
      <p className="text-caption mb-1">Ämne: {mail.subject}</p>
      <p className="text-sm leading-6 whitespace-pre-line">{mail.body}</p>
      <p className="text-caption mt-3">
        {WRITING_TONE_LABELS[t]} · {mail.words} ord
      </p>
    </div>
  );
}

const INTRO_ICONS: Record<IntroIcon, React.ComponentType<{ className?: string }>> = {
  "new-chat": MessageSquarePlus,
  assistant: Bot,
  sources: FileText,
  history: History,
  settings: SlidersHorizontal,
};

export function IntroSteps() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2">
      {INTRO_STEPS.map((step, i) => {
        const Icon = INTRO_ICONS[step.icon];
        return (
          <li key={step.title} className={cn("flex gap-3 rounded-xl border bg-card p-4 shadow-xs", i === INTRO_STEPS.length - 1 && "sm:col-span-2")}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-foreground">
              <Icon className="size-4.5" />
            </span>
            <span>
              <span className="block text-sm font-medium">{step.title}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">{step.text}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
