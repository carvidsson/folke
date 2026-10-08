"use client";

import { ChevronDown, Table2 } from "lucide-react";
import { useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TableResultReference } from "@/lib/domain/types";
import { formatRowRefs, formatTableCell } from "@/lib/tables/query";

/** Rows shown before "Visa alla". */
const ROWS_SHOWN = 10;

const NUMERIC = new Set(["kr", "km", "days", "int", "pct"]);

/**
 * A table computed on the server from the user's own Excel attachments (ADR-055): every row with the
 * original file and row numbers, so each figure can be checked in the file. Real values – this is the
 * owner's own conversation; the model only got a pseudonymised summary.
 */
export function TableResult({ result }: { result: TableResultReference }) {
  const [all, setAll] = useState(false);
  const rows = all ? result.rows : result.rows.slice(0, ROWS_SHOWN);
  const hasRefs = result.rows.some((r) => r.refs.length > 0);
  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-start gap-2.5 border-b px-3 py-2.5">
        <Table2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm leading-5 font-medium">{result.title}</p>
          <p className="text-caption">
            {result.total === 0
              ? "Inga rader"
              : result.rows.length < result.total
                ? `${result.rows.length} av ${result.total} rader`
                : `${result.total} ${result.total === 1 ? "rad" : "rader"}`}
            {" · beräknat av Folke från dina filer"}
          </p>
        </div>
      </div>
      {rows.length > 0 && (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {result.columns.map((c) => (
                <TableHead key={c.key} className={NUMERIC.has(c.format) ? "text-right" : undefined}>
                  {c.label}
                </TableHead>
              ))}
              {hasRefs && <TableHead>Källa</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {result.columns.map((c) => (
                  <TableCell key={c.key} className={NUMERIC.has(c.format) ? "text-right tabular-nums whitespace-nowrap" : "max-w-56 whitespace-normal"}>
                    {formatTableCell(r.cells[c.key], c.format)}
                  </TableCell>
                ))}
                {hasRefs && <TableCell className="max-w-64 whitespace-normal text-muted-foreground">{r.refs.length ? formatRowRefs(r.refs) : "–"}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {!all && result.rows.length > ROWS_SHOWN && (
        <div className="border-t px-3 py-2">
          <button type="button" onClick={() => setAll(true)} className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline">
            <ChevronDown className="size-3.5" aria-hidden />
            Visa alla {result.rows.length}
          </button>
        </div>
      )}
      {result.lines.length > 0 && (
        <details className="border-t px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">Så har det räknats</summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {result.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {result.rows.length < result.total && <p className="mt-1.5">Tabellen sparar de första {result.rows.length} raderna av {result.total}. Ställ en smalare fråga för att se resten.</p>}
        </details>
      )}
    </div>
  );
}
