import "server-only";

import type { VerifiedFact } from "@/lib/domain/types";

import type { Metric } from "./metrics";
import type { LeadEntities } from "./scope";

/**
 * Verified facts in a lead conversation (ADR-050). A figure the server computed and an answer used is
 * stored with that answer (on its basis source) and handed back in every later brief, labelled with
 * its own selection and period. A later answer therefore never has to "correct" an earlier figure just
 * because this turn's brief does not contain it; a change is only stated when the current brief has a
 * new server-computed value for the same measure, population, selection and period – and then the
 * brief says so explicitly. Pure, apart from the types.
 */

const MAX_EARLIER = 25;

export function factKey(f: Pick<VerifiedFact, "selection" | "period" | "label" | "population">) {
  return [f.selection, f.period, f.label, f.population].map((x) => x.trim().toLowerCase()).join("|");
}

function numbers(text: string): string[] {
  return (text.match(/\d+(?:[,.]\d+)?/g) ?? []).map((n) => n.replace(".", ","));
}

/** The brief's figures as facts, with names (not aliases) and the selection and period they belong to. */
export function currentFacts(
  metrics: readonly Metric[],
  context: { selection: string; period: string; scope: VerifiedFact["scope"] },
  reveal: (text: string) => string,
): VerifiedFact[] {
  return metrics.map((m) => ({
    label: reveal(m.label),
    value: reveal(String(m.value)),
    ...(m.of !== undefined ? { of: m.of } : {}),
    population: reveal(m.population),
    selection: reveal(m.selection ?? context.selection),
    period: m.period ?? context.period,
    scope: context.scope,
  }));
}

/** The facts an answer used: every number of the value (and the population size) appears in it. */
export function usedFacts(facts: VerifiedFact[], answer: string): VerifiedFact[] {
  const inAnswer = new Set(numbers(answer));
  const seen = new Set<string>();
  return facts.filter((f) => {
    const own = [...numbers(f.value), ...(f.of !== undefined ? [String(f.of)] : [])];
    if (!own.length || !own.every((n) => inAnswer.has(n))) return false;
    const key = factKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Earlier facts the user may still see: every id they were computed for must still be visible. */
export function visibleFacts(facts: VerifiedFact[], entities: LeadEntities): VerifiedFact[] {
  return facts.filter(
    (f) =>
      (!f.scope.regionId || entities.regions.some((r) => r.id === f.scope.regionId)) &&
      (!f.scope.inboxId || entities.inboxes.some((i) => i.id === f.scope.inboxId)) &&
      (!f.scope.sellerId || entities.sellers.some((s) => s.id === f.scope.sellerId)),
  );
}

const fmt = (f: Pick<VerifiedFact, "value" | "of">) => (f.of !== undefined ? `${f.value} av ${f.of}` : f.value);

/**
 * The brief section with earlier facts (newest first, at most 25). A fact the current brief computes
 * again with the same value is left out (it is above); with another value it is listed as changed,
 * with both values.
 */
export function earlierFactsSection(earlier: VerifiedFact[], current: VerifiedFact[], hide: (text: string) => string): string | null {
  const now = new Map(current.map((f) => [factKey(f), f]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const f of [...earlier].reverse()) {
    const key = factKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const again = now.get(key);
    const where = hide(`${f.selection} · ${f.period}`);
    if (again && fmt(again) === fmt(f)) continue;
    lines.push(
      again
        ? `- [${where}] ${hide(f.label)}: tidigare ${fmt(f)}, nu ${fmt(again)} enligt underlaget ovan (samma mått, urval och period; underlaget har uppdaterats) (population: ${hide(f.population)})`
        : `- [${where}] ${hide(f.label)}: ${fmt(f)} (population: ${hide(f.population)})`,
    );
    if (lines.length >= MAX_EARLIER) break;
  }
  if (!lines.length) return null;
  return [
    "## Tidigare verifierade fakta i konversationen",
    "Servern beräknade de här siffrorna i tidigare svar. De gäller sitt eget urval och sin period och är fortfarande verifierade, även om de inte finns i underlaget ovan. Rätta, ersätt eller omtolka dem aldrig. Säg bara att ett värde har förändrats när det här står uttryckligen \"tidigare … nu …\".",
    ...lines,
  ].join("\n");
}
