import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { cn } from "@/lib/utils";
import {
  SMALL_SAMPLE_RELEVANT,
  type ArrivalWindow,
  type Behaviour,
  type BehaviourStatus,
  type Intent,
  type NotAnalysedReason,
  type Progress,
  type PurchaseIntent,
  type ResponseStatus,
} from "@/lib/leads/types";

/** Shared pieces of the lead analysis pages (ADR-048). Swedish labels, no colour-only signals. */

export const number = new Intl.NumberFormat("sv-SE");
export const percent = new Intl.NumberFormat("sv-SE", {
  style: "percent",
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat("sv-SE", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Stockholm",
});
const timeOnly = new Intl.DateTimeFormat("sv-SE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Stockholm",
});

export function formatDateTime(iso: string) {
  return dateTime.format(new Date(iso));
}

/** "i dag 07:45", "3 okt. 07:45" */
export function formatFreshness(iso: string, now = new Date()) {
  const d = new Date(iso);
  const sameDay =
    d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }) ===
    now.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  return sameDay ? `i dag ${timeOnly.format(d)}` : dateTime.format(d);
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "–";
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  if (m < 24 * 60)
    return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
  const days = Math.floor(m / 1440);
  const hours = Math.round((m % 1440) / 60);
  return `${days} d${hours ? ` ${hours} h` : ""}`;
}

/** "72 av 84 (86 %)" – the population is always visible. */
export function ofTotal(
  part: number,
  total: number,
  { percentage = true }: { percentage?: boolean } = {},
) {
  const base = `${number.format(part)} av ${number.format(total)}`;
  return percentage && total > 0
    ? `${base} (${percent.format(part / total)})`
    : base;
}

