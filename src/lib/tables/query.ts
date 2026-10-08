import { z } from "zod";

/**
 * Structured Excel analysis in Analysassistenten (ADR-055) – types shared by the server and the chat UI.
 *
 * A question is turned into one of these queries (by the planner, validated on the server, or by the
 * rule-based reading). Only the analyses and parameters listed here exist: no free filters, no SQL and
 * no code. A query is stored with the result it produced, so a follow-up question changes it rather
 * than starting over.
 */

export const TABLE_ANALYSES = ["repeats", "costs", "forecast", "quality", "parts"] as const;
export type TableAnalysis = (typeof TABLE_ANALYSES)[number];

export const REPEAT_WINDOWS = [3, 6, 12, 24] as const;

export const COST_DIMENSIONS = ["vehicle", "contract", "year", "month", "workshop", "site", "group", "subgroup", "cost_type"] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export const REPEAT_SORTS = ["date", "cost", "days"] as const;

export const tableQuerySchema = z.object({
  analysis: z.enum(TABLE_ANALYSES),
  /** Repeats: the longest time between two occasions, in calendar months. */
  windowMonths: z.union([z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
  /** Repeats: only pairs at the same workshop. */
  sameWorkshop: z.boolean(),
  /** Repeats: include planned maintenance (expected to recur, so excluded by default). */
  includeMaintenance: z.boolean(),
  /** One vehicle: the 1-based vehicle number of the dataset (the order of the files). Null = all. */
  vehicle: z.number().int().min(1).max(50).nullable(),
  /** One main group (Hgrp code). Null = all. */
  group: z.string().regex(/^[0-9A-Za-z]{1,6}$/).nullable(),
  sort: z.enum(REPEAT_SORTS),
  /** How many rows to show (the full result is still counted). Null = all. */
  limit: z.number().int().min(1).max(100).nullable(),
  by: z.enum(COST_DIMENSIONS),
});
export type TableQuery = z.infer<typeof tableQuerySchema>;

export const DEFAULT_TABLE_QUERY: TableQuery = {
  analysis: "repeats",
  windowMonths: 12,
  sameWorkshop: false,
  includeMaintenance: false,
  vehicle: null,
  group: null,
  sort: "date",
  limit: null,
  by: "vehicle",
};

/** How a column is formatted. "kr" and "km" are whole numbers with thin-space thousands. */
export type TableCellFormat = "text" | "date" | "kr" | "km" | "days" | "int" | "pct";

/** What a column holds, for pseudonymisation of the model's brief: identifiers get aliases, refs are left out. */
export type TableCellPrivacy = "plain" | "vehicle" | "contract" | "site" | "file" | "omit";

export interface TableColumn {
  key: string;
  label: string;
  format: TableCellFormat;
  privacy: TableCellPrivacy;
}

export interface TableRowRef {
  /** 1-based file number in the analysis. */
  file: number;
  fileName: string;
  sheet: string;
  rows: number[];
}

export interface TableRow {
  cells: Record<string, string | number | null>;
  refs: TableRowRef[];
}

const SPACE = " ";

export function formatTableCell(value: string | number | null | undefined, format: TableCellFormat): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "string") return value;
  const whole = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, SPACE).replace("-", "−");
  switch (format) {
    case "kr":
      return `${whole(value)} kr`;
    case "km":
      return `${whole(value)} km`;
    case "days":
      return `${whole(value)} d`;
    case "pct":
      return `${Math.round(value)} %`;
    case "int":
      return whole(value);
    default:
      return String(value);
  }
}

/** "Fil 1, rad 34, 35 och 40" – in the UI with the real file name. */
export function formatRowRefs(refs: TableRowRef[], withName = true): string {
  return refs
    .map((r) => {
      const rows = r.rows.length > 6 ? `${r.rows.slice(0, 6).join(", ")} …` : r.rows.join(", ");
      return `${withName ? r.fileName : `Fil ${r.file}`}, rad ${rows}`;
    })
    .join("; ");
}
