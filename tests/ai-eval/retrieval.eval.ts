import { writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SourceReference } from "@/lib/domain/types";
import { verifyCitations } from "@/server/ai/citations";
import { assertExternalAllowed } from "@/server/ai/guard";
import { embeddingModel, resolveChatModel } from "@/server/ai/models";
import { chatCostUsd, embeddingCostUsd } from "@/server/ai/pricing";
import { buildSystemPrompt, limitHistory, stockholmDate } from "@/server/ai/prompt";
import { TRUNCATED_NOTE, createEmbeddings, openAIProvider } from "@/server/ai/providers/openai";
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
 * Conversation-aware retrieval (ADR-042) with the REAL pipeline: synthetic
 * documents in the DEVELOPMENT Supabase project (RLS, hybrid search,
 * re-read of cited chunks), the real prompt builder and REAL OpenAI calls.
 *
 *   node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.eval.config.mts tests/ai-eval/retrieval.eval.ts
 *
 * Two fictional brands, "Norrvik" and "Solberg", mirror the structure of
 * real campaign material (a brand overview whose title does not name the
 * brand; a long weekly update with many short pages, where "Q4" means the
 * quarter) without any real content. Everything is removed afterwards.
 *
 * The Säljassistent instructions are the DRAFT in folke-dev when there is
 * one (FOLKE_EVAL_SALJ=published forces the published text).
 *
 * Retrieval, citation and safety checks must pass in every run. Answer
 * quality is graded per run and must pass in at least RUNS - 1 runs.
 */

const RUNS = Number(process.env.FOLKE_EVAL_RUNS ?? 3);
const TODAY = stockholmDate();
const day = (offset: number) => stockholmDate(new Date(Date.now() + offset * 86_400_000));
const CURRENT = { from: day(-1), to: day(90) };
const EXPIRED = { from: day(-120), to: day(-20) };
/** A leftover older period in a section that is labelled with the current quarter. */
const STALE = { from: day(-101), to: day(-2) };

const WORD = "[\\p{L}\\p{N}]";
const has = (text: string, word: string) => new RegExp(`(?<!${WORD})${word}(?!${WORD})`, "iu").test(text);

/** Unique price per current campaign page: identifies the page in the context. */
const CAMPAIGNS: Record<string, { brand: "Norrvik" | "Solberg"; model: string; price: string }> = {
  fjord: { brand: "Norrvik", model: "Fjord", price: "3 495" },
  as: { brand: "Norrvik", model: "Ås", price: "5 295" },
  kust: { brand: "Norrvik", model: "Kust", price: "4 195" },
  stad: { brand: "Norrvik", model: "Stad", price: "2 795" },
  polar: { brand: "Solberg", model: "Polar", price: "5 495" },
  polarSport: { brand: "Solberg", model: "Polar Sport", price: "6 295" },
  ved: { brand: "Solberg", model: "Ved", price: "4 395" },
  mini: { brand: "Solberg", model: "Mini", price: "2 895" },
  kvarts: { brand: "Solberg", model: "Kvarts", price: "3 595" },
};
const EXPIRED_PRICE = "2 995";
const EXPIRED_DOCUMENT_PRICE = "1 995";