export const MODEL_LABELS: Record<string, string> = {
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

export const WINDOW_LABELS: Record<ArrivalWindow, string> = {
  business_hours: "Under kontorstid",
  weekday_off_hours: "Vardag utanför kontorstid",
  weekend: "Helg",
};

export const STATUS: Record<ResponseStatus, [string, StatusTone]> = {
  registered_reply: ["Registrerat säljsvar", "success"],
  no_registered_reply: ["Inget registrerat säljsvar", "warning"],
  uncertain: ["Osäkert", "neutral"],
};

export const BEHAVIOUR_TEXT: Record<
  Behaviour,
  { label: string; relevant: string }
> = {
  answered_questions: {
    label: "Besvarade kundens konkreta frågor",
    relevant:
      "Relevant när kunden ställde en konkret fråga och säljaren skrev efter den. Svar i en skickad offert räknas, liksom att be om det underlag svaret kräver.",
  },
  next_step: {
    label: "Lämnade ett konkret nästa steg",
    relevant:
      "Bedöms på säljarens senaste meddelanden när ärendet är öppet: en tid, en offert eller kalkyl, eller en fråga om det som behövs för att gå vidare.",
  },
  needs_questions: {
    label: "Frågade efter det som behövs för ett rätt erbjudande",
    relevant:
      "Relevant bara när svaret beror på uppgifter säljaren saknar – inte när kunden redan valt bil, angett tid, lagt bud eller vill komma och titta. Den osäkraste bedömningen.",
  },
  visit_or_test_drive: {
    label: "Bjöd in till besök eller provkörning",
    relevant:
      "Relevant när kunden vill se eller provköra, är osäker på modell eller gäller en viss begagnad bil. Inte vid pris- och villkorsfrågor om en vald bil.",
  },
  follow_up: {
    label: "Följde upp när kunden inte svarade",
    relevant:
      "Relevant när kunden inte har svarat på minst 3 dygn efter en fråga, offert eller ett förslag. Tiden och om säljaren skrev igen räknas ut ur HubSpot.",
  },
};

export const INTENT_LABELS: Record<Intent, string> = {
  price_or_offer: "Pris eller erbjudande",
  financing_or_leasing: "Finansiering eller leasing",
  trade_in: "Inbyte",
  availability: "Om bilen finns kvar",
  test_drive_or_visit: "Provkörning eller besök",
  equipment_or_facts: "Utrustning eller fakta",
  delivery: "Leverans",
  other: "Annat",
  unclear: "Oklart",
};

export const PURCHASE_INTENT_LABELS: Record<PurchaseIntent, string> = {
  clear: "Tydlig köpintention",
  interested: "Intresserad av en viss bil",
  information_only: "Bara information",
  unclear: "Går inte att avgöra",
};

export const PROGRESS_LABELS: Record<Progress, string> = {
  moved_forward: "Fördes mot ett konkret nästa steg",
  partly: "Delvis – en tydlig möjlighet lämnades",
  stalled: "Stannade på säljarens sida",
  closed_by_customer: "Kunden avslutade",
  unclear: "Går inte att avgöra från HubSpot",
};

export const NOT_ANALYSED: Record<NotAnalysedReason, string> = {
  no_registered_reply: "utan registrerat säljsvar i HubSpot",
  redaction_check: "stoppade av avidentifieringskontrollen",
  failed: "kunde inte analyseras",
  limit: "över gränsen per körning",
  time_limit: "hann inte analyseras – kör igen för att fortsätta",
  no_stored_analysis:
    "utan sparad AI-analys (inkorgen är inte analyserad för perioden)",
};

export type Origin = "fact" | "stored" | "classification" | "ai";

const ORIGIN: Record<Origin, [string, StatusTone]> = {
  fact: ["Beräknat ur HubSpot", "info"],
  stored: ["Sparat i Folke", "info"],
  classification: ["AI-klassificering", "brand"],
  ai: ["AI:s sammanvägda bedömning", "brand"],
};

export function OriginBadge({ origin }: { origin: Origin }) {
  return (
    <StatusBadge tone={ORIGIN[origin][1]}>{ORIGIN[origin][0]}</StatusBadge>
  );
}

export function Section({
  title,
  origin,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  origin?: Origin | Origin[];
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  const origins = origin ? (Array.isArray(origin) ? origin : [origin]) : [];
  return (
    <section className="mt-10 scroll-mt-16" id={id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-heading">{title}</h2>
            {origins.map((o) => (
              <OriginBadge key={o} origin={o} />
            ))}
          </div>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Horizontal bars for small counts – a reading aid, not a dashboard. */
export function Bars({
  items,
  total,
}: {
  items: { label: string; count: number }[];
  total: number;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.label}
          className="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)_6.5rem] items-center gap-3 text-sm"
        >
          <span className="leading-snug">{item.label}</span>
          <span
            className="h-2 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            <span
              className="block h-full rounded-full bg-navy-300"
              style={{ width: `${total ? (item.count / total) * 100 : 0}%` }}
            />
          </span>
          <span className="text-right text-muted-foreground tabular-nums">
            {ofTotal(item.count, total)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

/** Weekday × time of day. Shade and number together; business hours outlined. */
export function LoadGrid({
  grid,
  bands,
}: {
  grid: number[][];
  bands: string[];
}) {
  const max = Math.max(1, ...grid.flat());
  const business = (day: number, band: string) =>
    day < 5 && ["09–12", "12–15", "15–18"].includes(band);
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[30rem] border-separate border-spacing-1 text-xs"
        aria-label="Leads per veckodag och tid på dygnet"
      >
        <thead>
          <tr>
            <th className="w-12" />
            {bands.map((b) => (
              <th
                key={b}
                scope="col"
                className="pb-1 text-center font-normal text-muted-foreground tabular-nums"
              >
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, day) => (
            <tr key={day}>
              <th
                scope="row"
                className="pr-2 text-left font-normal text-muted-foreground"
              >
                {WEEKDAYS[day]}
              </th>
              {row.map((v, i) => (
                <td
                  key={i}
                  className={cn(
                    "h-8 rounded-md text-center tabular-nums",
                    business(day, bands[i]) &&
                      "ring-1 ring-foreground/35 ring-inset",
                    v === 0 && "text-muted-foreground/60",
                  )}
                  style={{
                    backgroundColor: v
                      ? `color-mix(in oklab, var(--color-navy-300) ${Math.round(12 + (v / max) * 60)}%, transparent)`
                      : undefined,
                  }}
                >
                  {v || "·"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Inramade rutor är kontorstid (mån–fre 09–18). Svensk tid.
      </p>
    </div>
  );
}

export function BehaviourRow({
  behaviour,
  counts,
  total,
}: {
  behaviour: Behaviour;
  counts: Record<BehaviourStatus, number>;
  total: number;
}) {
  const relevant = counts.done + counts.missing;
  const text = BEHAVIOUR_TEXT[behaviour];
  return (
    <div className="grid gap-3 px-6 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div>
        <p className="text-sm font-medium">{text.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{text.relevant}</p>
      </div>
      <div className="text-sm">
        <p>
          Relevant i{" "}
          <span className="font-medium">
            {ofTotal(relevant, total, { percentage: false })}
          </span>{" "}
          analyserade dialoger.
          {relevant > 0 && (
            <>
              {" "}
              Gjort i {number.format(counts.done)} och saknades i{" "}
              {number.format(counts.missing)}
              {relevant >= SMALL_SAMPLE_RELEVANT
                ? ` (gjort i ${percent.format(counts.done / relevant)} av de relevanta)`
                : " – för få för en andel"}
              .
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Inte relevant i {number.format(counts.not_relevant)}
          {counts.unclear
            ? ` · går inte att avgöra i ${number.format(counts.unclear)}`
            : ""}
          .
        </p>
        {relevant > 0 && (
          <div
            className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            <span
              className="h-full bg-success"
              style={{ width: `${(counts.done / relevant) * 100}%` }}
            />
            <span
              className="h-full bg-warning"
              style={{ width: `${(counts.missing / relevant) * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** "+12 %", "8 → 11 min" – deterministic change, or why it is missing. */
export function change(
  current: number | null,
  previous: number | null,
  kind: "count" | "minutes" | "share",
  previousShare?: number | null,
): string {
  if (current === null || previous === null) return "–";
  if (kind === "minutes")
    return `${formatMinutes(previous)} → ${formatMinutes(current)}`;
  if (kind === "share")
    return previousShare === null || previousShare === undefined
      ? "–"
      : `${percent.format(previousShare)} → ${percent.format(current)}`;
  if (previous === 0) return current === 0 ? "±0" : "ny";
  const diff = (current - previous) / previous;
  return `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${percent.format(Math.abs(diff))}`;
}
