import "server-only";

import type { CostDimension, TableColumn, TableQuery, TableRow, TableRowRef } from "@/lib/tables/query";

import type { ScaniaFile, ScaniaTransaction } from "./scania";

/**
 * The analyses of Scania contract exports (ADR-055). Pure and deterministic: transactions in, a table
 * with references to the original rows out. Nothing here talks to a model; the model only explains a
 * pseudonymised summary of what is computed here.
 *
 * Rules (also stated with every result):
 * - An occasion is one work order for one vehicle and one main and sub group (Hgrp/Ugrp): its rows are
 *   summed, its date is the earliest repair date and its odometer the highest reading among them. So
 *   one work order is never counted as several occasions.
 * - A repeat is the next occasion of the same vehicle and group, in another work order, within the
 *   window (calendar months). It is a candidate for review, not a finding of the same fault or part.
 * - Planned maintenance recurs by design and is left out of repeats unless asked for.
 * - Kilometres between occasions only when both readings exist and do not decrease. Cost per 1 000 km
 *   only for a vehicle whose readings never decrease over time.
 */

export interface Dataset {
  files: ScaniaFile[];
  transactions: ScaniaTransaction[];
  /** Real registration numbers in vehicle order (Fordon 1, 2, …). */
  vehicles: string[];
}

export interface Computed {
  title: string;
  /** Server-written lines: what was computed, among what, and the rules. Never identifiers. */
  lines: string[];
  columns: TableColumn[];
  rows: TableRow[];
  /** Questions that make sense next. */
  prompts: string[];
}

export function buildDataset(files: ScaniaFile[]): Dataset {
  const transactions = files.flatMap((f) => f.transactions);
  const vehicles: string[] = [];
  for (const t of transactions) if (!vehicles.includes(t.regnr)) vehicles.push(t.regnr);
  return { files, transactions, vehicles };
}

// --- Dates ----------------------------------------------------------------------------

const DAY = 86_400_000;
const time = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((time(b) - time(a)) / DAY);

/** The date `months` calendar months after `date`, clamped to the end of a shorter month (31 jan + 1 = 28/29 feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Whole months from `from` to `to` (a started month does not count). */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
}

const round = (n: number) => Math.round(n * 100) / 100;

// --- Occasions ----------------------------------------------------------------------------

export interface Occasion {
  key: string;
  vehicle: string;
  order: string;
  group: { main: string | null; sub: string | null; name: string | null };
  date: string;
  odometer: number | null;
  workshop: string | null;
  site: string | null;
  maintenance: boolean;
  labour: number;
  material: number;
  total: number;
  rows: ScaniaTransaction[];
}

export const isMaintenance = (t: Pick<ScaniaTransaction, "scope">) => /underhåll/i.test(t.scope.name ?? "");

