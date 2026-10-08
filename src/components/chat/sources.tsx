"use client";

import { ArrowUpRight, ChevronDown, FileText, ListChecks, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EvidenceSheet, type EvidenceRequest } from "@/components/leads/evidence-sheet";
import { OriginBadge } from "@/components/leads/parts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChatActions } from "./chat-actions";
import { LeadActions } from "./lead-actions";
import { TableResult } from "./table-result";
import {
  isDocumentSource,
  type LeadActionReference,
  type LeadBasisReference,
  type LeadPromptsReference,
  type LeadSetReference,
  type LeadSourceReference,
  type MessageSource,
  type SourceReference,
  type TableResultReference,
} from "@/lib/domain/types";

/** Sets shown directly; the rest are one click away, so a long answer does not get a wall of buttons. */
const SETS_SHOWN = 3;

const TRIGGER =
  "group inline-flex h-7 max-w-72 items-center gap-1.5 rounded-md border bg-background pr-2.5 pl-1 text-xs text-muted-foreground shadow-xs outline-none transition-colors hover:border-navy-300 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:border-navy-300 data-[state=open]:text-foreground";

function NumberChip({ n }: { n: number }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-sage-100 px-1 text-[0.6875rem] font-semibold text-sage-700">
      {n}
    </span>
  );
}

/**
 * Sources under an assistant answer: numbered document excerpts or leads ([n] in the text), and for
 * Leadanalys (ADR-050) the basis the server wrote and the lead sets behind aggregated statements.
 */
export function Sources({ sources, idPrefix }: { sources: MessageSource[]; idPrefix: string }) {
  const [evidence, setEvidence] = useState<{ request: EvidenceRequest; scope: LeadSetReference["scope"] } | null>(null);
  const [allSets, setAllSets] = useState(false);
  if (!sources.length) return null;

  const numbered = sources.filter((s): s is SourceReference | LeadSourceReference => isDocumentSource(s) || s.kind === "lead");
  const basis = sources.find((s): s is LeadBasisReference => s.kind === "lead_basis");
  const sets = sources.filter((s): s is LeadSetReference => s.kind === "lead_set");
  const actions = sources.filter((s): s is LeadActionReference => s.kind === "lead_action");
  const prompts = sources.find((s): s is LeadPromptsReference => s.kind === "lead_prompts");
  const tables = sources.filter((s): s is TableResultReference => s.kind === "table_result");
  const shownSets = allSets ? sets : sets.slice(0, SETS_SHOWN);
  const leadsOnly = numbered.length > 0 && numbered.every((s) => !isDocumentSource(s));

  return (
    <div className="mt-4 flex flex-col gap-3">
      {actions.map((a) => (
        <LeadActions key={a.id} action={a} />
      ))}
      {tables.map((t) => (
        <TableResult key={t.id} result={t} />
      ))}
      {tables.map((t) => t.prompts?.length ? <SuggestedPrompts key={`prompts-${t.id}`} prompts={t.prompts} /> : null)}
      {prompts && <SuggestedPrompts prompts={prompts.prompts} turns={prompts.turns} />}
      {numbered.length > 0 && (
        <div>
          <p className="text-overline mb-2">{leadsOnly ? "Leads i svaret" : "Källor"}</p>
          <ol className="flex flex-wrap gap-1.5">
            {numbered.map((source, i) => (
              <li key={source.id} id={`cite-${idPrefix}-${i + 1}`} className="scroll-mt-24">
                {isDocumentSource(source) ? <DocumentSource source={source} n={i + 1} /> : <LeadSource source={source} n={i + 1} />}
              </li>
            ))}
          </ol>
        </div>
      )}
      {sets.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {shownSets.map((set) => (
            <li key={set.id}>
              <button
                type="button"
                className={TRIGGER}
                onClick={() =>
                  setEvidence({
                    scope: set.scope,
                    request: {
                      title: set.title,
                      description: "Leads i urvalet bakom det svaret beskriver. Motiveringarna kommer från den sparade AI-analysen, och originalet finns i HubSpot.",
                      origin: set.id === "no_reply_open" ? "fact" : "classification",
                      threadIds: set.threadIds,
                    },
                  })
                }
              >
                <ListChecks className="ml-1 size-3.5 shrink-0" />
                <span className="truncate font-medium">
                  Visa alla {set.count}: {set.title}
                </span>
              </button>
            </li>
          ))}
          {!allSets && sets.length > SETS_SHOWN && (
            <li>
              <button type="button" className={TRIGGER} onClick={() => setAllSets(true)}>
                <ChevronDown className="ml-1 size-3.5 shrink-0" />
                <span className="font-medium">Fler underlag ({sets.length - SETS_SHOWN})</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {basis && <Basis basis={basis} />}
      {evidence && (
        <EvidenceSheet request={evidence.request} scope={evidence.scope} linkConfigured onClose={() => setEvidence(null)} />
      )}
    </div>
  );
}

function DocumentSource({ source, n }: { source: SourceReference; n: number }) {
  return (
    <Popover>
      <PopoverTrigger className={TRIGGER}>
        <NumberChip n={n} />
        <span className="truncate font-medium">{source.title}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-start gap-3 border-b p-3.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileText className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-sm leading-5 font-medium">{source.title}</p>
            {source.location && <p className="text-caption">{source.location}</p>}
          </div>
        </div>
        <blockquote className="p-3.5 text-[0.8125rem] leading-5 text-foreground/85">”{source.excerpt}”</blockquote>
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
  );
}

function LeadSource({ source, n }: { source: LeadSourceReference; n: number }) {
  return (
    <Popover>
      <PopoverTrigger className={TRIGGER}>
        <NumberChip n={n} />
        <span className="truncate font-medium">{source.title}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-start gap-3 border-b p-3.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <MessagesSquare className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-sm leading-5 font-medium">{source.title}</p>
            <p className="text-caption">{[source.inbox, source.seller].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 p-3.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <OriginBadge origin={source.origin} />
            {source.label && <span className="text-xs font-medium">{source.label}</span>}
          </div>
          {source.reason && <p className="text-[0.8125rem] leading-5 text-foreground/85">{source.reason}</p>}
        </div>
        <div className="border-t px-3.5 py-2.5">
          {source.hubspotUrl ? (
            <a
              href={source.hubspotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
            >
              Öppna original i HubSpot
              <ArrowUpRight className="size-3.5" aria-hidden />
              <span className="sr-only">(öppnas i en ny flik)</span>
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">Länken till HubSpot är inte konfigurerad.</span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Basis({ basis }: { basis: LeadBasisReference }) {
  return (
    <details className="group rounded-md border bg-surface px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        Underlag: {basis.selection} · {basis.period}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {basis.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Questions the user can ask next with one click ("Jag vill veta mer om en säljare"): each is sent as the
 * user's own next message, so it goes through the same chat as a typed question. Typing stays possible.
 */
function SuggestedPrompts({ prompts, turns }: { prompts: string[]; turns?: LeadPromptsReference["turns"] }) {
  const chat = useChatActions();
  if (!chat || !prompts.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Förslag på frågor">
      {prompts.map((p, i) => (
        <li key={p}>
          <button
            type="button"
            disabled={chat.busy}
            onClick={() => chat.ask(p, turns?.[i])}
            className="rounded-md border bg-background px-2.5 py-1.5 text-left text-xs shadow-xs transition-colors hover:border-navy-300 hover:text-foreground disabled:opacity-50"
          >
            {p}
          </button>
        </li>
      ))}
    </ul>
  );
}