const norrvikPages = [
  `Norrvik kampanjöversikt för privatkunder. Kampanjperiod: ${CURRENT.from} till ${CURRENT.to}. Alla priser inklusive moms. Erbjudandena gäller vid beställning hos auktoriserad Norrvik-återförsäljare under kampanjperioden.`,
  "Norrvik Fjord. Kompakt elbil, halvkombi med fem dörrar. Räckvidd upp till 410 km enligt WLTP. Privatleasing 3 495 kr/mån, 36 månader, 1 500 mil per år, ingen särskild leasingavgift.",
  "Norrvik Ås. Familje-SUV, el, fyrhjulsdrift och sju säten som tillval. Räckvidd upp till 520 km enligt WLTP. Privatleasing 5 295 kr/mån, 36 månader, 1 500 mil per år. Kampanjpris vid köp 489 900 kr (ordinarie 529 900 kr).",
  "Norrvik Kust. Laddhybrid, kombi. Elräckvidd upp till 85 km enligt WLTP. Kampanjränta 3,95 % vid billån med minst 20 % kontantinsats och löptid upp till 72 månader. Privatleasing 4 195 kr/mån, 36 månader.",
  "Norrvik Stad. Liten stadsbil, el. Räckvidd upp till 290 km enligt WLTP. Privatleasing 2 795 kr/mån, 36 månader, 1 000 mil per år.",
  `Sommarkampanj Norrvik Fjord. Kampanjperiod: ${EXPIRED.from} till ${EXPIRED.to}. Privatleasing 2 995 kr/mån, 36 månader, 1 500 mil per år.`,
  "Norrvik Care. Serviceavtal som ingår för privatleasingkunder: service enligt serviceprogram i 3 år eller 4 500 mil. Slitdelar ingår inte.",
  "Leveranstider. Fjord och Stad levereras normalt inom 6 till 8 veckor. Ås har 12 till 14 veckors leveranstid för fabriksorder. Kust finns i begränsat antal i lager.",
  "Utrustningsnivåer. Bas, Plus och Max. Plus ger värmepump, backkamera och adaptiv farthållare. Max ger dessutom panoramatak och ljudsystem.",
  "Vinterhjul. Kampanjerbjudandena omfattar inte vinterhjul. Vinterhjulspaket kan köpas till ordinarie pris via tillbehörsavdelningen.",
  "Försäkring. Norrvik Försäkring kan tecknas i samband med leasing. Premien beräknas individuellt och ingår inte i kampanjpriserna.",
  "Laddbox. Kunder som tecknar privatleasing erbjuds installation av laddbox till fast pris. Gäller villa med godkänd elcentral.",
  "Inbyte. Inbytesbilar värderas enligt ordinarie rutin. Kampanjerna kan inte kombineras med andra rabatter.",
  "Demobilar. Ett begränsat antal demobilar säljs med individuellt pris. Demobilar omfattas inte av kampanjpriserna i denna översikt.",
  "Kontakt. Frågor om kampanjerna besvaras av regionens säljansvariga. Material för skyltning beställs via marknadsportalen.",
];

const solbergModels = [
  "Solberg Polar. Familje-SUV, el. Räckvidd upp till 540 km enligt WLTP. Bagagevolym 560 liter. Privatleasing Q4: 5 495 kr/mån, 36 månader, 1 500 mil per år.",
  "Solberg Polar Sport. Sportigare SUV, el, fyrhjulsdrift. Räckvidd upp till 495 km enligt WLTP. Privatleasing Q4: 6 295 kr/mån, 36 månader, 1 500 mil per år.",
  "Solberg Ved. Kombi, laddhybrid. Elräckvidd upp till 80 km enligt WLTP. Privatleasing Q4: 4 395 kr/mån, 36 månader. Solberg Service Plus ingår.",
  "Solberg Mini. Stadsbil, el. Räckvidd upp till 300 km enligt WLTP. Privatleasing Q4: 2 895 kr/mån, 36 månader, 1 000 mil per år.",
  "Solberg Kvarts. Halvkombi, el. Räckvidd upp till 430 km enligt WLTP. Privatleasing Q4: 3 595 kr/mån, 36 månader, 1 500 mil per år.",
];
const solbergNews = [
  "Ny säljutbildning den 14 oktober i Göteborg. Anmälan via utbildningsportalen senast en vecka innan.",
  "Lagerstatus vecka 40: god tillgång på färgerna vit och grå. Blå metallic har längre leveranstid.",
  "Mjukvaruuppdatering för infotainment rullas ut över luften under oktober. Ingen åtgärd krävs av verkstaden.",
  "Ny färg i programmet: Skogsgrön. Beställningsbar från vecka 42 för samtliga elbilar.",
  "Mässa: Solberg deltar på bilmässan i Stockholm i november. Säljare som vill delta anmäler sig till sin säljchef.",
  "Personalnyheter: ny regionansvarig för västra Sverige tillträder den 1 november.",
  "Påminnelse: demobilar ska registreras i demoportalen inom fem dagar från leverans.",
  "Kundundersökning: nöjdhetsindex steg till 86 under tredje kvartalet.",
  "Tips för provkörning: boka gärna längre provkörningar för elbilar så att kunden hinner testa laddning.",
  "Nytt material för sociala medier finns i marknadsportalen. Använd bara godkända bilder.",
  "Ändrade öppettider för kundtjänst under allhelgonahelgen.",
  "Uppdaterad prislista för tillbehör gäller från den 1 oktober. Takboxar och cykelhållare har nya artikelnummer.",
  "Rutin för leveransgenomgång: gå igenom laddkabel, app och service med kunden vid leverans.",
  "Verkstadsinformation: ny specialverktygssats skickas till alla auktoriserade verkstäder.",
  "Försäljningsstatistik: flest beställningar under september gällde stadsbilar och SUV:ar.",
  "Utbildningsfilm om nya assistanssystem finns i utbildningsportalen.",
  "Begagnatprogrammet Solberg Certifierad utökas med längre garanti för elbilar.",
  "Påminnelse om årsmöte för återförsäljarföreningen den 20 november.",
  "Nya skyltar till showroom levereras under vecka 44.",
  "Info om transportskador: rapportera inom 24 timmar via transportportalen.",
];
const solbergPages = [
  "Solberg Update vecka 40. Nyheter för återförsäljare och Q4-kampanjöversikt.",
  ...solbergNews.slice(0, 6),
  `Q4-kampanjöversikt privatleasing. Gäller beställningar ${CURRENT.from} till ${CURRENT.to}. Priserna gäller privatpersoner och inkluderar moms.`,
  ...solbergModels,
  `Lathund privatleasing Q4. Kampanjperiod: ${STALE.from} till ${STALE.to}. Rekommenderade priser, varje återförsäljare sätter sitt eget pris: Solberg Polar 5 495 kr/mån, Solberg Ved 4 395 kr/mån, Solberg Mini 2 895 kr/mån.`,
  "Solberg Service Plus. Service och slitdelar i 36 månader ingår i privatleasingkampanjerna för Ved. För övriga modeller kan avtalet köpas till.",
  ...solbergNews.slice(6),
];

