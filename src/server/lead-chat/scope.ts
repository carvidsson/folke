import "server-only";

import type { LeadChatContext, LeadChatState, LeadIntent } from "@/lib/leads/chat";
import { resolvePeriod } from "@/lib/leads/periods";

import { parseQuestion, type ExampleRequest, type ParsedQuestion } from "./intent";
import { NAME_WORDS } from "./pseudonyms";

/**
 * Which selection a question is about (ADR-050): region, inbox, seller and period – resolved
 * deterministically against what the user may see, and inherited from the previous turn when the
 * question does not say. Everything here is pure; the entities come from the user's own client (RLS),
 * so a name the user may not see is simply not found, and the answer never reveals that it exists.
 */

export interface LeadEntities {
  /** Regions with at least one inbox the user may see. */
  regions: { id: string; name: string }[];
  /** Active inboxes the user may see. */
  inboxes: { id: string; name: string; regionId: string | null; facility: string | null; brand: string | null }[];
  /** Sellers who own or first answered a lead the user may see, and the inboxes of those leads. */
  sellers: { id: string; name: string; inboxIds: string[] }[];
  /** Every seller name in Folke (lead_sellers): only used to mask names the user types, never to match or answer. */
  knownNames?: string[];
}

export type TurnResolution =
  | {
      kind: "answer";
      state: LeadChatState;
      intents: LeadIntent[];
      examples: ExampleRequest | null;
      /** The question named its own selection (or widened it) – for the basis text. */
      changedScope: boolean;
      /** The selection before a widening ("resten", "övriga", "totalt"), so the brief can say what changed. */
      widenedFrom: LeadChatState | null;
    }
  | { kind: "clarify"; text: string; state: LeadChatState | null }
  | { kind: "not_found"; text: string; state: LeadChatState | null }
  | { kind: "out_of_scope"; topic: string; state: LeadChatState | null };

