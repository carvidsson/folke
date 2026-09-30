"use client";

import { ArrowUpRight, FileText } from "lucide-react";
import Link from "next/link";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SourceReference } from "@/lib/domain/types";

/** Numbered source list under an assistant answer. */
export function Sources({
  sources,
  idPrefix,
}: {
  sources: SourceReference[];
  idPrefix: string;
}) {
  if (!sources.length) return null;

  return (
    <div className="mt-4">
      <p className="text-overline mb-2">Källor</p>
      <ol className="flex flex-wrap gap-1.5">
        {sources.map((source, i) => (
          <li key={source.id} id={`cite-${idPrefix}-${i + 1}`} className="scroll-mt-24">
            <Popover>
              <PopoverTrigger className="group inline-flex h-7 max-w-72 items-center gap-1.5 rounded-md border bg-background pr-2.5 pl-1 text-xs text-muted-foreground shadow-xs outline-none transition-colors hover:border-navy-300 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:border-navy-300 data-[state=open]:text-foreground">
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-sage-100 px-1 text-[0.6875rem] font-semibold text-sage-700">
                  {i + 1}
                </span>
                <span className="truncate font-medium">{source.title}</span>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-0">
                <div className="flex items-start gap-3 border-b p-3.5">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <FileText className="size-4" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm leading-5 font-medium">{source.title}</p>
                    {source.location && (
                      <p className="text-caption">{source.location}</p>
                    )}
                  </div>
                </div>
                <blockquote className="p-3.5 text-[0.8125rem] leading-5 text-foreground/85">
                  ”{source.excerpt}”
                </blockquote>
                <div className="border-t px-3.5 py-2.5">
                  <Link
                    href={`/knowledge?document=${source.documentId}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                  >
                    Visa i kunskapsbanken
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                </div>
              </PopoverContent>
            </Popover>
          </li>
        ))}
      </ol>
    </div>
  );
}
