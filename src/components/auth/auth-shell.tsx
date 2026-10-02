import { ArrowUpRight } from "lucide-react";

import { FolkeLogo, FolkeSymbol } from "@/components/brand/folke-logo";
import { cn } from "@/lib/utils";

/**
 * The quote on the sign-in pages, verbatim from the transcript of the video
 * interview with Karim Lakhani by Adi Ignatius, Harvard Business Review,
 * 4 August 2023 (the article's headline is a paraphrase).
 */
const QUOTE = {
  before: "AI is not going to replace humans, but ",
  emphasis: "humans with AI",
  after: " are going to replace humans without AI.",
  name: "Karim Lakhani",
  role: "Professor vid Harvard Business School",
  source: "Harvard Business Review, augusti 2023",
  url: "https://hbr.org/2023/08/ai-wont-replace-humans-but-humans-with-ai-will-replace-humans-without-ai",
} as const;

/** The quote with its attribution: large in the side panel, compact on small screens. */
function Quote({ variant }: { variant: "panel" | "compact" }) {
  const panel = variant === "panel";
  return (
    <figure className={cn("relative", panel ? "max-w-lg" : "border-t pt-6")}>
      <span
        aria-hidden
        className={cn(
          "block font-heading leading-none font-semibold text-brand select-none",
          panel ? "-ml-1 mb-3 h-16 text-[5.5rem]" : "mb-1 h-8 text-[2.75rem]",
        )}
      >
        “
      </span>
      <blockquote cite={QUOTE.url} lang="en">
        <p
          className={cn(
            "text-balance",
            panel
              ? "text-[1.75rem] leading-[1.3] font-semibold tracking-[-0.02em]"
              : "text-[0.9375rem] leading-6 font-medium text-foreground/85",
          )}
        >
          {QUOTE.before}
          <span className="text-brand-foreground">{QUOTE.emphasis}</span>
          {QUOTE.after}
        </p>
      </blockquote>
      <figcaption className={cn("flex", panel ? "mt-10 items-start gap-4" : "mt-3 flex-col gap-0.5 text-xs")}>
        {panel && <span aria-hidden className="mt-2.5 h-px w-8 shrink-0 bg-brand" />}
        <span className={cn("flex flex-col", panel && "gap-1")}>
          <span className={cn("font-medium", panel ? "text-sm" : "text-[0.8125rem]")}>
            {QUOTE.name}
            {!panel && <span className="font-normal text-muted-foreground">, Harvard Business School</span>}
          </span>
          {panel && <span className="text-sm text-muted-foreground">{QUOTE.role}</span>}
          <a
            href={QUOTE.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex w-fit items-center gap-1 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline",
              panel ? "mt-1 text-[0.8125rem]" : "text-xs",
            )}
          >
            {QUOTE.source}
            <ArrowUpRight className="size-3.5" aria-hidden />
            <span className="sr-only">(öppnas i en ny flik)</span>
          </a>
        </span>
      </figcaption>
    </figure>
  );
}

/** Layout for all sign-in steps: form column + quote panel. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:px-16 lg:py-12">
        <FolkeLogo height={30} endorsement priority className="self-start" />

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12">
          <h1 className="text-display">{title}</h1>
          {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>

        {/* Small screens: the side panel is hidden, so the quote follows the form. */}
        <div className="mx-auto mb-8 w-full max-w-[380px] lg:hidden">
          <Quote variant="compact" />
        </div>

        <p className="text-caption">Intern plattform för Börjessons medarbetare.</p>
      </div>

      <aside className="relative hidden overflow-hidden border-l bg-surface lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <FolkeSymbol
          size={520}
          className="pointer-events-none absolute -right-28 -bottom-24 opacity-[0.06]"
        />
        <div className="relative">
          <Quote variant="panel" />
        </div>
      </aside>
    </div>
  );
}
