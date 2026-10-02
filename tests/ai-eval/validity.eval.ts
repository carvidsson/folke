import { writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SourceReference } from "@/lib/domain/types";
import { verifyCitations } from "@/server/ai/citations";
import { assertExternalAllowed } from "@/server/ai/guard";
import { embeddingModel, resolveChatModel } from "@/server/ai/models";
import { chatCostUsd } from "@/server/ai/pricing";
import { buildSystemPrompt, limitHistory, stockholmDate } from "@/server/ai/prompt";
import { createEmbeddings, openAIProvider } from "@/server/ai/providers/openai";
import type { ContextChunk, UsageReport } from "@/server/ai/types";
import { retrieveContext, type RetrievalStats } from "@/server/chat/retrieval";
import { citedSources, filterHistory, type HistoryRow } from "@/server/chat/turn";

import {
  assistantId,
  cleanup,
  createDocument,
  createGroup,
  createUser,
  isDevelopmentProject,
  service,
  type LiveUser,
} from "../live/helpers";

/**
 * Realistic validity regression (ADR-044) with the REAL pipeline and REAL
 * OpenAI calls on synthetic documents in the DEVELOPMENT project:
 *
 *   node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.eval.config.mts tests/ai-eval/validity.eval.ts
 *
 * Mirrors the structure of real campaign material without its content:
 * - brand overview valid for the current quarter (stated once, on page 1)
 * - "Översikt privatleasing … Q4 2026" pages WITHOUT explicit dates
 * - a two-page cheat sheet ("lathund") labelled with the current quarter but
 *   with a leftover older period, flattened tables and campaign codes "… Q4"
 * - the same prices in both places, a large broad context
 * - a campaign whose own explicit period has passed (must stay expired)
 * - a model without any leasing price (must be marked as missing)
 *
 * Two conversations per run: a clean one, and one whose history already
 * contains the wrong verdict ("the cheat-sheet prices are not current"),
 * each with a broad comparison followed by a narrow recommendation. The
 * same offers must get the same verdict in both answers.
 *
 * Checks marked strict must pass in every run; the rest in RUNS - 1.
 */

const RUNS = Number(process.env.FOLKE_EVAL_RUNS ?? 3);
const TODAY = stockholmDate();
const [Y, M] = TODAY.split("-").map(Number);
const Q = Math.floor((M - 1) / 3) + 1;
const QUARTER = `Q${Q}`;
const iso = (d: Date) => stockholmDate(d);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const Q_START = new Date(Date.UTC(Y, (Q - 1) * 3, 1, 12));
const Q_END = new Date(Date.UTC(Y, Q * 3, 0, 12));
const PREV_END = addDays(Q_START, -1);
const PREV_START = new Date(Date.UTC(PREV_END.getUTCFullYear(), PREV_END.getUTCMonth() - 2, 1, 12));
const SHORT = ["jan", "feb", "mars", "april", "maj", "juni", "juli", "aug", "sept", "okt", "nov", "dec"];
const sv = (d: Date) => `${d.getUTCDate()} ${SHORT[d.getUTCMonth()]}`;
const dotted = (d: Date) => iso(d).replace(/-/g, ".");
/** The leftover older period in the cheat sheet, e.g. "23 juni - 30 sept 2026". */
const STALE = `${sv(addDays(PREV_START, 22))} - ${sv(PREV_END)} ${PREV_END.getUTCFullYear()}`;
/** A campaign that really has ended. */
const EXPIRED = `${sv(addDays(Q_START, -120))} - ${sv(addDays(Q_START, -40))} ${addDays(Q_START, -40).getUTCFullYear()}`;

/** Prices that appear both in the cheat sheet and in the current-quarter overviews. */
const CONTESTED = ["4 995", "3 295", "6 495"];
const EXPIRED_PRICE = "3 595";

const lathundHead = (n: string) =>
  `Lathund privatleasing ${QUARTER}${n} Kampanjperiod ${STALE} Alla priser är rekommenderade priser, varje återförsäljare har rätt att sätta sina egna priser. 3000 mil / 36 månader Modell Modellkod Ramavtal privatleasing Ramavtals rabatt Pris i SAMS Sälj bilen för avser grundmodell utan utrustning Månadskostnad ex serviceavtal Serviceavtal Månadskostnad inkl serviceavtal Kampanj i SAMS FM`;