/** Lowercase without diacritics (Škoda → skoda, Ängelholm → angelholm), words only. */
export function fold(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The few spellings inbox names use for the same thing. */
const SYNONYMS: Record<string, string | null> = {
  vw: "volkswagen",
  pb: null,
  personbil: null,
  personbilar: null,
  trp: "transport",
  transportbil: "transport",
  transportbilar: "transport",
  transportbilarna: "transport",
  beg: "begagnat",
  begbil: "begagnat",
  begagnade: "begagnat",
  begagnad: "begagnat",
  och: null,
};

function tokens(text: string): string[] {
  return fold(text)
    .split(" ")
    .filter(Boolean)
    .flatMap((t) => {
      const s = t in SYNONYMS ? SYNONYMS[t] : t;
      return s ? [s] : [];
    });
}

/** A question token matches a name token exactly or in genitive ("mias", "alingsås"). */
function has(question: Set<string>, token: string) {
  return question.has(token) || question.has(`${token}s`);
}

type Match<T> = { found: T[]; mentioned: boolean };

function matchRegions(q: Set<string>, entities: LeadEntities): Match<LeadEntities["regions"][number]> {
  const found = entities.regions.filter((r) => tokens(r.name).every((t) => has(q, t)));
  return { found, mentioned: found.length > 0 };
}

/**
 * Inboxes: a facility word and the rest of the name ("vw i alingsås", "skoda karlshamn"), or a name
 * part that only one visible inbox has. Facilities alone are returned separately.
 */
function matchInboxes(q: Set<string>, entities: LeadEntities, within: string[] | null) {
  const pool = within ? entities.inboxes.filter((i) => within.includes(i.id)) : entities.inboxes;
  const facilities = [...new Set(entities.inboxes.map((i) => i.facility).filter((f): f is string => !!f))];
  const facility = facilities.filter((f) => tokens(f).every((t) => has(q, t)));
  const scored = pool
    .map((i) => {
      const own = new Set(tokens(i.facility ?? ""));
      const rest = tokens(i.name).filter((t) => !own.has(t));
      const hits = rest.filter((t) => has(q, t)).length;
      return { inbox: i, hits, missing: rest.length - hits, facilityHit: !!i.facility && facility.includes(i.facility) };
    })
    .filter((s) => s.hits > 0 && (s.facilityHit || facility.length === 0));
  // Most matched name parts, then fewest unmatched, wins ("vw" → Volkswagen PB, "vw trp" → VW TRP).
  const hits = Math.max(...scored.map((s) => s.hits));
  const missing = Math.min(...scored.filter((s) => s.hits === hits).map((s) => s.missing));
  const found = scored.filter((s) => s.hits === hits && s.missing === missing).map((s) => s.inbox);
  return { found, facility };
}

function matchSellers(q: Set<string>, entities: LeadEntities, text: string) {
  const firstCount = new Map<string, number>();
  for (const s of entities.sellers) {
    const first = tokens(s.name)[0];
    if (first) firstCount.set(first, (firstCount.get(first) ?? 0) + 1);
  }
  const full = entities.sellers.filter((s) => {
    const t = tokens(s.name);
    return t.length > 1 && t.every((x) => has(q, x));
  });
  if (full.length) return full;
  // A first name alone; two sellers with it means asking which one.
  return entities.sellers.filter((s) => {
    const first = tokens(s.name)[0];
    if (!first || first.length < 3 || !has(q, first)) return false;
    // "per telefon" is not Per: a first name that is also a word must be written as a name.
    return !NAME_WORDS.has(first) || new RegExp(`(?<!\\p{L})${first.charAt(0).toUpperCase()}${first.slice(1)}s?(?!\\p{L})`, "u").test(text);
  });
}

/** Words after "för" or "hos" that are not names. */
const NOT_NAMES = new Set(
  "oss er dem mig dig honom henne sig teamet säljarna säljare säljaren gruppen regionen inkorgen inkorgarna alla resten övriga perioden månaden veckan året kunderna kunden leads leadsen dem detta det den denna vår våra mitt min er era hubspot folke leadanalys blocket wayke bytbil bilweb tradera hemsidan dms säljsystemet telefon januari februari mars april maj juni juli augusti september oktober november december".split(" ").map(fold),
);

/**
 * "för Lisa", "hos Lisa", "i Karlstad": the question points at a name. Used only when nothing visible
 * matched, to say so instead of answering about something else.
 */
function namedTarget(text: string): boolean {
  const q = text.replace(/\s+/g, " ").trim();
  const after = [...q.toLowerCase().matchAll(/(?<!\p{L})(?:för|hos) (\p{L}{3,})(?=[?.!,]|$| egentligen| just nu| i \p{L}| senaste| den)/gu)];
  if (after.some((m) => !NOT_NAMES.has(fold(m[1])))) return true;
  return [...q.matchAll(/(?<!\p{L})(?:i|på|hos|för) (\p{Lu}\p{L}{2,})/gu)].some((m) => !NOT_NAMES.has(fold(m[1])));
}

function regionOf(entities: LeadEntities, inboxId: string) {
  return entities.inboxes.find((i) => i.id === inboxId)?.regionId ?? null;
}

function label(list: string[]) {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} eller ${list[list.length - 1]}`;
}

/**
 * Resolves a turn. `previous` is the conversation's remembered selection (re-validated against
 * `entities` here, so a selection the user can no longer see is dropped), `context` the page's
 * selection on the first turn ("Fråga Folke" in Leadanalys).
 */
export function resolveTurn(input: {
  text: string;
  today: string;
  entities: LeadEntities;
  previous: LeadChatState | null;
  context: LeadChatContext | null;
}): TurnResolution {
  const { text, today, entities } = input;
  const parsed: ParsedQuestion = parseQuestion(text, today);
  const base = validState(input.previous, entities) ?? fromContext(input.context, entities, today);

  if (parsed.outOfScope) return { kind: "out_of_scope", topic: parsed.outOfScope, state: base };

  const q = new Set(tokens(text));
  let regionId = base?.regionId ?? null;
  let inboxId = base?.inboxId ?? null;
  let sellerId = base?.sellerId ?? null;
  let changedScope = false;

  // Sellers first: a seller's name may contain a facility word, never the other way round.
  const sellers = matchSellers(q, entities, text);
  if (sellers.length > 1) {
    return { kind: "clarify", state: base, text: `Jag hittar flera säljare som passar: ${label(sellers.map((s) => s.name))}. Vilken menar du?` };
  }

  const regions = matchRegions(q, entities);
  const inboxMatch = matchInboxes(q, entities, null);

  if (inboxMatch.found.length === 1) {
    inboxId = inboxMatch.found[0].id;
    regionId = inboxMatch.found[0].regionId;
    sellerId = sellers[0]?.id ?? null;
    changedScope = true;
  } else if (inboxMatch.found.length > 1) {
    // "vw" with a remembered region: the region's own inboxes decide.
    const inRegion = regionId ? inboxMatch.found.filter((i) => i.regionId === regionId) : [];
    if (inRegion.length === 1 && !inboxMatch.facility.length) {
      inboxId = inRegion[0].id;
      sellerId = sellers[0]?.id ?? null;
      changedScope = true;
    } else {
      return { kind: "clarify", state: base, text: `Vilken inkorg menar du: ${label(inboxMatch.found.map((i) => i.name))}?` };
    }
  } else if (regions.found.length === 1) {
    regionId = regions.found[0].id;
    inboxId = null;
    sellerId = sellers[0]?.id ?? null;
    changedScope = true;
  } else if (inboxMatch.facility.length) {
    // A facility with several inboxes that is not itself a region ("Karlshamn").
    const members = entities.inboxes.filter((i) => i.facility && inboxMatch.facility.includes(i.facility));
    return { kind: "clarify", state: base, text: `Vilken inkorg i ${label(inboxMatch.facility)} menar du: ${label(members.map((i) => i.name))}? Jag kan också svara för hela regionen.` };
  }

  if (sellers.length === 1) {
    sellerId = sellers[0].id;
    changedScope = true;
    // Only the seller was named: keep the selection if the seller has leads in it, otherwise use the
    // seller's own inbox (or region) – deterministic, from the leads the user may see.
    if (!inboxMatch.found.length && !regions.found.length) {
      const own = sellers[0].inboxIds;
      const inScope = own.some((id) => (inboxId ? id === inboxId : regionId ? regionOf(entities, id) === regionId : false));
      if (!inScope) {
        const ownRegions = [...new Set(own.map((id) => regionOf(entities, id)))];
        inboxId = own.length === 1 ? own[0] : null;
        regionId = own.length === 1 ? regionOf(entities, own[0]) : ownRegions.length === 1 ? ownRegions[0] : null;
      }
    }
  }

  const before = { regionId, inboxId, sellerId };
  let widened = false;
  if (parsed.all) {
    widened = !!(regionId || inboxId || sellerId);
    regionId = null;
    inboxId = null;
    sellerId = null;
    changedScope = true;
  } else if (parsed.widen && !changedScope) {
    // One step out: seller → their inbox or region, inbox → region, region → everything.
    if (sellerId) sellerId = null;
    else if (inboxId) {
      regionId = regionOf(entities, inboxId);
      inboxId = null;
    } else if (regionId) regionId = null;
    changedScope = true;
    widened = true;
  }

  // A name the question points at but nothing visible matched: say so, without revealing anything.
  if (!changedScope && !parsed.widen && !parsed.all) {
    if (namedTarget(text)) {
      return {
        kind: "not_found",
        state: base,
        text: "Jag hittar ingen säljare, inkorg eller region med det namnet bland de leads du har tillgång till. Ange gärna namnet som det står i Leadanalys.",
      };
    }
  }

  // Intents: the question's own, else the previous turn's (follow-up), else the overview.
  let intents: LeadIntent[] = parsed.intents.length ? parsed.intents : (base?.intents.length ? base.intents : ["overview"]);
  // A pure "why" builds on what the previous turn was about. "Visa exempel" loads only examples –
  // of slow replies when the previous turn was about response times – never the previous modules again.
  if (parsed.intents.length && parsed.intents.every((i) => i === "explain" || i === "examples") && base?.intents.length) {
    intents = parsed.intents.includes("examples")
      ? [...new Set([...(base.intents.includes("response_time") ? (["response_time"] as const) : []), ...parsed.intents])]
      : [...new Set([...base.intents.filter((i) => i !== "examples" && i !== "explain"), ...parsed.intents])];
  }
  // "Är det samma för resten?" repeats the previous question for the wider selection. After examples
  // or patterns it also needs the counts for the wider selection – examples alone cannot answer it.
  if (parsed.widen && !parsed.intents.length && base?.intents.length) {
    intents = base.intents.some((i) => i === "examples" || i === "patterns") ? [...new Set([...base.intents, "patterns" as const])] : base.intents;
  }

  const period = parsed.period
    ? resolvePeriod(parsed.period.preset, today, parsed.period.from, parsed.period.to)
    : resolvePeriod(base?.preset, today, base?.from, base?.to);
  const comparison = intents.includes("comparison") || (!parsed.intents.length && !!base?.comparison);
  const examples = parsed.examples ?? (intents.includes("examples") ? { polarity: "both" as const, count: 3 } : null);

  return {
    kind: "answer",
    changedScope,
    widenedFrom: widened && base ? { ...base, ...before } : null,
    intents,
    examples,
    state: {
      regionId,
      inboxId,
      sellerId,
      preset: period.preset,
      from: period.from,
      to: period.to,
      intents,
      comparison,
      focus: parsed.sameKind || (!parsed.intents.length && base) ? (base?.focus ?? []) : [],
    },
  };
}

/** The remembered selection, kept only as far as the user can still see it. */
export function validState(state: LeadChatState | null, entities: LeadEntities): LeadChatState | null {
  if (!state) return null;
  const inbox = state.inboxId ? entities.inboxes.find((i) => i.id === state.inboxId) : null;
  const regionOk = !state.regionId || entities.regions.some((r) => r.id === state.regionId);
  const sellerOk = !state.sellerId || entities.sellers.some((s) => s.id === state.sellerId);
  return {
    ...state,
    inboxId: inbox ? inbox.id : null,
    regionId: inbox ? inbox.regionId : regionOk ? state.regionId : null,
    sellerId: sellerOk ? state.sellerId : null,
  };
}

/** The page's selection: help only – validated against what the user may see, like everything else. */
function fromContext(context: LeadChatContext | null, entities: LeadEntities, today: string): LeadChatState | null {
  if (!context) return null;
  const period = resolvePeriod(context.preset, today, context.from, context.to);
  return validState(
    {
      regionId: context.regionId ?? null,
      inboxId: context.inboxId ?? null,
      sellerId: context.sellerId ?? null,
      preset: period.preset,
      from: period.from,
      to: period.to,
      intents: [],
      comparison: false,
      focus: [],
    },
    entities,
  );
}
