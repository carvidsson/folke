"use client";

import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

import { StatusBadge } from "@/components/common/status-badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { EvidenceRow } from "@/lib/leads/types";
import { evidenceAction } from "@/server/leads/actions";

import { formatDateTime, number, OriginBadge, STATUS, type Origin } from "./parts";

export interface EvidenceRequest {
  title: string;
  description: string;
  origin: Origin;
  filter?: string;
  threadIds?: string[];
}

/**
 * The leads behind an observation (ADR-048): structured, avidentified
 * reasons from Folke and a link to read the original in HubSpot. Folke never
 * shows or stores the dialogue itself.
 */
export function EvidenceSheet({
  request,
  scope,
  linkConfigured,
  onClose,
}: {
  request: EvidenceRequest | null;
  scope: Record<string, string | null | undefined>;
  linkConfigured: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!request} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-xl">
        {request && (
          <>
            <SheetHeader className="border-b">
              <div className="mb-1">
                <OriginBadge origin={request.origin} />
              </div>
              <SheetTitle>{request.title}</SheetTitle>
              <SheetDescription>{request.description}</SheetDescription>
            </SheetHeader>
            {/* A new request remounts the list, so it always starts empty. */}
            <EvidenceList key={`${request.filter}|${request.threadIds?.join(",")}`} request={request} scope={scope} linkConfigured={linkConfigured} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function EvidenceList({ request, scope, linkConfigured }: { request: EvidenceRequest; scope: Record<string, string | null | undefined>; linkConfigured: boolean }) {
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    start(async () => {
      const result = await evidenceAction(scope, { filter: request.filter, threadIds: request.threadIds }).catch(() => null);
      if (result?.ok) setRows(result.data);
      else setError(result && !result.ok ? result.error : "Underlaget kunde inte hämtas.");
    });
    // Mounted once per request (keyed above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="px-4 py-4">
      {pending && !rows && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}
      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
      {rows && (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {number.format(rows.length)} leads. Motiveringarna kommer från AI-analysen av avidentifierad text. Originaldialogen finns i HubSpot.
          </p>
          {!linkConfigured && <p className="mb-3 text-xs text-muted-foreground">Länken till HubSpot är inte konfigurerad ännu (Administration → Leadanalys).</p>}
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.threadId} className="rounded-lg border bg-card px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium tabular-nums">{formatDateTime(r.arrivedAt)}</span>
                  <StatusBadge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{[r.inbox, r.source, r.vehicle, r.seller].filter(Boolean).join(" · ")}</p>
                {r.reason && <p className="mt-2 text-sm">{r.reason}</p>}
                {r.hubspotUrl && (
                  <a
                    href={r.hubspotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-foreground underline-offset-4 hover:underline"
                  >
                    Öppna original i HubSpot
                    <ArrowUpRight className="size-3.5" aria-hidden />
                    <span className="sr-only">(öppnas i en ny flik)</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