const row = (model: string, code: string, price: string, list: string, net: string, ex: string, service: string, campaign: string) =>
  `${model} ${code} 1-XKLMRH 1% ${list} kr ${net} kr ${ex} kr ${service} kr ${price} kr ${campaign}`;
const PL = `(102700) ÄD Privatleasing ${QUARTER}`;
const LOJ = `(102703) ÄD Lojalitet ${QUARTER}`;
const SKY = `(102702) ÄD PL Sky ${QUARTER}`;

/** Älvdal: long weekly campaign overview, pages split into chunks like PDF extraction. */
const alvdal: string[][] = [
  [`Älvdal kampanjöversikt Gäller ${dotted(Q_START)} – ${dotted(Q_END)} Version 1.0`],
  [`Innehåll Nyheter ${QUARTER} Kampanjpriser Privatkunder Företag Choice Lojalitet Privatleasing Demostöd Inbytesstöd Kombinationsregler Volymbonus Kontaktpersoner`],
  [`${QUARTER} • Nya list- och kampanjpriser • Räntekampanj Choice 0,95% Kvist och Ask • Inbytesstöd utvalda märken • Privatleasing ICE/PHEV och BEV • Lojalitetskampanj för tidigare kunder • Volymbonus för elbilar`],
  [`Nyheter i programmet: Ek får ny infotainment och uppdaterade assistanssystem. Lind finns nu med fler motoralternativ. Sky Tourer introduceras i november. Beställningsbanken öppnar för modellår ${Y + 1} under ${QUARTER}.`],
  [`Leveranstider: Kvist och Ask 6–8 veckor. Ek 8–10 veckor. Lind eHybrid 12–14 veckor vid fabriksorder. Sky levereras från lager och via fabriksorder. Leveranstiderna är prognoser och kan ändras.`],
  [`Kampanjpriser kontant ${QUARTER} Modell Version Listpris Kampanjpris Kundfördel Kvist Life 289 900 kr 269 900 kr 20 000 kr Ask Life 339 900 kr 319 900 kr 20 000 kr Ek Edition 352 000 kr 334 900 kr 17 100 kr Ek Kombi Edition 382 400 kr 362 900 kr 19 500 kr Lind Edition 437 900 kr 414 900 kr 23 000 kr Lind SWE Edition eHybrid 631 700 kr 623 400 kr 8 300 kr`],
  [`Rönn eHybrid Business Limited Edition kampanjpris 535 900 kr. Rönn eHybrid SWE Edition 571 900 kr. Priserna gäller vid beställning under kampanjperioden och leverans senast ${dotted(Q_END)}.`],
  [`Volt Pro Edition kampanjpris 499 900 kr, ordinarie 539 900 kr. Volt GTX 579 900 kr. Volt omfattas av Choice-stöd. Privatleasing för Volt erbjuds via återförsäljarens egna avtal.`],
  [`Sky Pro SWE Edition kampanjpris 595 900 kr. Sky Tourer Pro SWE Edition 605 900 kr. Kundfördel 188 100 kr respektive 186 500 kr. Gäller vid privatleasing och kontantköp.`],
  [`Orderbonus privatkunder Orderbonus Ek R 30 000 kr stöd på Ek R. Kombinerbart med ordinarie demostöd. Gäller orderteckning till ${dotted(Q_END)}. Begränsat antal bilar, först till kvarn.`],
  [`Fritt dragpaket lagerbilar Lind SWE Edition ${QUARTER} Lagerbilar: Dragkrok och Trailer Assist 0 kr. Kundvärde 15 500 kr. Gäller Lind SWE Edition eHybrid i lager.`],
  [`Choice ${QUARTER} Räntekampanj Kvist och Ask 0,95% ränta. Modell Kvist Life från 3 695 kr/mån. Ask Life från 3 995 kr/mån. 20% kontantinsats, 36 månader. Gäller privatkunder.`],
  [`Kontantstöd privatkunder Kvist 20 000 kr, Ask 20 000 kr. Gäller endast privatkund. Ej kombinerbart med privatleasingstöd, Choice, ramavtal eller demostöd. Kontantstöd BEV ÄD Pb ${QUARTER} ${Y}.`],
  [`Företag: Business Lease ${QUARTER} ${Y} för Ek, Lind och Rönn eHybrid. Månadskostnad sätts av återförsäljaren. Ramavtalspriser räknas fram automatiskt i SAMS när ramavtalet väljs.`],
  [`Demostöd ${QUARTER}: Demonstrationsfordon ska vara av senaste modellår, registreras i demoportalen inom fem dagar och användas i minst tre månader. Stöd 10 000–25 000 kr beroende på modell.`],
  [`Inbytesstöd ${QUARTER} 20 000 kr vid inbyte av utvalda konkurrentmärken. Ansökan via supportportalen. Avtal med inbyte ska bifogas. Gäller endast vid köp av ny bil.`],
  [`Utbildning: Ny säljutbildning för Sky Tourer hålls i oktober. Anmälan via utbildningsportalen senast en vecka innan. Material för skyltning beställs via marknadsportalen.`],
  [`Lagerstatus: god tillgång på Ek och Kvist i vitt och grått. Blå metallic har längre leveranstid. Lind eHybrid finns i begränsat antal i lager.`],
  [
    `${lathundHead("")} ${row("Kvist TSI 115 DSG", "KV13BZ", "2 995", "326 900", "248 861", "2 776", "219", PL)} ${row("Ask TSI 150 DSG", "AS13LE", "3 495", "395 900", "308 444", "3 246", "249", PL)} ${row("Ek eTSI 150 DSG", "EK13EM", "3 495", "373 000", "297 909", "3 246", "249", PL)}`,
    `${row("Ek Kombi eTSI 150 DSG", "EK53EM", "3 995", "382 400", "320 759", "3 746", "249", PL)} ${row("Lind eTSI 150 DSG", "LI1CBM", "3 795", "437 900", "349 289", "3 546", "249", PL)} ${row("Lind eHybrid 272hk SWE Edition", "LI1EYY", "4 995", "631 700", "481 174", "4 746", "249", PL)}`,
    `${row("Rönn eHybrid 272hk Business Limited Edition", "RO5CXY", "4 995", "535 900", "424 597", "4 746", "249", PL)} ${row("Rönn eHybrid 272hk SWE Edition", "RO5EXY", "5 295", "571 900", "458 292", "5 046", "249", PL)} Samtliga modellkoder kan nyttja privatleasingen och varje återförsäljare är fri att sätta egen månadskostnad per modell.`,
  ],
  [
    `${lathundHead(" - fortsättning")} ${row("Kvist TSI 115 DSG", "KV13BZ", "2 795", "326 900", "242 191", "2 574", "219", LOJ)} ${row("Ek eTSI 150 DSG", "EK13EX", "3 295", "352 000", "280 211", "3 046", "249", LOJ)}`,
    `${row("Sky Pro S SWE Edition", "SK24QM", "6 495", "615 900", "508 951", "6 326", "169", SKY)} ${row("Sky GTX SWE Edition", "SK29PM", "7 995", "674 900", "580 513", "7 826", "169", SKY)} Samtliga modellkoder kan nyttja privatleasingen. Stöden betalas endast ut vid val av rätt kampanjkod i finansmodulen.`,
  ],
  [
    `Översikt privatleasing ICE/PHEV ${QUARTER} ${Y} Privatleasing med garanterat restvärde och serviceavtal 36 månader 1 000 mil/år Privatleasing Älvdal Pb ${QUARTER} ${Y}, 1-XKLMRH Lojalitet Älvdal Pb ${QUARTER} ${Y}, 1-XKLMVG Samtliga modellkoder kan nyttja privatleasingen. Ovan kampanjer är exempel på uträknade månadskostnader. Modell Privatleasing kr/mån från Lojal Modellkod Kvist TSI 115 DSG 2 995 2 795 KV13BZ Ask Life TSI 150 DSG 3 495 3 295 AS13LE Ek Edition eTSI 150 DSG 3 495 3 295 EK13EM Ek Kombi Edition TSI 150 3 995 EK53EM Lind Edition eTSI 150 DSG 3 795 LI1CBM`,
    `Lind SWE Edition eHybrid 272 hk DSG 4 995 LI1EYY Rönn eHybrid Business Limited Edition 272 hk DSG 4 995 RO5CXY Rönn eHybrid SWE Edition 272 hk DSG 5 295 RO5EXY`,
  ],
  [`Översikt privatleasing BEV ${QUARTER} ${Y} Privatleasing med garanterat restvärde och serviceavtal 36 månader 1 000 mil/år Privatleasing BEV Älvdal Pb ${QUARTER} ${Y}, 1-XKLMM7 Begränsad volym. Modell Privatleasing kr/mån från Modellkod Sky Pro S SWE Edition 6 495* SK24QM Sky GTX Edition 7 995* SK29PM Sky Tourer Pro S SWE Edition 6 495* SK54QM`],
  [`Ek (EK13EX, EK13EM) Ordinarie Pris 3 495 kr/mån Inklusive service Lojalitetserbjudande: 3 295 kr/mån Inklusive service Kvist (KV13BZ) Ordinarie Pris 2 995 kr/mån Lojalitetserbjudande: 2 795 kr/mån Lojalitetskampanj Älvdal Pb ${QUARTER} ${Y} • Gäller sålda bilar under ${QUARTER} kampanjperiod • Gäller för tidigare kund med finansiering via Älvdal Finans`],
  [`Extrakampanj Ek Kombi. Kampanjperiod ${EXPIRED}. Privatleasing 3 595 kr/mån, 36 månader, 1 000 mil per år. Kampanjkod (102690) ÄD Extra.`],
  [`Choice ${QUARTER} Modell Choice-stöd Kvist 15 000 Ek 15 000 Lind 20 000 Rönn 20 000 Volt 25 000 Sky 25 000. Choice-stödet dras av från bilens pris vid finansiering via Älvdal Finans.`],
  [`Översikt kombinationsregler av stöd ${QUARTER}: Kampanjer som styrs av ramavtal kan aldrig kombineras med varandra. Kontantstöd kan inte kombineras med privatleasingstöd eller Choice.`],
  [`Volymbonus ${QUARTER} "Dubbel pinne": Försäljning x2 ger bonus x1. Gäller modellerna Volt och Sky. Rapporteras månadsvis.`],
  [`Kontaktpersoner: frågor om kampanjerna besvaras av regionens säljansvariga. Material för skyltning beställs via marknadsportalen. Rapportera fel i prislistor via supportportalen.`],
];

