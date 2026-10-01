import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { stripMathDelimiters } from "@/lib/chat/text";
import { cn } from "@/lib/utils";

/**
 * Renders assistant answers. Raw HTML is not rendered (react-markdown's
 * default), so model output cannot inject markup.
 *
 * Citation markers like "[2]" are turned into links to "#cite-<idPrefix>-2"
 * (the matching entry in <Sources>) and rendered as small citation badges.
 */

const CITATION = /\[(\d{1,2})\](?!\()/g;

function linkCitations(markdown: string, idPrefix: string) {
  return markdown.replace(CITATION, `[$1](#cite-${idPrefix}-$1)`);
}

const components: Components = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-3 flex flex-col gap-1 pl-5",
        className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc marker:text-subtle-foreground",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      disabled
      className="mr-2 size-3.5 translate-y-0.5 accent-navy-900"
    />
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-sage-300 bg-surface py-2 pr-3 pl-4 text-foreground/90 [&>p]:my-1">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-5 border-border" />,
  code: ({ children, className }) =>
    className ? (
      <code className={cn("font-mono text-[0.8125rem]", className)}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="scrollbar-thin my-3 overflow-x-auto rounded-lg border bg-surface p-3.5 text-[0.8125rem] leading-5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="scrollbar-thin my-4 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[0.8125rem]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b px-3 py-2 tabular-nums [tr:last-child>&]:border-b-0">
      {children}
    </td>
  ),
  a: ({ href, children }) => {
    if (href?.startsWith("#cite-")) {
      return (
        <a
          href={href}
          className="ml-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded-[5px] bg-sage-100 px-1 align-middle text-[0.6875rem] font-semibold text-sage-700 no-underline transition-colors hover:bg-sage-200"
          aria-label={`Källa ${String(children)}`}
        >
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium underline decoration-navy-300 underline-offset-2 hover:decoration-foreground"
      >
        {children}
      </a>
    );
  },
};

export function Markdown({
  children,
  idPrefix,
  className,
}: {
  children: string;
  /** Unique per message, used for citation anchors. */
  idPrefix: string;
  className?: string;
}) {
  return (
    <div className={cn("text-[0.9375rem] leading-7 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {linkCitations(stripMathDelimiters(children), idPrefix)}
      </ReactMarkdown>
    </div>
  );
}
