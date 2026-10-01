# MVP 0.3 – plan: OpenAI och semantisk sökning

**Status:** förslag för gemensam genomgång. Inget är implementerat. Ingen API-nyckel finns och inga AI-anrop görs.
**Underlag:** OpenAI:s API-dokumentation, läst 2026-10-01 ([data controls](https://developers.openai.com/api/docs/guides/your-data), [modeller](https://developers.openai.com/api/docs/models), [priser](https://developers.openai.com/api/docs/pricing), [embeddings](https://developers.openai.com/api/docs/guides/embeddings)). Uppgifterna ska bekräftas mot avtal och aktuell dokumentation innan beslut. Punkter markerade **⚠ Öppet** är inte verifierade.

---

## 1. Mål

1. Riktiga svar från en språkmodell i stället för mockläget, med samma säkerhetsmodell.
2. Sökning som hittar rätt avsnitt även när frågan använder andra ord än dokumentet (semantisk sökning).
3. Källhänvisningar till rätt dokument och rätt avsnitt.
4. Kontrollerade kostnader och full spårbarhet per användare och assistent.

## 2. OpenAI med europeisk datalagring

### Vad dokumentationen säger

| Fråga | Enligt OpenAI:s dokumentation |
|---|---|
| Hur aktiveras det? | Per **projekt** i API-organisationen, där regionen Europa väljs. Anropen går till `eu.api.openai.com`. |
| Lagring och behandling | För bland annat `/v1/responses`, `/v1/chat/completions` och `/v1/embeddings` anges både **regional lagring och regional behandling** i EU. |
| Undantag | `/v1/vector_stores`, `/v1/assistants` och `/v1/fine_tuning/jobs`: **endast lagring** i EU, inte behandling. Utökad promptcache i regioner utan regional behandling kan innebära behandling utanför regionen. *Fast mode* finns inte med EU-datalagring. |
| Förutsättningar | Kräver godkännande och tilläggsavtal: Zero Data Retention eller Modified Abuse Monitoring (eller motsvarande) samt ett *Modified Retention amendment*. |
| Pris | **+10 %** för regional behandling, för modeller som släppts 2026-03-05 eller senare |
| Träning | API-data används inte för att träna OpenAI:s modeller |
| Standardlagring | Missbruksövervakning sparar data i 30 dagar, om inte ZDR eller modifierad övervakning är avtalad |

### Hur Folke använder det

- **Endast** `/v1/responses` (svar) och `/v1/embeddings` (sökning). **Inte** OpenAI:s vector stores, assistants eller fil-API:er, eftersom dessa bara lagras i EU men behandlas utanför. Dokument och vektorer stannar i Supabase (Stockholm).
- Alla anrop görs från servern (Vercel- eller Node-funktion) mot `eu.api.openai.com`. Webbläsaren pratar aldrig med OpenAI.
- Ingen promptcache med utökad lagring. Ingen webbsökning eller andra verktyg som skickar data vidare.
- Säkerhetsloggen visar vilken modell som användes per svar (`ai_usage`), men aldrig innehåll.

### ⚠ Öppet – måste verifieras innan verkliga data skickas

1. Att Börjessons (organisationen) godkänns för EU-datalagring och ZDR eller modifierad missbruksövervakning, och vilket avtal som tecknas (DPA och Modified Retention amendment).
2. Att de **modeller vi väljer** omfattas av regional behandling. Dokumentationen listar endpoints men kan undanta enskilda modeller och funktioner.
3. Var eventuell **missbruksövervakning med mänsklig granskning** sker, och vilka underbiträden som anlitas.
4. Om tredjelandsöverföring kan ske i undantagsfall (t.ex. support och incidenthantering), och vilken överföringsmekanism som gäller.
5. Att OpenAI:s EU-endpoint inte kräver något som vi inte får skicka, till exempel användaridentiteter. Vi skickar ett pseudonymt `user`-id (hash), aldrig namn eller e-post.

**Beslut som krävs:** godkännande av OpenAI som personuppgiftsbiträde för Folke, efter punkterna ovan. Tills dess förblir `FOLKE_AI_PROVIDER=mock`.

## 3. Modellval per assistent

En gemensam provider och en modell per assistent, som konfigureras i databasen (`assistants.model`) och endast kan ändras av en administratör.

| Assistent | Förslag | Motivering |
|---|---|---|
| Säljassistenten | `gpt-6.1-sol` | Bra svenska i kundtexter, rimlig kostnad |
| Analysassistenten | `gpt-6.1-sol` (pilot) och `gpt-6-astra` vid behov | Kräver noggrann sifferhantering. Astra kostar cirka 5 gånger mer. |
| Mötesassistenten | `gpt-6-luna` | Strukturering och sammanfattning, stora volymer |
| Garantiassistenten | `gpt-6.1-sol` | Precision i villkorstolkning |
| Embeddings | `text-embedding-3-small` med 1 536 dimensioner | Låg kostnad. Stöd för svenska bör verifieras i ett eget test (⚠). |

Modellnamnen är de som finns i dokumentationen 2026-10-01. De ska ses som utgångsläge och utvärderas med en **svensk testsvit** (avsnitt 7) innan beslut.

## 4. RAG och semantisk sökning

### Varför fulltextsökningen inte räcker

Fulltextsökningen (svensk stemming, `ts_rank_cd`) hittar bara ord som finns i dokumentet. "Vilket hemligt namn har projektet?" hittar inte "kodordet är Blå Ekorre". Aurora-observationen visade dessutom att utdraget togs från textbitens början. Det är nu rättat med `ts_headline`, men själva **återvinningen** är fortfarande ordberoende.

### Föreslagen lösning: hybridsökning i Supabase

```
Fråga ─► embedding (EU) ─┐
                          ├─► SQL-funktion som SECURITY INVOKER (RLS gäller per rad)
Fråga ─► tsquery ────────┘     1. kandidater: vektor-kNN (top 40) ∪ fulltext (top 40)
                               2. FILTER: godkänd, bearbetad, giltig idag,
                                  delad med användarens grupper, kopplad till assistenten
                               3. Rangordning: Reciprocal Rank Fusion (RRF)
                               4. top 6–8 textbitar ─► prompt ─► modell (EU)
```

- **pgvector** i samma databas: `document_chunks.embedding halfvec(1536)` med HNSW-index. `halfvec` halverar lagringen.
- **Behörighetsfiltret sker i databasen innan något lämnar den.** Funktionen är `SECURITY INVOKER`, så RLS på `documents` och `document_chunks` (`app.can_search_document`) tillämpas på varje kandidat. Otillåtna textbitar når aldrig appservern och därmed aldrig modellen. Det är samma mönster som `search_document_chunks` i dag, och det testas redan (RLS- och livetester).
- Eftersom HNSW körs före RLS-filtret kan för få träffar återstå när en användare har snäv behörighet. Lösning: hämta fler kandidater (`ef_search`, top 40) och komplettera med fulltext. Med pilotens volymer (tusentals, inte miljoner, textbitar) är detta ingen begränsning, och vid behov kan filtrerad sökning eller partitionering per samling införas.
- **Textbitar:** cirka 800–1 200 tecken med överlapp (som i dag), kopplade till sida, flik eller bild. Rubriker bör läggas till i varje textbit för att förbättra både embedding och citering.
- **Källor:** varje textbit numreras `[n]` i prompten. Svaret valideras efteråt (bara `[n]` som finns), och källkortet visar `ts_headline`-utdraget eller embedding-träffens textbit.

### Omindexering

| Händelse | Åtgärd |
|---|---|
| Uppladdning | Textutvinning → textbitar → embeddings (bakgrundsjobb). Status `processing` → `ready`. |
| Godkännande, avvisning, arkivering, giltighet | **Ingen** omindexering. Filtren i SQL avgör sökbarheten direkt (fungerar redan i dag). |
| Ändrad delning eller assistentkoppling | Ingen omindexering. RLS och join avgör direkt. |
| Ny version av dokument | Nya textbitar och embeddings. Gamla tas bort i samma transaktion. |
| Byte av embedding-modell | Ny kolumn eller tabell, omindexering i bakgrunden, därefter byte. Kolumnen `embedding_model` sparas per textbit. |
| Borttaget dokument | Kaskad: textbitar och embeddings försvinner med dokumentet (fungerar i dag) |

Embeddings skapas av servern med den hemliga nyckeln, på samma sätt som textbitar i dag. Användare kan inte skriva dem.

## 5. Gemensam grund för assistenterna

Redan i dag finns en gemensam kedja: `AIProvider`, `/api/chat`, prompt, sökning, sparande och kostnad. Utbyggnaden:

1. `src/server/ai/providers/openai.ts`: implementerar `AIProvider` med Responses API och streaming. Rapporterar `usage` och modell.
2. Konfiguration per assistent i databasen: `model`, `max_output_tokens`, `temperature` (om modellen stöder det) och `retrieval_k`. Instruktionerna finns redan.
3. Prompten byggs som i dag (`buildSystemPrompt`). Källor markeras som data, och dokumenttext neutraliseras. Den återstående risken för promptinjektion hanteras med utdataregler (inga verktyg, ingen webb, ingen åtkomst till annat än kontexten).
4. Ingen kod per assistent. Skillnaderna består av data (instruktioner, modell, samlingar och behörighet).

## 6. Nycklar, åtkomst och kostnadskontroll

- **Nyckel:** ett separat OpenAI-projekt för Folke i EU-regionen, med en *project key* som är begränsad till de endpoints vi använder. Nyckeln läggs i miljövariabeln `OPENAI_API_KEY` på servern (Vercel och lokalt `.env.local`), aldrig i git, och roteras vid misstanke.
- **Budget:** månadsbudget och larm i OpenAI-projektet (hård gräns om möjligt) samt egen kontroll i Folke:
  - maximal promptstorlek (antal textbitar och längd på historik)
  - `max_output_tokens` per assistent
  - **gräns per användare och dygn** (antal svar eller kronor), räknad i `ai_usage`, med ett tydligt meddelande när gränsen nås
  - **rate limiting** på `/api/chat`
- **Uppföljning:** prislistan i `pricing.ts` fylls i (USD → SEK, inklusive 10 % EU-tillägg) och visas i "Användning och kostnad".

## 7. Kvalitet och test

- **Svensk testsvit** med 30–50 frågor per assistent mot syntetiska dokument, inklusive formuleringar som skiljer sig från dokumentets ord. Den mäter träffsäkerhet för källor (rätt dokument och avsnitt) och korrekta citat.
- **Säkerhetstester** som körs mot den riktiga kedjan:
  - promptinjektion i dokument (befintligt skydd plus nya testfall)
  - att modellen inte citerar källor den inte fått
  - att otillåtna dokument aldrig finns i prompten. Det testas genom att logga *dokument-id* (inte text) per anrop i testläge.
- **Mockprovidern ligger kvar** för utveckling och CI.

## 8. Kostnadsuppskattning

Antaganden för piloten: 10 användare × 20 frågor per arbetsdag × 22 dagar ≈ **4 400 svar per månad**. Per svar ungefär 4 500 tokens in (instruktioner, 6 textbitar, historik) och 500 tokens ut. Listpriser i USD per miljon tokens, plus 10 % EU-tillägg.

| Kostnadsdrivare | Beräkning | Ungefär per månad |
|---|---|---|
| Svar med `gpt-6.1-sol` | 4 400 × (4 500 × $2 + 500 × $10) / 1M × 1,1 | **≈ $68** |
| Svar med `gpt-6-luna` | 4 400 × (4 500 × $0,10 + 500 × $0,50) / 1M × 1,1 | ≈ $3 |
| Svar med `gpt-6-astra` (om allt) | 4 400 × (4 500 × $10 + 500 × $50) / 1M × 1,1 | ≈ $340 |
| Embeddings, indexering | 1 000 dokument × 5 000 tokens = 5M × $0,02 | ≈ $0,10 engångs |
| Embeddings, frågor | 4 400 × 50 tokens | < $0,01 |
| Omindexering vid modellbyte | samma som indexering | < $1 |
| Supabase Pro | Rekommenderas före pilot | $25 plus eventuell compute |
| Lagring (vektorer och filer) | 50 000 textbitar × 3 kB (`halfvec`) ≈ 150 MB | ryms i Pro |

**Slutsats:** det är svaren från språkmodellen som driver kostnaden. Embeddings och lagring är försumbara. Att börja med `gpt-6.1-sol` (och `gpt-6-luna` för Mötesassistenten) ger en pilotkostnad på ungefär 50–100 USD per månad. Vid 50 användare blir det ungefär 5 gånger mer. Promptcache sänker kostnaden för indata.

## 9. Etapper

| Steg | Innehåll | Kräver |
|---|---|---|
| 0.3a | Beslut och avtal: EU-datalagring, ZDR/MAM, DPA, OpenAI-projekt, budget | Börjessons beslut |
| 0.3b | pgvector-migration, embedding-jobb, hybridsökning bakom flagga (fulltext är fortfarande standard), tester | Utveckling med mock-embeddings, inget externt. Riktiga embeddings kräver 0.3a. |
| 0.3c | `openai`-provider, modell per assistent, kostnadsgränser och rate limiting, prislista | Nyckel från 0.3a |
| 0.3d | Svensk testsvit och utvärdering. Pilot med syntetiska dokument. | 0.3b–c |
| 0.3e | Godkännande av riktiga interna dokument | Godkänd databehandling |

**Rekommenderat första steg:** 0.3a (beslut och avtal) parallellt med 0.3b (pgvector och hybridsökning), som inte kräver någon leverantör och förbättrar sökningen även i mockläge.
