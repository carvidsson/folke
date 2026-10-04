import "server-only";

/**
 * The figures a lead answer may use (ADR-050). Every number carries its population – what it is
 * counted among – and its origin, so the model never has to guess a denominator and a reviewer can
 * check any number in an answer against the brief. Populations are fixed phrases: a share is only
 * comparable with another share of the same population.
 */

export const POPULATIONS = {
  leads: "leads i urvalet",
  replied: "leads med registrerat säljsvar i urvalet",
  firstResponder: "leads där säljaren gav det första registrerade säljsvaret",
  owner: "leads där säljaren är nuvarande ägare i HubSpot",
  analysed: "AI-analyserade dialoger",
  analysedSeller: "AI-analyserade dialoger där säljaren gav det första registrerade säljsvaret",
} as const;

export type Population = (typeof POPULATIONS)[keyof typeof POPULATIONS];
export type Origin = "fakta" | "klassificering";

export interface Metric {
  id: string;
  label: string;
  value: number | string;
  /** The population size when the value is a count within it ("12 av 40"). */
  of?: number;
  population: Population | string;
  origin: Origin;
  definition?: string;
  /** Another selection than the brief's (an earlier, narrower one), as shown to the user. */
  selection?: string;
  /** Another period than the brief's (the previous period in a comparison). */
  period?: string;
}

export class MetricRegistry {
  private items: Metric[] = [];

  add(m: Omit<Metric, "id">): Metric {
    const metric = { ...m, id: `m${this.items.length + 1}` };
    this.items.push(metric);
    return metric;
  }

  get all(): readonly Metric[] {
    return this.items;
  }

  /** The numbers an answer may quote: values and populations. */
  numbers(): Set<string> {
    const out = new Set<string>();
    for (const m of this.items) {
      for (const v of [m.value, m.of]) if (v !== undefined) for (const n of String(v).match(/\d+(?:[,.]\d+)?/g) ?? []) out.add(n.replace(".", ","));
    }
    return out;
  }
}

/** One line in the brief: "Leads med registrerat säljsvar: 82 av 97 (leads i urvalet)". */
export function renderMetric(m: Metric): string {
  const value = m.of !== undefined ? `${m.value} av ${m.of}` : `${m.value}`;
  return `- ${m.label}: ${value} (population: ${m.population}${m.definition ? `; ${m.definition}` : ""})`;
}

/** Minutes exactly as the Leadanalys page shows them ("35 min", "2 h 5 min", "1 d 3 h"), so figures can be compared. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "saknas";
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
  const days = Math.floor(m / 1440);
  const hours = Math.round((m % 1440) / 60);
  return `${days} d${hours ? ` ${hours} h` : ""}`;
}