export function occasions(transactions: ScaniaTransaction[]): Occasion[] {
  const map = new Map<string, Occasion>();
  for (const t of transactions) {
    if (!t.repairDate) continue;
    // Without a work order number each row is its own occasion.
    const order = t.order ?? `rad ${t.file}:${t.row}`;
    const key = [t.regnr, order, t.group.main ?? "", t.group.sub ?? ""].join("|");
    const o = map.get(key);
    const labour = t.costs.labourOwn + t.costs.labourExternal;
    const material = t.costs.materialOwn + t.costs.materialExternal;
    if (!o) {
      map.set(key, {
        key,
        vehicle: t.regnr,
        order,
        group: { ...t.group },
        date: t.repairDate,
        odometer: t.odometer && t.odometer > 0 ? t.odometer : null,
        workshop: t.workshop,
        site: t.site.name,
        maintenance: isMaintenance(t),
        labour,
        material,
        total: t.costs.total,
        rows: [t],
      });
      continue;
    }
    if (t.repairDate < o.date) o.date = t.repairDate;
    if (t.odometer && t.odometer > 0) o.odometer = Math.max(o.odometer ?? 0, t.odometer);
    o.maintenance &&= isMaintenance(t);
    o.labour += labour;
    o.material += material;
    o.total += t.costs.total;
    o.rows.push(t);
    o.group.name ??= t.group.name;
    o.workshop ??= t.workshop;
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

export function refsOf(rows: ScaniaTransaction[]): TableRowRef[] {
  const byFile = new Map<number, TableRowRef>();
  for (const t of rows) {
    const r = byFile.get(t.file) ?? { file: t.file, fileName: t.fileName, sheet: t.sheet, rows: [] };
    r.rows.push(t.row);
    byFile.set(t.file, r);
  }
  return [...byFile.values()].map((r) => ({ ...r, rows: [...new Set(r.rows)].sort((a, b) => a - b) })).sort((a, b) => a.file - b.file);
}

const groupLabel = (g: Occasion["group"]) => [g.main && g.sub ? `${g.main}/${g.sub}` : (g.main ?? g.sub ?? "?"), g.name].filter(Boolean).join(" ");

/** Readings sorted by date never decrease: the vehicle's kilometres can be used for per-km figures. */
export function odometerSeries(transactions: ScaniaTransaction[], vehicle: string) {
  const readings = transactions
    .filter((t) => t.regnr === vehicle && t.repairDate && t.odometer && t.odometer > 0)
    .sort((a, b) => (a.repairDate! < b.repairDate! ? -1 : a.repairDate! > b.repairDate! ? 1 : a.file - b.file || a.row - b.row));
  let decreases = 0;
  for (let i = 1; i < readings.length; i++) if (readings[i].odometer! < readings[i - 1].odometer!) decreases++;
  const first = readings[0]?.odometer ?? null;
  const last = readings.at(-1)?.odometer ?? null;
  return { readings: readings.length, decreases, valid: readings.length >= 2 && decreases === 0, km: first !== null && last !== null ? last - first : null };
}

// --- A. Recurring repairs -------------------------------------------------------------------

export interface RepeatPair {
  vehicle: string;
  first: Occasion;
  second: Occasion;
  days: number;
  km: number | null;
}

export function repeatPairs(ds: Dataset, q: Pick<TableQuery, "windowMonths" | "sameWorkshop" | "includeMaintenance" | "vehicle" | "group">): RepeatPair[] {
  const vehicle = q.vehicle ? ds.vehicles[q.vehicle - 1] : null;
  const list = occasions(ds.transactions).filter(
    (o) => (q.includeMaintenance || !o.maintenance) && (!vehicle || o.vehicle === vehicle) && (!q.group || o.group.main === q.group),
  );
  const series = new Map<string, Occasion[]>();
  for (const o of list) {
    const key = `${o.vehicle}|${o.group.main ?? ""}|${o.group.sub ?? ""}`;
    series.set(key, [...(series.get(key) ?? []), o]);
  }
  const pairs: RepeatPair[] = [];
  for (const s of series.values()) {
    for (let i = 1; i < s.length; i++) {
      const [first, second] = [s[i - 1], s[i]];
      if (second.date > addMonths(first.date, q.windowMonths)) continue;
      if (q.sameWorkshop && (!first.workshop || first.workshop !== second.workshop)) continue;
      const km = first.odometer !== null && second.odometer !== null && second.odometer >= first.odometer ? second.odometer - first.odometer : null;
      pairs.push({ vehicle: first.vehicle, first, second, days: daysBetween(first.date, second.date), km });
    }
  }
  return pairs;
}

export function repeatsAnalysis(ds: Dataset, q: TableQuery): Computed {
  const pairs = repeatPairs(ds, q);
  const sorted = [...pairs].sort((a, b) =>
    q.sort === "cost" ? b.second.total - a.second.total || a.days - b.days : q.sort === "days" ? a.days - b.days || b.second.total - a.second.total : b.second.date.localeCompare(a.second.date),
  );
  const vehicle = q.vehicle ? ds.vehicles[q.vehicle - 1] : null;
  const pool = occasions(ds.transactions).filter((o) => (q.includeMaintenance || !o.maintenance) && (!vehicle || o.vehicle === vehicle) && (!q.group || o.group.main === q.group));
  const vehicles = new Set(pool.map((o) => o.vehicle)).size;
  const sortText = q.sort === "cost" ? "sorterade efter kostnaden för det återkommande tillfället, högst först" : q.sort === "days" ? "sorterade efter kortast tid mellan tillfällena" : "nyast först";
  const lines = [
    `${pairs.length} granskningskandidater: samma fordon och samma huvud- och undergrupp i en annan arbetsorder inom ${q.windowMonths} månader${q.sameWorkshop ? ", hos samma verkstad" : ""}. Räknat bland ${pool.length} reparationstillfällen på ${vehicles} fordon${q.group ? ` i huvudgrupp ${q.group}` : ""}.`,
    "Ett reparationstillfälle är en arbetsorder för ett fordon och en huvud- och undergrupp; raderna i den summeras. En arbetsorder räknas aldrig som flera tillfällen.",
    q.includeMaintenance ? "Planerat underhåll ingår." : "Planerat underhåll (underhåll enligt plan och flexibelt underhåll) ingår inte, eftersom det återkommer enligt plan.",
    "Samma grupp betyder inte att samma del eller samma fel har åtgärdats – exporten saknar artikelnummer. Kandidaterna behöver granskas mot arbetsordrarna.",
    "Kilometer mellan tillfällena visas bara när båda mätarställningarna finns och inte minskar.",
    `Tabellen visar ${sortText}.`,
  ];
  const rows: TableRow[] = sorted.map((p) => ({
    cells: {
      vehicle: p.vehicle,
      group: groupLabel(p.second.group),
      firstDate: p.first.date,
      secondDate: p.second.date,
      days: p.days,
      km: p.km,
      firstCost: round(p.first.total),
      secondCost: round(p.second.total),
      firstWorkshop: p.first.workshop,
      secondWorkshop: p.second.workshop,
      orders: `${p.first.order} → ${p.second.order}`,
    },
    refs: refsOf([...p.first.rows, ...p.second.rows]),
  }));
  return {
    title: `Återkommande reparationer inom ${q.windowMonths} månader`,
    lines,
    columns: [
      { key: "vehicle", label: "Fordon", format: "text", privacy: "vehicle" },
      { key: "group", label: "Grupp", format: "text", privacy: "plain" },
      { key: "firstDate", label: "Första", format: "date", privacy: "plain" },
      { key: "secondDate", label: "Igen", format: "date", privacy: "plain" },
      { key: "days", label: "Dagar", format: "days", privacy: "plain" },
      { key: "km", label: "Km emellan", format: "km", privacy: "plain" },
      { key: "firstCost", label: "Kostnad första", format: "kr", privacy: "plain" },
      { key: "secondCost", label: "Kostnad igen", format: "kr", privacy: "plain" },
      { key: "firstWorkshop", label: "Verkstad första", format: "text", privacy: "plain" },
      { key: "secondWorkshop", label: "Verkstad igen", format: "text", privacy: "plain" },
      { key: "orders", label: "Arbetsorder", format: "text", privacy: "omit" },
    ],
    rows,
    prompts: [
      q.windowMonths !== 6 ? "Visa bara de som skett inom sex månader" : "Visa inom tolv månader",
      q.sameWorkshop ? "Visa alla verkstäder" : "Vilka gäller samma verkstad?",
      q.sort === "cost" ? "Sortera efter kortast tid" : "Sortera efter högst kostnad",
      "Jämför fordonen",
    ],
  };
}

// --- B. Costs ---------------------------------------------------------------------------------

const DIMENSION_LABEL: Record<CostDimension, string> = {
  vehicle: "Fordon",
  contract: "Avtal",
  year: "År",
  month: "Månad",
  workshop: "Verkstad",
  site: "Driftställe",
  group: "Huvudgrupp",
  subgroup: "Huvud- och undergrupp",
  cost_type: "Kostnadsslag",
};

const DIMENSION_PRIVACY: Record<CostDimension, TableColumn["privacy"]> = {
  vehicle: "vehicle",
  contract: "contract",
  year: "plain",
  month: "plain",
  workshop: "plain",
  site: "site",
  group: "plain",
  subgroup: "plain",
  cost_type: "plain",
};

function keyOf(t: ScaniaTransaction, by: CostDimension): string {
  switch (by) {
    case "vehicle":
      return t.regnr;
    case "contract":
      return t.contract.number ?? "(saknas)";
    case "year":
      return t.repairDate?.slice(0, 4) ?? "(datum saknas)";
    case "month":
      return t.repairDate?.slice(0, 7) ?? "(datum saknas)";
    case "workshop":
      return t.workshop ?? "(saknas)";
    case "site":
      return t.site.name ?? "(saknas)";
    case "group":
      return [t.group.main, t.group.name].filter(Boolean).join(" ") || "(saknas)";
    case "subgroup":
      return [t.group.main && t.group.sub ? `${t.group.main}/${t.group.sub}` : t.group.main, t.group.name].filter(Boolean).join(" ") || "(saknas)";
    case "cost_type":
      return "";
  }
}

export function costsAnalysis(ds: Dataset, q: TableQuery): Computed {
  const vehicle = q.vehicle ? ds.vehicles[q.vehicle - 1] : null;
  const tx = ds.transactions.filter((t) => (!vehicle || t.regnr === vehicle) && (!q.group || t.group.main === q.group));
  const total = round(tx.reduce((s, t) => s + t.costs.total, 0));
  const dates = tx.map((t) => t.repairDate).filter((d): d is string => !!d).sort();
  const scope = `${tx.length} transaktionsrader${vehicle ? " för ett fordon" : ` för ${new Set(tx.map((t) => t.regnr)).size} fordon`}${q.group ? ` i huvudgrupp ${q.group}` : ""}, reparationsdatum ${dates[0] ?? "–"} till ${dates.at(-1) ?? "–"}`;
  const lines = [`Total kostnad ${Math.round(total).toLocaleString("sv-SE")} kr bland ${scope}. Summaraderna i filerna räknas inte.`];

  if (q.by === "cost_type") {
    const parts = [
      ["Arbete (egen verkstad)", tx.reduce((s, t) => s + t.costs.labourOwn, 0)],
      ["Material (egen verkstad)", tx.reduce((s, t) => s + t.costs.materialOwn, 0)],
      ["Arbete (främmande verkstad)", tx.reduce((s, t) => s + t.costs.labourExternal, 0)],
      ["Material (främmande verkstad)", tx.reduce((s, t) => s + t.costs.materialExternal, 0)],
    ] as const;
    return {
      title: "Kostnad per kostnadsslag",
      lines: [...lines, "Arbete och material är summan av egen och främmande verkstad enligt exportens kolumner."],
      columns: [
        { key: "key", label: "Kostnadsslag", format: "text", privacy: "plain" },
        { key: "total", label: "Kostnad", format: "kr", privacy: "plain" },
        { key: "share", label: "Andel", format: "pct", privacy: "plain" },
      ],
      rows: parts.map(([key, sum]) => ({ cells: { key, total: round(sum), share: total ? (sum / total) * 100 : null }, refs: [] })),
      prompts: ["Visa kostnad per år", "Vilka huvudgrupper kostar mest?", "Jämför fordonen"],
    };
  }

  const groups = new Map<string, ScaniaTransaction[]>();
  for (const t of tx) groups.set(keyOf(t, q.by), [...(groups.get(keyOf(t, q.by)) ?? []), t]);
  const time = q.by === "year" || q.by === "month";
  const entries = [...groups.entries()].sort((a, b) => (time ? a[0].localeCompare(b[0]) : sumOf(b[1]) - sumOf(a[1])));
  const columns: TableColumn[] = [
    { key: "key", label: DIMENSION_LABEL[q.by], format: "text", privacy: DIMENSION_PRIVACY[q.by] },
    { key: "orders", label: "Arbetsordrar", format: "int", privacy: "plain" },
    { key: "labour", label: "Arbete", format: "kr", privacy: "plain" },
    { key: "material", label: "Material", format: "kr", privacy: "plain" },
    { key: "total", label: "Totalt", format: "kr", privacy: "plain" },
    { key: "share", label: "Andel", format: "pct", privacy: "plain" },
  ];
  if (time) columns.push({ key: "change", label: "Mot föregående", format: "pct", privacy: "plain" });
  if (q.by === "vehicle") {
    columns.push({ key: "km", label: "Körda km", format: "km", privacy: "plain" }, { key: "perKkm", label: "Kr per 1 000 km", format: "kr", privacy: "plain" });
    lines.push("Körda km och kostnad per 1 000 km visas bara för fordon vars mätarställningar aldrig minskar över tid; annars är mätarställningen inte tillförlitlig nog.");
  }
  if (time) {
    lines.push(
      q.by === "year"
        ? "Första och sista året kan vara ofullständiga: de omfattar bara den del av året som finns i filerna."
        : "Månader utan reparationer saknas i tabellen. Enskilda månader varierar mycket; se trenden över flera månader.",
    );
  }
  if (q.by === "contract") lines.push("Varje avtal gäller ett fordon. Avtalets intäkter finns inte i filerna, så kostnaden säger ingenting om lönsamhet.");
  let previous: number | null = null;
  const rows: TableRow[] = entries.map(([key, list]) => {
    const sum = sumOf(list);
    const cells: TableRow["cells"] = {
      key,
      orders: new Set(list.map((t) => `${t.regnr}|${t.order ?? `${t.file}:${t.row}`}`)).size,
      labour: round(list.reduce((s, t) => s + t.costs.labourOwn + t.costs.labourExternal, 0)),
      material: round(list.reduce((s, t) => s + t.costs.materialOwn + t.costs.materialExternal, 0)),
      total: round(sum),
      share: total ? (sum / total) * 100 : null,
    };
    if (time) {
      cells.change = previous ? ((sum - previous) / previous) * 100 : null;
      previous = sum;
    }
    if (q.by === "vehicle") {
      const s = odometerSeries(ds.transactions, key);
      cells.km = s.valid ? s.km : null;
      cells.perKkm = s.valid && s.km ? round((sum / s.km) * 1000) : null;
    }
    // Groups and years can span hundreds of rows: refs only where they stay readable.
    return { cells, refs: list.length <= 60 ? refsOf(list) : [] };
  });
  return {
    title: `Kostnad per ${DIMENSION_LABEL[q.by].toLowerCase()}`,
    lines,
    columns,
    rows,
    prompts:
      q.by === "vehicle"
        ? ["Visa kostnad per år", "Vilka huvudgrupper kostar mest?", "Hur fördelas kostnaden på arbete och material?"]
        : ["Jämför fordonen", "Vilka reparationer återkommer inom 12 månader?", "Visa kostnad per verkstad"],
  };
}

const sumOf = (list: ScaniaTransaction[]) => list.reduce((s, t) => s + t.costs.total, 0);

// --- C. Simple contract forecast --------------------------------------------------------------------

/** Below this many months of history no extrapolation is given. */
export const MIN_FORECAST_MONTHS = 6;

export function forecastAnalysis(ds: Dataset, q: TableQuery): Computed {
  const vehicle = q.vehicle ? ds.vehicles[q.vehicle - 1] : null;
  const contracts = new Map<string, ScaniaTransaction[]>();
  for (const t of ds.transactions) {
    if (vehicle && t.regnr !== vehicle) continue;
    const key = `${t.regnr}|${t.contract.number ?? ""}`;
    contracts.set(key, [...(contracts.get(key) ?? []), t]);
  }
  const rows: TableRow[] = [];
  for (const list of contracts.values()) {
    const c = list[0].contract;
    const asOf = list.map((t) => t.repairDate).filter((d): d is string => !!d).sort().at(-1) ?? null;
    const cost = round(sumOf(list));
    const length = c.start && c.end ? monthsBetween(c.start, c.end) + 1 : null;
    const elapsed = c.start && asOf ? Math.max(monthsBetween(c.start, asOf) + 1, 1) : null;
    const remaining = length !== null && elapsed !== null ? Math.max(length - elapsed, 0) : null;
    const perMonth = elapsed ? round(cost / elapsed) : null;
    const rest = perMonth !== null && remaining !== null && elapsed !== null && elapsed >= MIN_FORECAST_MONTHS && remaining > 0 ? round(perMonth * remaining) : null;
    const projected = rest !== null ? round(cost + rest) : null;
    rows.push({
      cells: {
        vehicle: list[0].regnr,
        contract: c.number,
        type: c.type,
        start: c.start,
        end: c.end,
        asOf,
        cost,
        elapsed,
        remaining,
        perMonth,
        rest,
        projected,
      },
      refs: [],
    });
  }
  return {
    title: "Avtalens kostnad hittills och enkel framskrivning",
    lines: [
      "Kostnad hittills är summan av transaktionsraderna fram till senaste reparationsdatum i filen; summaraderna räknas inte.",
      `Framskrivningen är linjär: genomsnittlig kostnad per påbörjad avtalsmånad hittills gånger återstående månader ("Resten av avtalet"), plus kostnaden hittills ("Framskriven total"). Den ges bara när minst ${MIN_FORECAST_MONTHS} månader har gått och avtalet inte har löpt ut.`,
      "Den tar inte hänsyn till fordonets ålder, körsträcka, säsong, planerat underhåll eller enstaka stora reparationer, och kan avvika kraftigt.",
      "Avtalets intäkter finns inte i filerna. Framskrivningen säger ingenting om lönsamhet, vinst eller förlust.",
    ],
    columns: [
      { key: "vehicle", label: "Fordon", format: "text", privacy: "vehicle" },
      { key: "contract", label: "Avtal", format: "text", privacy: "contract" },
      { key: "type", label: "Avtalstyp", format: "text", privacy: "plain" },
      { key: "start", label: "Start", format: "date", privacy: "plain" },
      { key: "end", label: "Slut", format: "date", privacy: "plain" },
      { key: "asOf", label: "Data t.o.m.", format: "date", privacy: "plain" },
      { key: "cost", label: "Kostnad hittills", format: "kr", privacy: "plain" },
      { key: "elapsed", label: "Månader", format: "int", privacy: "plain" },
      { key: "remaining", label: "Kvar", format: "int", privacy: "plain" },
      { key: "perMonth", label: "Per månad", format: "kr", privacy: "plain" },
      { key: "rest", label: "Resten av avtalet", format: "kr", privacy: "plain" },
      { key: "projected", label: "Framskriven total", format: "kr", privacy: "plain" },
    ],
    rows,
    prompts: ["Visa kostnad per år", "Jämför fordonen", "Vilka reparationer återkommer inom 12 månader?"],
  };
}

// --- D. Data quality and what the files cannot answer -------------------------------------------------

export const ARTICLE_EXPORT =
  "en export på artikelnivå från Scania: en rad per utbytt del med artikelnummer (reservdelsnummer), benämning, antal och kostnad, och med arbetsorder, reparationsdatum och fordon så att den kan kopplas till kostnadsraderna";

export function qualityAnalysis(ds: Dataset): Computed {
  const rows: TableRow[] = ds.files.map((f, i) => {
    const tx = f.transactions;
    const dates = tx.map((t) => t.repairDate).filter((d): d is string => !!d).sort();
    const vehicles = [...new Set(tx.map((t) => t.regnr))];
    const decreases = vehicles.reduce((n, v) => n + odometerSeries(tx, v).decreases, 0);
    return {
      cells: {
        file: f.fileName,
        rows: tx.length,
        orders: new Set(tx.map((t) => `${t.regnr}|${t.order ?? `${t.file}:${t.row}`}`)).size,
        period: dates.length ? `${dates[0]} – ${dates.at(-1)}` : null,
        total: round(sumOf(tx)),
        sumRow: f.sumRow ? (f.sumRow.matches ? `Stämmer (rad ${f.sumRow.row})` : `Stämmer inte (rad ${f.sumRow.row})`) : "Ingen",
        negative: tx.filter((t) => t.costs.total < 0).length,
        decreases,
        notes: f.warnings.length ? f.warnings.join(" ") : null,
      },
      refs: f.sumRow ? [{ file: i + 1, fileName: f.fileName, sheet: f.sheet, rows: [f.sumRow.row] }] : [],
    };
  });
  return {
    title: "Datakvalitet i filerna",
    lines: [
      `${ds.files.length} ${ds.files.length === 1 ? "fil" : "filer"} med ${ds.transactions.length} transaktionsrader för ${ds.vehicles.length} fordon. Varje fils summarad kontrolleras mot raderna och räknas aldrig som en transaktion.`,
      "Filerna saknar artikelnummer: de visar kostnad per arbetsorder och huvud- och undergrupp, inte vilka delar som har bytts.",
      "Negativa totalkostnader är krediteringar och ingår i summorna. Minskande mätarställning gör att kilometer inte används för det fordonet.",
    ],
    columns: [
      { key: "file", label: "Fil", format: "text", privacy: "file" },
      { key: "rows", label: "Rader", format: "int", privacy: "plain" },
      { key: "orders", label: "Arbetsordrar", format: "int", privacy: "plain" },
      { key: "period", label: "Reparationer", format: "text", privacy: "plain" },
      { key: "total", label: "Summa", format: "kr", privacy: "plain" },
      { key: "sumRow", label: "Summarad", format: "text", privacy: "plain" },
      { key: "negative", label: "Negativa", format: "int", privacy: "plain" },
      { key: "decreases", label: "Minskande mätarställning", format: "int", privacy: "plain" },
      { key: "notes", label: "Anmärkningar", format: "text", privacy: "plain" },
    ],
    rows,
    prompts: ["Vilka reparationer återkommer inom 12 månader?", "Jämför fordonen"],
  };
}

/** "Vilka reservdelar har bytts flera gånger?" – not answerable from these files; says why and what would be needed. */
export function partsAnalysis(ds: Dataset): Computed {
  const pairs = repeatPairs(ds, { windowMonths: 24, sameWorkshop: false, includeMaintenance: false, vehicle: null, group: null });
  return {
    title: "Utbytta reservdelar går inte att avgöra",
    lines: [
      "Filerna innehåller inga artikelnummer eller reservdelsrader – bara kostnad per arbetsorder och huvud- och undergrupp. Därför går det inte att säga vilka reservdelar som har bytts eller hur många gånger.",
      `Som grov indikation finns ${pairs.length} fall där samma fordon har en ny arbetsorder i samma huvud- och undergrupp inom 24 månader (planerat underhåll borträknat). Det kan vara samma del, en annan del i samma grupp eller ett annat fel.`,
      `För att svara på frågan behövs ${ARTICLE_EXPORT}.`,
    ],
    columns: [],
    rows: [],
    prompts: ["Visa återkommande reparationer inom 24 månader", "Visa datakvaliteten i filerna"],
  };
}

export function runAnalysis(ds: Dataset, q: TableQuery): Computed {
  switch (q.analysis) {
    case "repeats":
      return repeatsAnalysis(ds, q);
    case "costs":
      return costsAnalysis(ds, q);
    case "forecast":
      return forecastAnalysis(ds, q);
    case "quality":
      return qualityAnalysis(ds);
    case "parts":
      return partsAnalysis(ds);
  }
}
