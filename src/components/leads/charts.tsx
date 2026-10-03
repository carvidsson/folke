"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { number, percent } from "./parts";

/**
 * Calm charts for the lead analysis (ADR-048): horizontal bars and one donut. Every chart shows the
 * numbers next to the shapes, so nothing depends on colour alone. Bars can link to a level or open the
 * leads behind them.
 */

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  /** Text to the right of the bar; defaults to the value. */
  valueLabel?: string;
  /** A second, quieter line under the label. */
  detail?: string;
  href?: string;
  onSelect?: () => void;
  /** Shown but not drawn (e.g. too little material for a median). */
  muted?: boolean;
  /** Drawn but toned down, with a short note (e.g. "Litet underlag"). */
  faded?: string;
}

export function BarList({ items, max, label, className }: { items: BarItem[]; max?: number; label: string; className?: string }) {
  const top = Math.max(1, max ?? Math.max(0, ...items.map((i) => i.value)));
  return (
    <ul className={cn("flex flex-col gap-2.5", className)} aria-label={label}>
      {items.map((item) => {
        const name = item.href ? (
          <Link href={item.href} className="underline-offset-4 hover:underline">
            {item.label}
          </Link>
        ) : item.onSelect ? (
          <button type="button" onClick={item.onSelect} className="text-left underline-offset-4 hover:underline">
            {item.label}
          </button>
        ) : (
          item.label
        );
        return (
          <li
            key={item.key}
            className={cn(
              // Phone: label and value on one line, the bar below. Wider: label, bar, value.
              "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(6.5rem,auto)] sm:gap-y-0",
              item.faded && "text-muted-foreground",
            )}
          >
            <span className="min-w-0 leading-snug">
              <span className="block truncate">{name}</span>
              {(item.detail || item.faded) && (
                <span className="block truncate text-xs text-muted-foreground">{[item.detail, item.faded].filter(Boolean).join(" · ")}</span>
              )}
            </span>
            <span className="order-last col-span-2 h-2 overflow-hidden rounded-full bg-muted sm:order-none sm:col-span-1" aria-hidden>
              {!item.muted && <span className={cn("block h-full rounded-full", item.faded ? "bg-navy-200" : "bg-navy-400")} style={{ width: `${(item.value / top) * 100}%` }} />}
            </span>
            <span className={cn("text-right tabular-nums", item.muted || item.faded ? "text-muted-foreground" : "text-foreground")}>{item.valueLabel ?? number.format(item.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const SEGMENT_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const REST_COLOUR = "var(--color-navy-100)";

/**
 * Part of the whole: a donut with at most five segments (the rest grouped as "Övriga") and a list with
 * every category, its count and share. The list is the exact record; the donut gives the shape.
 */
export function DonutWithList({
  items,
  total,
  label,
  onSelect,
}: {
  items: { name: string; value: number }[];
  total: number;
  label: string;
  onSelect?: (name: string) => void;
}) {
  const shown = items.length > 5 ? items.slice(0, 4) : items;
  const rest = items.length > 5 ? items.slice(4).reduce((n, i) => n + i.value, 0) : 0;
  const segments = [...shown.map((i, n) => ({ name: i.name, value: i.value, colour: SEGMENT_COLOURS[n] })), ...(rest ? [{ name: "Övriga", value: rest, colour: REST_COLOUR }] : [])];
  const colourOf = (name: string, index: number) => segments.find((s) => s.name === name)?.colour ?? (index >= 4 ? REST_COLOUR : SEGMENT_COLOURS[index]);
  const r = 15.9155; // circumference 100
  let offset = 25;
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <svg viewBox="0 0 42 42" className="mx-auto size-40" role="img" aria-label={label}>
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--color-muted)" strokeWidth="6" />
        {total > 0 &&
          segments.map((s) => {
            const length = (s.value / total) * 100;
            const el = (
              <circle
                key={s.name}
                cx="21"
                cy="21"
                r={r}
                fill="none"
                stroke={s.colour}
                strokeWidth="6"
                strokeDasharray={`${length} ${100 - length}`}
                strokeDashoffset={offset}
              />
            );
            offset -= length;
            return el;
          })}
        <text x="21" y="20.5" textAnchor="middle" className="fill-foreground text-[6px] font-medium tabular-nums">
          {number.format(total)}
        </text>
        <text x="21" y="26" textAnchor="middle" className="fill-muted-foreground text-[3px]">
          leads
        </text>
      </svg>
      <ul className="flex flex-col divide-y text-sm">
        {items.map((i, n) => (
          <li key={i.name} className="grid grid-cols-[minmax(0,1fr)_4rem_3.5rem] items-center gap-3 py-1.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colourOf(i.name, n) }} aria-hidden />
              {onSelect ? (
                <button type="button" className="truncate text-left underline-offset-4 hover:underline" onClick={() => onSelect(i.name)}>
                  {i.name}
                </button>
              ) : (
                <span className="truncate">{i.name}</span>
              )}
            </span>
            <span className="text-right tabular-nums">{number.format(i.value)}</span>
            <span className="text-right text-muted-foreground tabular-nums">{total ? percent.format(i.value / total) : "–"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The response-time distribution: bars for this period (count and share of the leads with a registered
 * reply) with a thin mark for the previous period's share in the same bucket.
 */
export function DistributionBars({
  buckets,
  total,
  previous,
  previousLabel,
  onSelect,
}: {
  buckets: { id: string; label: string; count: number }[];
  total: number;
  previous: { buckets: { id: string; count: number }[]; replied: number } | null;
  previousLabel: string;
  onSelect?: (id: string, label: string) => void;
}) {
  const share = (n: number, of: number) => (of ? n / of : 0);
  const top = Math.max(0.01, ...buckets.map((b) => share(b.count, total)), ...(previous?.buckets.map((b) => share(b.count, previous.replied)) ?? [0]));
  return (
    <div>
      <ul className="flex flex-col gap-2.5" aria-label="Svarstid till första registrerade säljsvar">
        {buckets.map((b) => {
          const now = share(b.count, total);
          const before = previous ? share(previous.buckets.find((p) => p.id === b.id)?.count ?? 0, previous.replied) : null;
          return (
            <li
              key={b.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(7.5rem,auto)] sm:gap-y-0"
            >
              {onSelect && b.count > 0 ? (
                <button type="button" className="text-left underline-offset-4 hover:underline" onClick={() => onSelect(b.id, b.label)}>
                  {b.label}
                </button>
              ) : (
                <span>{b.label}</span>
              )}
              <span className="relative order-last col-span-2 h-2 rounded-full bg-muted sm:order-none sm:col-span-1" aria-hidden>
                <span className="block h-full rounded-full bg-navy-400" style={{ width: `${(now / top) * 100}%` }} />
                {before !== null && <span className="absolute -top-1 h-4 w-0.5 rounded bg-foreground/60" style={{ left: `calc(${(before / top) * 100}% - 1px)` }} />}
              </span>
              <span className="text-right tabular-nums">
                {number.format(b.count)} <span className="text-muted-foreground">({percent.format(now)})</span>
                {before !== null && <span className="block text-xs text-muted-foreground">föreg. {percent.format(before)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {previous && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block h-3 w-0.5 rounded bg-foreground/60" aria-hidden />
          Strecket visar andelen i samma intervall {previousLabel} ({number.format(previous.replied)} leads med registrerat säljsvar).
        </p>
      )}
    </div>
  );
}
