"use client";

import { MessageSquareText } from "lucide-react";

import { Panel } from "@/components/common/panel";
import { Button } from "@/components/ui/button";
import { CARRIED_GROUP_LABELS, NEED_LABELS, REQUEST_LABELS, SIGNAL_LABELS, UNAVAILABLE_LABELS, type NeedsOverview } from "@/lib/leads/needs";

import { BarList } from "./charts";
import type { EvidenceRequest } from "./evidence-sheet";
import { number, ofTotal, Section } from "./parts";

/** Below this many purchase dialogues the shares are marked as a small sample. */
const SMALL = 20;

const DESCRIPTION =
  "Vad kunden själv skriver eller fyller i – inte vad säljaren tar upp. Flera behov per dialog. Att något inte nämns betyder inte att kunden inte vill det. Andelarna räknas bland köpdialoger med behovsanalys.";

/**
 * "Vad kunderna frågar efter" (ADR-052): a sparse summary of lead-needs-1 – the most common needs, the
 * combinations that pass their thresholds and what happened when the car could not be had. Every count
 * opens the leads behind it; depth is in the chat.
 */
export function CustomerNeeds({
  needs,
  onEvidence,
  onAsk,
}: {
  needs: NeedsOverview | null;
  onEvidence: (r: EvidenceRequest) => void;
  onAsk: ((question: string) => void) | null;
}) {
  if (!needs || needs.candidates === 0) return <span id="kundbehov" />;
  const total = needs.purchase;
  const open = (title: string, description: string, filter: string) =>
    onEvidence({ title, description, origin: "classification", filter });
  const coverage = `Behovsanalys finns för ${ofTotal(needs.analysed, needs.candidates, { percentage: false })} leads med meddelande från kunden. ${number.format(total)} av dem gäller köp eller leasing av bil och är underlaget för andelarna (${needs.version}).`;

  return (
    <Section
      id="kundbehov"
      title="Vad kunderna frågar efter"
      origin="classification"
      description={DESCRIPTION}
      actions={
        onAsk && total > 0 ? (
          <Button variant="outline" size="sm" className="h-9" onClick={() => onAsk("Vad frågar kunderna mest om, och vad kombineras oftast?")}>
            <MessageSquareText className="size-4" />
            Fråga Folke
          </Button>
        ) : null
      }
    >
      {needs.analysed === 0 ? (
        <Panel className="px-6 py-5 text-sm text-muted-foreground">
          Kundbehoven är inte analyserade för urvalet och perioden. De analyseras tillsammans med dialogerna under AI-analys, en inkorg i taget.
        </Panel>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {coverage}
            {total > 0 && total < SMALL ? " Litet underlag: enstaka dialoger kan ändra bilden mycket." : ""}
          </p>
          <Panel className="px-6 py-5">
            <h3 className="text-overline mb-3">Kundens uttryckta behov</h3>
            {needs.needs.length ? (
              <BarList
                label="Kundens uttryckta behov"
                max={total}
                items={needs.needs.map((n) => ({
                  key: n.code,
                  label: NEED_LABELS[n.code],
                  value: n.count,
                  valueLabel: ofTotal(n.count, total),
                  onSelect: () => open(NEED_LABELS[n.code], `Köpdialoger där kunden själv tar upp: ${NEED_LABELS[n.code].toLowerCase()}.`, `need:${n.code}`),
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Inga uttryckta behov i de analyserade köpdialogerna.</p>
            )}
            {(needs.requests.length > 0 || needs.strong > 0 || needs.soon > 0) && (
              <div className="mt-5 grid gap-4 border-t pt-4 text-sm sm:grid-cols-2">
                {needs.requests.length > 0 && (
                  <div>
                    <h4 className="text-overline mb-2">Det kunden ber om</h4>
                    <ul className="flex flex-col gap-1.5">
                      {needs.requests.slice(0, 4).map((r) => (
                        <li key={r.code} className="flex items-baseline justify-between gap-3">
                          <button
                            type="button"
                            className="text-left underline-offset-4 hover:underline"
                            onClick={() => open(REQUEST_LABELS[r.code], "Köpdialoger där kunden uttryckligen ber om det här.", `request:${r.code}`)}
                          >
                            {REQUEST_LABELS[r.code]}
                          </button>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{ofTotal(r.count, total, { percentage: false })}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <h4 className="text-overline mb-2">Köpsignaler</h4>
                  <ul className="flex flex-col gap-1.5">
                    <li className="flex items-baseline justify-between gap-3">
                      <button
                        type="button"
                        className="text-left underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60"
                        disabled={!needs.strong}
                        onClick={() => open("Tydliga köpsignaler", "Kunden säger att hen vill köpa eller reservera bilen, lägger ett bud eller frågar hur man går vidare.", "strong_signal")}
                      >
                        Tydlig köpsignal
                      </button>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{ofTotal(needs.strong, total, { percentage: false })}</span>
                    </li>
                    <li className="flex items-baseline justify-between gap-3">
                      <button
                        type="button"
                        className="text-left underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60"
                        disabled={!needs.soon}
                        onClick={() => open("Vill köpa inom kort", "Kunden säger att hen vill köpa eller behöver bilen inom ungefär en månad.", "soon")}
                      >
                        Vill köpa inom kort
                      </button>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{ofTotal(needs.soon, total, { percentage: false })}</span>
                    </li>
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {needs.signals.length ? `Vanligast: ${needs.signals.slice(0, 2).map((s) => `${SIGNAL_LABELS[s.code].toLowerCase()} (${number.format(s.count)})`).join(", ")}. ` : ""}
                    Bara det kunden skriver uttryckligen – inga poäng.
                  </p>
                </div>
              </div>
            )}
          </Panel>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Panel className="px-6 py-5">
              <h3 className="text-overline mb-3">Vanliga kombinationer</h3>
              {needs.combinations.length ? (
                <ul className="flex flex-col gap-2 text-sm">
                  {needs.combinations.map((c) => (
                    <li key={`${c.a}+${c.b}`} className="flex items-baseline justify-between gap-3">
                      <button
                        type="button"
                        className="text-left underline-offset-4 hover:underline"
                        onClick={() => open(`${NEED_LABELS[c.a]} och ${NEED_LABELS[c.b].toLowerCase()}`, "Köpdialoger där kunden tar upp båda.", `combo:${c.a}+${c.b}`)}
                      >
                        {NEED_LABELS[c.a]} + {NEED_LABELS[c.b].toLowerCase()}
                      </button>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{ofTotal(c.count, total, { percentage: false })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Ingen kombination har tillräckligt underlag i urvalet (minst 30 köpdialoger och minst 8 dialoger per kombination).</p>
              )}
            </Panel>

            <Panel className="px-6 py-5">
              <h3 className="text-overline mb-3">När bilen inte gick att få</h3>
              {needs.unavailable.total ? (
                <>
                  <p className="text-sm">
                    I{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-4"
                      onClick={() => open("Bilen gick inte att få", "Köpdialoger där bilen kunden frågade om var såld, reserverad, inte fanns att få, eller där pris eller leveranstid inte passade.", "unavailable")}
                    >
                      {ofTotal(needs.unavailable.total, total, { percentage: false })}
                    </button>{" "}
                    köpdialoger gick bilen inte att få ({needs.unavailable.situations.map((s) => `${UNAVAILABLE_LABELS[s.code].toLowerCase()} ${number.format(s.count)}`).join(", ")}).
                  </p>
                  <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                    {needs.unavailable.carried.map((c) => (
                      <li key={c.group} className="flex items-baseline justify-between gap-3">
                        <button
                          type="button"
                          className="text-left underline-offset-4 hover:underline"
                          onClick={() => open(CARRIED_GROUP_LABELS[c.group], "När bilen inte gick att få: vad som syns i HubSpot om kundens behov därefter.", `carried:${c.group}`)}
                        >
                          {CARRIED_GROUP_LABELS[c.group]}
                        </button>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{ofTotal(c.count, needs.unavailable.total, { percentage: false })}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">
                    &quot;Fördes synligt vidare&quot; betyder ett alternativ, en annan lösning, ett nästa steg eller frågor om behovet i säljarens meddelanden. Samtal och offerter från säljsystemet syns inte – det är ingen bedömning av säljaren.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Inga analyserade köpdialoger där bilen inte gick att få.</p>
              )}
            </Panel>
          </div>
        </>
      )}
    </Section>
  );
}