/** Fjällby: brand overview with explicit current-quarter dates. */
const fjallby: string[][] = [
  [`Fjällby kampanjöversikt. Kampanjperiod ${sv(Q_START)} – ${sv(Q_END)} ${Y}. Alla priser inklusive moms. Privatleasing 36 månader och 1 000 mil per år, inklusive serviceavtal, exklusive försäkring.`],
  [`Fjällby Topp Sportback. Halvkombi. Privatleasing från 3 695 kr/mån. Lojalitetsavdrag 200 kr/mån för tidigare kunder. Kampanjränta 4,95 % på billån och finansiell leasing.`],
  [`Fjällby Topp hybrid. Laddhybrid, halvkombi. Privatleasing från 5 145 kr/mån. Kundorderbonus 20 000 kr exkl. moms krävs för att nå månadskostnaden. Kampanjränta 4,95 %.`],
  [`Fjällby Vidd e-tron. Elektrisk familje-SUV. Quattro Proline Edition: editionpris 619 000 kr, ordinarie 660 000 kr, privatleasing från 5 995 kr/mån. Performance Proline: privatleasing från 5 795 kr/mån. Choice-ränta 0,95 %.`],
  [`Fjällby Bred hybrid. Laddhybrid, sedan och kombi. Privatleasing från 5 695 kr/mån, Business lease från 5 495 kr/mån. Kundorderbonus 15 000 kr exkl. moms krävs för angiven månadskostnad.`],
  [`Fjällby Rand hybrid. Laddhybrid-SUV. Selection Edition från 685 000 kr. Privatleasing från 8 555 kr/mån, Business lease från 7 095 kr/mån.`],
  [`Fjällby Strand e-tron. Stor elbil. RWD Proline från 669 900 kr, privatleasing från 7 995 kr/mån, Business lease från 7 295 kr/mån. Pluspaket 9 900 kr, ordinarie 36 200 kr.`],
  [`Fjällby Lätt e-tron. Liten elbil. Privatleasing från 4 895 kr/mån, Business lease från 4 695 kr/mån. Choice-ränta 0,95 %. Lojalitetserbjudande 100 kr/mån i avdrag.`],
  [`Leveranstider Fjällby: Topp 8–10 veckor, Vidd e-tron 10–12 veckor, Rand hybrid 14–16 veckor. Leveranstiderna är prognoser.`],
  [`Villkor: Erbjudandena gäller privatpersoner vid beställning och leverans under kampanjperioden. Kan inte kombineras med andra rabatter. Demobilar omfattas inte.`],
  [`Försäkring: Fjällby Försäkring kan tecknas i samband med leasing. Premien beräknas individuellt och ingår inte i kampanjpriserna.`],
  [`Tillbehör: Vinterhjulspaket och takräcken säljs till ordinarie pris. Laddbox installeras till fast pris för privatleasingkunder i villa.`],
];