const expiredPages = ["Norrvik vinterkampanj. Norrvik Fjord privatleasing 1 995 kr/mån, 36 månader."];

// ---------------------------------------------------------------------------

interface Turn {
  question: string;
  context: ContextChunk[];
  sources: SourceReference[];
  stats: RetrievalStats;
  answer: string;
  cited: SourceReference[];
  sentHistory: { role: string; content: string }[];
  retrievalMs: number;
  modelMs: number;
  usage: UsageReport | null;
}

describe.skipIf(!isDevelopmentProject)("conversation-aware retrieval (real OpenAI, synthetic documents)", () => {
  let tester: LiveUser;
  let sales: string;
  let organization: string;
  let instructions: string;
  let instructionSource: string;
  const docs: Record<"norrvik" | "solberg" | "expired", string> = { norrvik: "", solberg: "", expired: "" };
  const usd = { chat: 0, embeddingTokens: 0 };

  beforeAll(async () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("kexddqzzbbmcbrqtgtoi")) throw new Error("Endast folke-dev");
    sales = await assistantId("salj");
    const group = await createGroup("retrieval");
    tester = await createUser("retrieval");
    const svc = service();
    await svc.from("group_members").insert({ group_id: group, user_id: tester.id, is_manager: false });
    await svc.from("assistant_grants").insert({ assistant_id: sales, group_id: group });
    await svc.from("profiles").update({ ai_test_access: true }).eq("id", tester.id);

    const base = { ownerGroupId: group, uploadedBy: tester.id, assistantIds: [sales], dataClass: "synthetic" as const, locationLabel: "Sida" };
    // Brand overview: title without the brand, validity set by the administrator.
    docs.norrvik = (await createDocument({ ...base, title: "Kampanjöversikt oktober", chunks: norrvikPages, validFrom: CURRENT.from, validUntil: CURRENT.to })).id;
    // Weekly update: no end date; campaign periods only in the text.
    docs.solberg = (await createDocument({ ...base, title: "Solberg Update vecka 40", chunks: solbergPages, validFrom: day(-2) })).id;
    // Expired document: must never reach the model.
    docs.expired = (await createDocument({ ...base, title: "Norrvik vinterkampanj", chunks: expiredPages, validFrom: day(-300), validUntil: day(-200) })).id;

    const model = embeddingModel();
    for (const id of Object.values(docs)) {
      const { data: chunks } = await svc.from("document_chunks").select("id, content").eq("document_id", id).order("chunk_index");
      const rows = (chunks ?? []) as { id: number; content: string }[];
      const { vectors, tokens } = await createEmbeddings(model.id, model.dimensions, rows.map((c) => c.content));
      usd.embeddingTokens += tokens;
      for (const [i, c] of rows.entries()) {
        const { error } = await svc
          .from("document_chunks")
          .update({ embedding: `[${vectors[i].join(",")}]`, embedding_model: model.id, embedded_at: new Date().toISOString() })
          .eq("id", c.id);
        if (error) throw new Error(error.message);
      }
    }

    const { data: norrvikChunks } = await svc.from("document_chunks").select("id, content").eq("document_id", docs.norrvik);
    for (const [key, c] of Object.entries(CAMPAIGNS)) {
      const hit = ((norrvikChunks ?? []) as { id: number; content: string }[]).find((x) => x.content.includes(c.price) && x.content.includes(c.model));
      if (hit) chunkIds[key as keyof typeof CAMPAIGNS] = hit.id;
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

  const chunkIds: Partial<Record<keyof typeof CAMPAIGNS, number>> = {};

  async function ask(rows: HistoryRow[], question: string): Promise<Turn> {
    rows.push({ role: "user", content: question, sources: null });
    const started = Date.now();
    const model = embeddingModel();
    const { context, sources, stats } = await retrieveContext(tester.client, {
      assistantId: sales,
      message: question,
      history: rows,
      dataClass: "synthetic",
      embed: async (text) => {
        const { vectors, tokens } = await createEmbeddings(model.id, model.dimensions, [text]);
        usd.embeddingTokens += tokens;
        return { vector: `[${vectors[0].join(",")}]`, model: model.id };
      },
    });
    const retrievalMs = Date.now() - started;
    assertExternalAllowed({ external: true, conversationClass: "synthetic", userHasTestAccess: true, context });

    const sentHistory = limitHistory(filterHistory(rows, new Set(rows.flatMap((r) => (r.sources ?? []).map((s) => s.documentId)))));
    let text = "";
    let usage: UsageReport | null = null;
    const t0 = Date.now();
    for await (const e of openAIProvider.streamChat({
      system: buildSystemPrompt({ organization, assistant: instructions }, context, { broad: stats.scope === "broad" }),
      messages: sentHistory,
      context,
      model: resolveChatModel(null).id,
      onUsage: (u) => (usage = u),
    })) {
      text += e.delta;
    }
    const modelMs = Date.now() - t0;
    const report = usage as UsageReport | null;
    if (report) usd.chat += chatCostUsd(report.model, report);
    const verified = verifyCitations(text, context.length);
    const cited = citedSources(sources, verified.cited);
    rows.push({ role: "assistant", content: verified.content, sources: cited });
    return { question, context, sources, stats, answer: verified.content, cited, sentHistory, retrievalMs, modelMs, usage: report };
  }

  // --- Grading helpers -------------------------------------------------------
  const inContext = (t: Turn, key: keyof typeof CAMPAIGNS) =>
    t.context.some((c) => c.content.includes(CAMPAIGNS[key].price) && c.content.includes(CAMPAIGNS[key].model));
  const coverage = (t: Turn, keys: (keyof typeof CAMPAIGNS)[]) => keys.filter((k) => inContext(t, k)).length;
  const mentioned = (t: Turn, keys: (keyof typeof CAMPAIGNS)[]) => keys.filter((k) => has(t.answer, CAMPAIGNS[k].model)).length;
  const NORRVIK = ["fjord", "as", "kust", "stad"] as const;
  const SOLBERG = ["polar", "polarSport", "ved", "mini", "kvarts"] as const;
  const ALL = [...NORRVIK, ...SOLBERG];
  const EXPIRY = /avslutad|gått ut|gick ut|passerat|gällde|inte längre|upphört|utgått|inte (som )?aktuell|räknas inte|har löpt ut|tidigare kampanj|slutade/i;
  /** An expired price may only appear next to words saying it has expired. */
  const presentsExpiredAsCurrent = (answer: string, price: string) => {
    for (let at = answer.indexOf(price); at >= 0; at = answer.indexOf(price, at + 1)) {
      if (!EXPIRY.test(answer.slice(Math.max(0, at - 250), at + 250))) return true;
    }
    return false;
  };
  const REFUSES_CURRENCY = /(inte|ej) (går|kan|möjligt)[^.]{0,40}(avgöra|fastställa|bekräfta)[^.]{0,60}(aktuell|gäller|giltig)/i;
  const MISSING = /saknas|framgår inte|anges inte|finns inte|inte angiven|ingen uppgift|uppgift om [^.]{0,40} finns inte/i;

  /** Every cited source is a chunk that was in the context; prices next to a citation are in a cited chunk. */
  function citationProblems(t: Turn): string[] {
    const problems: string[] = [];
    const byId = new Map(t.context.map((c, i) => [t.sources[i].id, c]));
    for (const s of t.cited) {
      const c = byId.get(s.id);
      if (!c || c.documentId !== s.documentId) problems.push(`källa ${s.id} fanns inte i kontexten`);
    }
    // Per sentence, line and table cell: a price next to a citation must be in a cited chunk.
    // (Differences the model calculates stand without a citation and are not checked.)
    for (const sentence of t.answer.split(/(?<=[.!?\n|])/)) {
      const refs = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)/g)].flatMap((m) => m[1].split(",").map((n) => Number(n.trim())));
      if (!refs.length) continue;
      for (const price of sentence.match(/\d[\d ]{2,}(?= kr)/g) ?? []) {
        const chunks = refs.map((n) => byId.get(t.cited[n - 1]?.id ?? "")).filter(Boolean) as ContextChunk[];
        if (!chunks.length || chunks.some((c) => c.content.includes(price.trim()))) continue;
        // A difference the model calculated from two cited prices is reasoning, not a new fact.
        const amounts = chunks.flatMap((c) => (c.content.match(/\d[\d ]{2,}(?= kr)/g) ?? []).map((p) => Number(p.replace(/\s/g, ""))));
        const value = Number(price.replace(/\s/g, ""));
        if (amounts.some((a) => amounts.some((b) => a - b === value))) continue;
        problems.push(`${price.trim()} kr står inte i källa [${refs.join(",")}]`);
      }
    }
    return problems;
  }

  it("answers the campaign conversations", async () => {
    const quality: Record<string, number> = {};
    const hard: string[] = [];
    const log: string[] = [];
    const turns: Turn[] = [];
    const pass = (name: string, ok: boolean) => {
      quality[name] = (quality[name] ?? 0) + (ok ? 1 : 0);
    };
    /** Broad answers: not cut off, compact, with sources. */
    const compact = (id: string, t: Turn) => {
      pass(`${id}: kapas inte`, !t.answer.includes("avbröts här"));
      pass(`${id}: kompakt (högst 550 ord)`, t.answer.split(/\s+/).filter(Boolean).length <= 550);
      pass(`${id}: har källhänvisningar`, t.cited.length > 0);
    };
    const must = (name: string, ok: boolean, detail = "") => {
      if (!ok) hard.push(`${name}${detail ? `: ${detail}` : ""}`);
    };
    const common = (t: Turn) => {
      turns.push(t);
      for (const p of citationProblems(t)) hard.push(`källhänvisning (${t.question.slice(0, 30)}…): ${p}`);
      must("utgånget dokument i kontexten", !t.context.some((c) => c.documentId === docs.expired));
      must("pris från utgånget dokument i svaret", !t.answer.includes(EXPIRED_DOCUMENT_PRICE));
      must("källmarkörer i historiken till modellen", !t.sentHistory.some((m) => m.role === "assistant" && /\[\d/.test(m.content)));
    };

    for (let run = 1; run <= RUNS; run++) {
      // 1–2: current campaigns for brand A, then a follow-up about families.
      {
        const rows: HistoryRow[] = [];
        const t1 = await ask(rows, "Finns det några aktuella bra kampanjer på Norrvik?");
        common(t1);
        must("1: bred fråga", t1.stats.scope === "broad");
        must("1: alla Norrviks aktuella kampanjsidor i kontexten", coverage(t1, [...NORRVIK]) === 4, `${coverage(t1, [...NORRVIK])}/4`);
        pass("1: nämner minst 3 av 4 Norrvik-modeller", mentioned(t1, [...NORRVIK]) >= 3);
        pass("1: avgör att kampanjerna gäller nu", !REFUSES_CURRENCY.test(t1.answer));
        pass("1: anger perioden", t1.answer.includes(CURRENT.to) || /31 december|t\.o\.m\.|till och med/i.test(t1.answer));
        pass("1: sommarkampanjen inte som aktuell", !presentsExpiredAsCurrent(t1.answer, EXPIRED_PRICE));

        const t2 = await ask(rows, "Vilken skulle du säga är mest attraktiv för en barnfamilj?");
        common(t2);
        must("2: följdfråga", t2.stats.followUp);
        const reread = t1.cited.filter((s) => t2.context.some((c, i) => t2.sources[i].id === s.id && c.reused)).length;
        must("2: förra svarets källor återhämtade", reread === t1.cited.length, `${reread}/${t1.cited.length}`);
        pass("2: rekommenderar Ås", has(t2.answer, "Ås"));
        pass("2: resonerar i stället för att avstå", !/styrker inte|kan inte rekommendera|saknar underlag för att (rekommendera|avgöra)/i.test(t2.answer));
        pass("2: hittar inte på bagagevolym", !/\d+\s*liter/i.test(t2.answer));
        pass("2: har källhänvisning", t2.cited.length > 0);
      }

      // 3: brand A against brand B.
      {
        const t3 = await ask([], "Ställ Norrviks och Solbergs kampanjer mot varandra och jämför rätt modeller.");
        common(t3);
        must("3: bred fråga", t3.stats.scope === "broad");
        must("3: båda dokumenten i kontexten", t3.stats.documents >= 2);
        must("3: kampanjsidor från båda märkena", coverage(t3, [...NORRVIK]) >= 3 && coverage(t3, [...SOLBERG]) >= 4, `${coverage(t3, [...NORRVIK])}/4, ${coverage(t3, [...SOLBERG])}/5`);
        compact("3", t3);
        pass("3: minst 3 modeller per märke", mentioned(t3, [...NORRVIK]) >= 3 && mentioned(t3, [...SOLBERG]) >= 3);
        pass("3: ställer SUV mot SUV (Ås och Polar)", has(t3.answer, "Ås") && has(t3.answer, "Polar"));
        pass("3: påstår inte att något underlag saknar kampanjer", !/(saknar|innehåller inga) (relevanta )?kampanj/i.test(t3.answer));
      }

      // 4: all campaigns.
      {
        const t4 = await ask([], "Jämför samtliga kampanjer mot varandra.");
        common(t4);
        must("4: bred fråga", t4.stats.scope === "broad");
        must("4: minst 8 av 9 kampanjsidor i kontexten", coverage(t4, ALL) >= 8, `${coverage(t4, ALL)}/9`);
        compact("4", t4);
        pass("4: nämner minst 7 av 9 modeller i den kompakta översikten", mentioned(t4, ALL) >= 7);
        pass("4: sommarkampanjen inte som aktuell", !presentsExpiredAsCurrent(t4.answer, EXPIRED_PRICE));
      }

      // 5: one detail is missing – mark it, compare the rest.
      {
        const t5 = await ask([], "Jämför räckvidd och bagagevolym för Norrvik Ås och Solberg Polar.");
        common(t5);
        pass("5: jämför räckvidden (520 och 540 km)", t5.answer.includes("520") && t5.answer.includes("540"));
        pass("5: anger Polars bagagevolym (560 liter)", t5.answer.includes("560"));
        pass("5: markerar att Ås bagagevolym saknas", MISSING.test(t5.answer));
        pass("5: hittar inte på bagagevolym för Ås", [...t5.answer.matchAll(/(\d[\d ]*)\s*liter/gi)].every((m) => m[1].trim() === "560"));
      }

      // 6: an expired campaign inside a current document.
      {
        const t6 = await ask([], "Vilka kampanjer gäller för Norrvik Fjord just nu?");
        common(t6);
        pass("6: nämner den aktuella kampanjen (3 495 kr)", t6.answer.includes("3 495"));
        pass("6: sommarkampanjen inte som aktuell", !presentsExpiredAsCurrent(t6.answer, EXPIRED_PRICE));
      }

      // 8: an earlier answer wrongly said a verified fact was missing, and the
      // latest answer was cut off without sources. Verified sources must win.
      {
        const src = (key: keyof typeof CAMPAIGNS): SourceReference => ({ id: String(chunkIds[key]), documentId: docs.norrvik, title: "Test – live Kampanjöversikt oktober", excerpt: "", location: null });
        const rows: HistoryRow[] = [
          { role: "user", content: "Vilka kampanjer finns på Norrvik?", sources: null },
          { role: "assistant", content: "Norrvik Ås har privatleasing 5 295 kr/mån [1]. Norrvik Fjord har 3 495 kr/mån [2].", sources: [src("as"), src("fjord")] },
          { role: "user", content: "Vilken passar en barnfamilj?", sources: null },
          { role: "assistant", content: "Jag behöver rätta mitt förra svar: underlaget styrker inte uppgifterna om Norrvik Ås. De ska inte ses som verifierade.", sources: [] },
          { role: "user", content: "Gör en lång jämförelse av allt", sources: null },
          { role: "assistant", content: `| Modell | Erbjudande |\n|---|---|\n| Fjord | 3 4${TRUNCATED_NOTE}`, sources: [] },
        ];
        const t8 = await ask(rows, "okej, jag vill jämföra samtliga kampanjer mot varandra");
        common(t8);
        must("8: Ås-sidan återhämtad trots två svar utan källor", t8.context.some((c, i) => t8.sources[i].id === String(chunkIds.as) && c.reused));
        pass("8: använder den verifierade Ås-uppgiften (5 295 kr)", t8.answer.includes("5 295"));
        pass("8: upprepar inte den felaktiga rättelsen", !/(styrker inte|inte (ses som )?verifierad|saknar|inte bekräfta)[^.|]{0,80}Ås|Ås[^.|]{0,80}(saknas|styrks inte|inte (ses som )?verifierad)|rätta mi(tt|na) (förra|tidigare) svar/i.test(t8.answer));
      }

      // 9: a section labelled with the current quarter keeps an older date,
      // while the document and its Q4 overview say the offers are current.
      {
        const t9 = await ask([], "Vilka privatleasingpriser gäller för Solberg just nu?");
        common(t9);
        pass("9: Polar och Ved redovisas (5 495 och 4 395 kr)", t9.answer.includes("5 495") && t9.answer.includes("4 395"));
        pass("9: avfärdar inte Q4-priserna som utgångna", !/(inte|ej) (som )?(ett |några )?(bekräftade?|aktuella?|giltiga?)[^.]{0,30}(Q4-?)?(pris|erbjudand)|använder (jag )?(därför )?inte (de|dessa) (priser|uppgifter)|inte (längre )?gäller/i.test(t9.answer));
        pass("9: nämner avvikelsen som kontrollpunkt", /lathund|äldre (datum|period)|motsäg|avvik|kontroll/i.test(t9.answer));
      }

      // 7: follow-up after an answer with several sources.
      {
        const rows: HistoryRow[] = [];
        const a = await ask(rows, "Vad kostar privatleasing för Norrvik Kust och Solberg Ved?");
        common(a);
        pass("7a: båda priserna", a.answer.includes("4 195") && a.answer.includes("4 395"));
        must("7a: källor från båda dokumenten", new Set(a.cited.map((s) => s.documentId)).size >= 2, `${a.cited.length} källor`);
        const b = await ask(rows, "Vilket av dem har ett serviceavtal som ingår, och vad ingår?");
        common(b);
        must("7b: följdfråga", b.stats.followUp);
        // The real chunks are re-read from the database, not the earlier answer.
        const { data: dbChunks } = await service().from("document_chunks").select("id, content").in("id", a.cited.map((s) => Number(s.id)));
        const dbContent = new Map(((dbChunks ?? []) as { id: number; content: string }[]).map((c) => [String(c.id), c.content]));
        for (const s of a.cited) {
          const i = b.sources.findIndex((x) => x.id === s.id);
          must("7b: tidigare källa återhämtad", i >= 0 && b.context[i].reused === true, s.id);
          if (i >= 0) must("7b: återhämtad text är dokumentets text", b.context[i].content === dbContent.get(s.id), s.id);
        }
        must("7b: tidigare svar skickas inte som källa", !b.context.some((c) => c.content === a.answer));
        pass("7b: nämner Service Plus för Ved", /Service Plus/i.test(b.answer));
        pass("7b: har källhänvisning", b.cited.length > 0);
      }
      log.push(`körning ${run} klar`);
    }

    // --- Report ----------------------------------------------------------------
    const avg = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1));
    const byScope = (scope: string) => turns.filter((t) => t.stats.scope === scope);
    const lines = [
      `=== Konversationsmedveten retrieval (${instructionSource} Säljinstruktion, ${resolveChatModel(null).id}, ${RUNS} körningar, dagens datum ${TODAY}) ===`,
      ...Object.entries(quality).map(([k, v]) => `${v >= RUNS - 1 ? "✓" : "✗"} ${k}: ${v}/${RUNS}`),
      "",
      `Kontext smal fråga: ${avg(byScope("focused").map((t) => t.stats.chunks))} textbitar, ${avg(byScope("focused").map((t) => t.stats.chars))} tecken, ${avg(byScope("focused").map((t) => t.usage?.inputTokens ?? 0))} tokens in`,
      `Output bred fråga: ${avg(byScope("broad").map((t) => t.usage?.outputTokens ?? 0))} tokens i snitt (max ${Math.max(...byScope("broad").map((t) => t.usage?.outputTokens ?? 0))}), varav resonemang ${avg(byScope("broad").map((t) => t.usage?.reasoningTokens ?? 0))}; kapade ${byScope("broad").filter((t) => t.answer.includes("avbröts här")).length}/${byScope("broad").length}; ${avg(byScope("broad").map((t) => t.answer.split(/\s+/).length))} ord i snitt`,
      `Output smal fråga: ${avg(byScope("focused").map((t) => t.usage?.outputTokens ?? 0))} tokens i snitt (max ${Math.max(...byScope("focused").map((t) => t.usage?.outputTokens ?? 0))})`,
      `Kontext bred fråga: ${avg(byScope("broad").map((t) => t.stats.chunks))} textbitar, ${avg(byScope("broad").map((t) => t.stats.chars))} tecken, ${avg(byScope("broad").map((t) => t.usage?.inputTokens ?? 0))} tokens in`,
      `Återhämtade källor i följdfrågor: ${avg(turns.filter((t) => t.stats.followUp).map((t) => t.stats.reused))} i snitt`,
      `Retrieval (embedding + sökning): ${avg(turns.map((t) => t.retrievalMs))} ms i snitt`,
      `Modellsvar: smal ${avg(byScope("focused").map((t) => t.modelMs))} ms, bred ${avg(byScope("broad").map((t) => t.modelMs))} ms i snitt`,
      `Kostnad: chatt ${usd.chat.toFixed(5)} USD, embeddings ${embeddingCostUsd(embeddingModel().id, usd.embeddingTokens).toFixed(6)} USD`,
      hard.length ? `Hårda fel:\n- ${[...new Set(hard)].join("\n- ")}` : "Hårda kontroller: alla godkända",
    ];
    console.log(lines.join("\n"));
    if (process.env.FOLKE_EVAL_OUT) {
      writeFileSync(
        process.env.FOLKE_EVAL_OUT,
        JSON.stringify({ summary: lines, turns: turns.map((t) => ({ question: t.question, stats: t.stats, answer: t.answer, cited: t.cited.map((s) => `${s.title} ${s.location}`) })) }, null, 2),
      );
    }
    expect([...new Set(hard)]).toEqual([]);
    expect(Object.entries(quality).filter(([, v]) => v < RUNS - 1).map(([k]) => k)).toEqual([]);
  }, 1_800_000);
});