// ---------------------------------------------------------------------------

interface Turn {
  question: string;
  context: ContextChunk[];
  sources: SourceReference[];
  stats: RetrievalStats;
  answer: string;
  cited: SourceReference[];
  usage: UsageReport | null;
  modelMs: number;
}

const BROAD_Q = 'ställ fjällbys och älvdals kampanjer mot varandra och jämför vad som skiljer. jämför "rätt" modeller mot varandra. ex Volt vs Fjällby Vidd';
const FAMILY_Q =
  "Vilket skulle du säga passar en barnfamilj som idag har 1 barn på 3 år och väntar nästa kring årsskiftet som en andrabil? kör ca 1000mil om året och totalekonomi är viktigt.";

describe.skipIf(!isDevelopmentProject)("validity across the conversation (real OpenAI, realistic synthetic documents)", () => {
  let tester: LiveUser;
  let sales: string;
  let organization: string;
  let instructions: string;
  let instructionSource: string;
  const docs = { alvdal: "", fjallby: "" };
  const lathundChunks: SourceReference[] = [];
  let overviewChunkId = 0;
  let lathundHeadId = 0;
  let usd = 0;

  async function createPagedDocument(title: string, pages: string[][], base: Parameters<typeof createDocument>[0]) {
    const flat = pages.flatMap((chunks, page) => chunks.map((content) => ({ content, page: page + 1 })));
    const { id } = await createDocument({ ...base, title, chunks: flat.map((c) => c.content) });
    const svc = service();
    const { data } = await svc.from("document_chunks").select("id, chunk_index").eq("document_id", id).order("chunk_index");
    for (const c of (data ?? []) as { id: number; chunk_index: number }[]) {
      await svc.from("document_chunks").update({ location: `s. ${flat[c.chunk_index].page}` }).eq("id", c.id);
    }
    return id;
  }

  beforeAll(async () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("kexddqzzbbmcbrqtgtoi")) throw new Error("Endast folke-dev");
    sales = await assistantId("salj");
    const group = await createGroup("validity");
    tester = await createUser("validity");
    const svc = service();
    await svc.from("group_members").insert({ group_id: group, user_id: tester.id, is_manager: false });
    await svc.from("assistant_grants").insert({ assistant_id: sales, group_id: group });

    const base = { title: "", ownerGroupId: group, uploadedBy: tester.id, assistantIds: [sales], chunks: [], dataClass: "synthetic" as const };
    // Like the real upload: valid from the upload date to the end of the quarter.
    docs.alvdal = await createPagedDocument("Älvdal kampanjöversikt", alvdal, { ...base, validFrom: TODAY, validUntil: iso(Q_END) });
    docs.fjallby = await createPagedDocument("Fjällby kampanjöversikt", fjallby, { ...base, validFrom: TODAY });

    const model = embeddingModel();
    for (const id of Object.values(docs)) {
      const { data } = await svc.from("document_chunks").select("id, content, location").eq("document_id", id).order("chunk_index");
      const rows = (data ?? []) as { id: number; content: string; location: string }[];
      const { vectors } = await createEmbeddings(model.id, model.dimensions, rows.map((c) => c.content));
      for (const [i, c] of rows.entries()) {
        await svc.from("document_chunks").update({ embedding: `[${vectors[i].join(",")}]`, embedding_model: model.id, embedded_at: new Date().toISOString() }).eq("id", c.id);
        if (id === docs.alvdal && c.content.startsWith("Lathund")) {
          lathundChunks.push({ id: String(c.id), documentId: id, title: "Test – live Älvdal kampanjöversikt", excerpt: "", location: c.location });
          if (!lathundHeadId) lathundHeadId = c.id;
        }
        if (id === docs.alvdal && c.content.startsWith("Översikt privatleasing ICE/PHEV")) overviewChunkId = c.id;
      }
    }

    organization = ((await svc.from("organization_instructions").select("content").single()).data?.content as string) ?? "";
    const draft = (await svc.from("instruction_drafts").select("content").eq("assistant_id", sales).maybeSingle()).data;
    const published = (await svc.from("assistants").select("instructions").eq("id", sales).single()).data!.instructions as string;
    const useDraft = draft && process.env.FOLKE_EVAL_SALJ !== "published";
    instructions = useDraft ? (draft.content as string) : published;
    instructionSource = useDraft ? "utkast" : "publicerad";
  }, 300_000);

  afterAll(async () => {
    await cleanup();
  }, 300_000);

  async function ask(rows: HistoryRow[], question: string): Promise<Turn> {
    rows.push({ role: "user", content: question, sources: null });
    const model = embeddingModel();
    const { context, sources, stats } = await retrieveContext(tester.client, {
      assistantId: sales,
      message: question,
      history: rows,
      dataClass: "synthetic",
      embed: async (text) => {
        const { vectors } = await createEmbeddings(model.id, model.dimensions, [text]);
        return { vector: `[${vectors[0].join(",")}]`, model: model.id };
      },
    });
    assertExternalAllowed({ external: true, conversationClass: "synthetic", userHasTestAccess: true, context });
    const history = limitHistory(filterHistory(rows, new Set(rows.flatMap((r) => (r.sources ?? []).map((s) => s.documentId)))));
    let text = "";
    let usage: UsageReport | null = null;
    const started = Date.now();
    for await (const e of openAIProvider.streamChat({
      system: buildSystemPrompt({ organization, assistant: instructions }, context, { broad: stats.scope === "broad" }),
      messages: history,
      context,
      model: resolveChatModel(null).id,
      onUsage: (u) => (usage = u),
    })) {
      text += e.delta;
    }
    const modelMs = Date.now() - started;
    const report = usage as UsageReport | null;
    if (report) usd += chatCostUsd(report.model, report);
    const verified = verifyCitations(text, context.length);
    const cited = citedSources(sources, verified.cited);
    rows.push({ role: "assistant", content: verified.content, sources: cited });
    return { question, context, sources, stats, answer: verified.content, cited, usage: report, modelMs };
  }

  // --- Grading ---------------------------------------------------------------
  // Only statements about validity ("not confirmed as current / for Q4", "not current"),
  // not about comparability ("not confirmed in size or body style").
  const NOT_CURRENT =
    /(inte|ej)\s+(är\s+)?(som\s+)?(ett\s+|några\s+)?(bekräftad|bekräftat|bekräftade)\s+(som\s+)?(aktuell|aktuella|aktuellt|Q\d|för\s+(Q\d|den aktuella|perioden)|\S*-?(pris|erbjudand))|(inte|ej)\s+(är\s+)?(som\s+)?(ett\s+|några\s+)?(säkert\s+)?(aktuell|aktuella|aktuellt|giltig|giltiga)\b|kan inte bekräftas som aktuell|gäller före (Q\d|den aktuella)|räknar (jag )?(dem|dessa|de|priserna|lathundspriserna) inte|använder (jag )?(därför )?inte (de|dessa) priser/i;
  /** True when a line that mentions a contested current-quarter price calls it not current. */
  const rejectsContested = (answer: string) =>
    answer.split("\n").some((line) => CONTESTED.some((p) => line.includes(p)) && NOT_CURRENT.test(line) && !line.includes(EXPIRED_PRICE)) ||
    /lathund[^.\n]{0,120}(inte|ej) (som )?(bekräftade?|aktuella)/i.test(answer);
  const EXPIRY = /avslutad|gått ut|gick ut|passerat|gällde|inte längre|upphört|utgått|inte (som )?aktuell|räknas inte|har löpt ut|tidigare kampanj|slutade/i;
  const presentsExpiredAsCurrent = (answer: string) => {
    for (let at = answer.indexOf(EXPIRED_PRICE); at >= 0; at = answer.indexOf(EXPIRED_PRICE, at + 1)) {
      if (!EXPIRY.test(answer.slice(Math.max(0, at - 250), at + 250))) return true;
    }
    return false;
  };
  const MISSING =
    /saknas|saknar|framgår inte|anges inte|finns inte|inte angiv|ingen uppgift|inget (angivet )?(kampanjpris|leasingpris|privatleasingpris|månadspris)|ingen (officiell |angiven )?(månadskostnad|kampanjleasing)/i;
  const voltMissing = (answer: string) =>
    answer.split("\n").some((line) => /Volt/.test(line) && MISSING.test(line)) || /Volt[^.]{0,200}(saknas|framgår inte|anges inte)/i.test(answer);

  it("judges the same offers the same way, regardless of history and question", async () => {
    const counts: Record<string, { ok: number; strict: boolean }> = {};
    const hard: string[] = [];
    const turns: { scenario: string; kind: string; t: Turn }[] = [];
    const pass = (name: string, ok: boolean, strict = false) => {
      counts[name] ??= { ok: 0, strict };
      if (ok) counts[name].ok++;
    };
    const commonHard = (label: string, t: Turn) => {
      const ids = new Set(t.sources.map((s) => s.id));
      for (const s of t.cited) if (!ids.has(s.id)) hard.push(`${label}: citerad källa ${s.id} fanns inte i kontexten`);
    };

    for (let run = 1; run <= RUNS; run++) {
      for (const scenario of ["ren historik", "felaktig historik"] as const) {
        const rows: HistoryRow[] = [];
        if (scenario === "felaktig historik") {
          // The wrong verdict from the earlier release, with the cheat sheet as its sources.
          rows.push(
            { role: "user", content: BROAD_Q, sources: null },
            {
              role: "assistant",
              content: `Kampanjöversikterna anger perioden för ${QUARTER}. Älvdalsbladet har dock en konflikt i underlaget: en särskild privatleasinglathund anger perioden ${STALE}, trots att den finns i en översikt för ${QUARTER}. Jag använder därför inte de priserna som aktuella ${QUARTER}-erbjudanden. Ek lojalitet 3 295 kr/mån och Lind eHybrid 4 995 kr/mån är inte bekräftade ${QUARTER}-priser. [1][2]`,
              sources: lathundChunks.slice(0, 2),
            },
            { role: "user", content: "okej, jag vill jämföra samtliga kampanjer mot varandra", sources: null },
            {
              role: "assistant",
              content: `Älvdalsunderlaget innehåller privatleasinglathundar med perioden ${STALE}. Jag tar med de priserna som uppgifter ur lathunden, men räknar dem inte som bekräftade ${QUARTER}-erbjudanden. Sky Pro 6 495 kr/mån och Rönn eHybrid 4 995 kr/mån är därför inte bekräftade. [1][2]`,
              sources: lathundChunks.slice(2, 4),
            },
          );
        }
        const broad = await ask(rows, BROAD_Q);
        const family = await ask(rows, FAMILY_Q);
        turns.push({ scenario, kind: "bred", t: broad }, { scenario, kind: "rekommendation", t: family });
        const s = scenario;

        // Retrieval sanity (unchanged retrieval): the conflict is really in the context.
        if (broad.stats.scope !== "broad") hard.push(`${s}: jämförelsen klassades inte som bred`);
        if (!broad.context.some((c, i) => broad.sources[i].id === String(overviewChunkId))) hard.push(`${s}: ${QUARTER}-översikten saknas i kontexten`);
        if (!broad.context.some((c, i) => broad.sources[i].id === String(lathundHeadId))) hard.push(`${s}: lathundens rubrik med äldre datum saknas i kontexten`);
        if (scenario === "felaktig historik" && broad.stats.reused === 0) hard.push(`${s}: källorna från den felaktiga historiken återhämtades inte`);
        commonHard(`${s}/bred`, broad);
        commonHard(`${s}/rekommendation`, family);

        // Validity: strict, every run.
        pass(`${s}: bred – avfärdar inte ${QUARTER}-priserna`, !rejectsContested(broad.answer), true);
        pass(`${s}: rekommendation – avfärdar inte ${QUARTER}-priserna`, !rejectsContested(family.answer), true);
        pass(`${s}: samma bedömning i båda svaren`, !rejectsContested(broad.answer) && !rejectsContested(family.answer), true);
        pass(`${s}: utgången extrakampanj inte aktuell (båda svaren)`, !presentsExpiredAsCurrent(broad.answer) && !presentsExpiredAsCurrent(family.answer), true);

        // Usefulness: RUNS - 1.
        pass(`${s}: bred – nämner minst två ${QUARTER}-priser från översikten`, CONTESTED.filter((p) => broad.answer.includes(p)).length >= 2);
        pass(`${s}: bred – Volts leasingpris markeras som saknat`, voltMissing(broad.answer));
        pass(`${s}: bred – kapas inte`, !broad.answer.includes("avbröts här"));
        pass(`${s}: rekommendation – konkret förslag med månadskostnad`, /\d[\d ]{2,} kr\/mån/.test(family.answer));
      }
    }

    // --- Report --------------------------------------------------------------
    const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1));
    const sd = (xs: number[]) => Math.round(Math.sqrt(avg(xs.map((x) => (x - avg(xs)) ** 2))));
    const usageLine = (scenario: string, kind: string) => {
      const ts = turns.filter((x) => x.scenario === scenario && x.kind === kind).map((x) => x.t);
      const reasoning = ts.map((t) => t.usage?.reasoningTokens ?? 0);
      const out = ts.map((t) => t.usage?.outputTokens ?? 0);
      const ms = ts.map((t) => t.modelMs);
      return `${scenario}, ${kind}: in ${avg(ts.map((t) => t.usage?.inputTokens ?? 0))}, ut ${avg(out)} ±${sd(out)} (max ${Math.max(...out)}), resonemang ${avg(reasoning)} ±${sd(reasoning)} [${reasoning.join("/")}], svarstid ${avg(ms)} ±${sd(ms)} ms (max ${Math.max(...ms)}), textbitar ${avg(ts.map((t) => t.stats.chunks))} (${avg(ts.map((t) => t.stats.chars))} tecken), kapade ${ts.filter((t) => t.answer.includes("avbröts här")).length}/${ts.length}`;
    };
    const effort = process.env.FOLKE_AI_REASONING_EFFORT ?? resolveChatModel(null).reasoningEffort;
    const lines = [
      `=== Giltighet i hela konversationen (${instructionSource} Säljinstruktion, ${resolveChatModel(null).id}, reasoning ${effort}, ${RUNS} körningar, ${QUARTER} ${Y}, äldre period ${STALE}) ===`,
      ...Object.entries(counts).map(([k, v]) => `${v.ok >= (v.strict ? RUNS : RUNS - 1) ? "✓" : "✗"} ${k}: ${v.ok}/${RUNS}${v.strict ? " (krävs alla)" : ""}`),
      "",
      ...["ren historik", "felaktig historik"].flatMap((s) => [usageLine(s, "bred"), usageLine(s, "rekommendation")]),
      `Kostnad: ${usd.toFixed(5)} USD totalt, ${(usd / RUNS).toFixed(5)} USD per körning (4 svar)`,
      hard.length ? `Hårda fel:\n- ${[...new Set(hard)].join("\n- ")}` : "Hårda kontroller: alla godkända",
    ];
    console.log(lines.join("\n"));
    if (process.env.FOLKE_EVAL_OUT) {
      writeFileSync(process.env.FOLKE_EVAL_OUT, JSON.stringify({ summary: lines, turns: turns.map((x) => ({ scenario: x.scenario, kind: x.kind, stats: x.t.stats, usage: x.t.usage, answer: x.t.answer })) }, null, 2));
    }
    expect([...new Set(hard)]).toEqual([]);
    expect(Object.entries(counts).filter(([, v]) => v.ok < (v.strict ? RUNS : RUNS - 1)).map(([k]) => k)).toEqual([]);
  }, 2_400_000);
});
