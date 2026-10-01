# Beslut

Korta beslutsposter i ADR-stil. Nya beslut läggs till sist. Ett beslut som ändras markeras som *Ersatt av ADR-xxx*.

---

### ADR-001 – Next.js 16 med App Router

**Beslut:** Next.js (App Router), React 19 och TypeScript i strict-läge.
**Motiv:** Serverkomponenter gör att data och behörighet kan hanteras på servern från början. Route handlers och server actions ger backend-for-frontend utan separat API-server. Förstklassigt stöd på Vercel.
**Konsekvens:** Next 16 kallar middleware för `proxy.ts`, och `params`/`searchParams` är promises. Läs `node_modules/next/dist/docs` vid osäkerhet (se AGENTS.md).

### ADR-002 – shadcn/ui (Radix) som komponentgrund

**Beslut:** shadcn/ui med Radix och förinställningen "Nova". Komponenterna ligger i `src/components/ui` och ägs av projektet.
**Motiv:** Tillgängliga primitiver utan inlåsning i ett tungt komponentbibliotek. Koden kan anpassas fritt.
**Konsekvens:** Anpassningar (tabell, overlay, Toaster) görs direkt i filerna. Om shadcn-CLI:n körs igen med `--overwrite` måste de göras om.

### ADR-003 – Tailwind CSS 4 med tokens i CSS

**Beslut:** Designtokens definieras i `globals.css` (`@theme`) i två nivåer: varumärkesskalor och semantiska tokens.
**Motiv:** En plats för paletten. Komponenter refererar semantiska namn.

### ADR-004 – Endast ljust tema i etapp 1

**Beslut:** Mörkt tema byggs inte nu. `next-themes` är borttaget.
**Motiv:** Kravet är vit eller mycket ljus bakgrund. Ett halvfärdigt mörkt tema skulle behöva underhållas utan att användas.
**Konsekvens:** Tokens är semantiska, så ett mörkt tema kan läggas till senare utan att komponenterna ändras.

### ADR-005 – Serverlager med `server-only` och repositories

**Beslut:** All dataåtkomst går via `src/server/data/*`. I etapp 1 läser funktionerna från mockdata.
**Motiv:** Frontenden behöver inte skrivas om när databasen kopplas in, och data kan inte av misstag läcka till klientbundlen.

### ADR-006 – Sessionsgränssnitt utan skenbar autentisering

**Beslut:** `getSession()` returnerar en uttryckligen märkt demoanvändare (`isPrototype: true`). Inloggningsformuläret skickar ingenting och är tydligt märkt som prototyp.
**Motiv:** Ingen egen auth ska byggas, och inget får se ut som ett säkerhetsskydd det inte är. Gränssnittet finns ändå, så att sidorna redan är skrivna mot det riktiga mönstret.

### ADR-007 – Separat assistentåtkomst och dokumentåtkomst

**Beslut:** Roller, assistenttilldelning (grants till användare eller grupp) och dokumentsynlighet är tre separata begrepp (`lib/domain`).
**Motiv:** Kravet att behörighet till assistenter och till dokument ska vara separata. Retrieval måste filtrera på båda.

### ADR-008 – Leverantörsneutral AI-abstraktion och NDJSON-protokoll

**Beslut:** Ett eget `AIProvider`-gränssnitt och ett eget strömprotokoll (`sources`/`text`/`done`/`error` som NDJSON).
**Motiv:** AI-leverantören är inte vald. Protokollet är litet och lätt att förstå.
**Alternativ:** Vercel AI SDK, som stöder många leverantörer och har färdiga UI-hooks. Den är en stark kandidat att *implementera* `AIProvider` med när leverantören är vald. Om AI SDK:s UI-protokoll tas i bruk ersätts `lib/chat/*` och `useChat`.

### ADR-009 – Inter via `next/font`

*Ersatt av ADR-013.*

**Beslut:** Inter laddas med `next/font/google`, som hämtar filerna vid build och sedan serverar dem från den egna domänen.
**Konsekvens:** Builden kräver nätverksåtkomst till Google Fonts. Om det är ett problem kan `@fontsource-variable/inter` användas i stället.

### ADR-010 – Svenska i gränssnittet, engelska i koden

**Beslut:** All användarsynlig text är på svenska och samlas i komponenter eller `lib/domain/labels.ts`. Ingen i18n-ram införs nu.
**Motiv:** Endast svenska användare. Ett i18n-bibliotek kan införas senare om behovet uppstår.

### ADR-011 – Prompt från startsidan via sessionStorage

**Beslut:** Snabbstarten lägger prompten i `sessionStorage` i stället för i URL:en.
**Motiv:** Användartext ska inte hamna i webbläsarhistorik, delade länkar eller serverloggar.
**Ersätts av:** en server action som skapar konversationen, när persistens finns.

### ADR-012 – Markdown utan rå HTML

**Beslut:** Assistentsvar renderas med `react-markdown`, `remark-gfm` och `remark-breaks`. Rå HTML renderas inte.
**Motiv:** Modellutdata ska aldrig kunna injicera markup eller skript.

### ADR-013 – Geist Sans som primärt typsnitt

**Beslut:** Geist Sans ersätter Inter i hela gränssnittet. Geist Mono används för monospace, till exempel kod. Båda laddas med `next/font/google` och kopplas centralt via `--font-sans`, `--font-heading` och `--font-mono` i `globals.css`.
**Konsekvens:** Storlekar, vikter, radavstånd och övrig design är oförändrade. De Inter-specifika OpenType-inställningarna (`cv11`, `ss01`) togs bort, eftersom de betyder något annat i Geist. Builden kräver fortfarande nätverksåtkomst till Google Fonts.

### ADR-014 – Supabase i Stockholm som backend

**Beslut:** Supabase (PostgreSQL, Auth och Storage) i regionen North EU (Stockholm) för databas, autentisering och filer.
**Motiv:** Fastställt beslut om databas i Sverige. En plattform för data, auth och lagring med RLS i databasen.

### ADR-015 – Behörighet i databasen (RLS) som sista skyddslinje

**Beslut:** Alla tabeller har RLS via hjälpfunktioner i det privata schemat `app`. Varje policy kräver `app.authorized()`, det vill säga en aktiv profil, `aal2` och en session yngre än 7 dagar. Kolumnskydd (roll, status, bearbetning och granskning) görs med triggers. Instruktionskolumnen är inte beviljad till API-rollen.
**Motiv:** Säkerheten får inte bero på att varje rad applikationskod är korrekt.
**Konsekvens:** Nya tabeller måste få RLS och tester i `tests/db`. `INSERT … RETURNING` kräver att den nya raden är läsbar direkt i policyn (se `documents_select`).

### ADR-016 – Användarens klient som standard, hemlig nyckel som undantag

**Beslut:** Repositories och actions använder användarens Supabase-klient. Adminklienten används bara för inbjudan, spärr, TOTP-återställning, lagring, textbitar, kostnadslogg och säkerhetslogg, och först efter behörighetskontroll.
**Motiv:** Triggers loggar rätt aktör, och ett fel i applikationskoden kan inte kringgå RLS.

### ADR-017 – Inbjudan och onboarding

**Beslut:** Endast inbjudan (öppen registrering av). E-postlänkar verifieras på servern (`/auth/confirm` med `token_hash`). Kontot blir aktivt först efter första TOTP-verifieringen. Den första administratören skapas med `npm run bootstrap:admin`.

### ADR-018 – 7-dagarssessioner i tre lager

**Beslut:** Sessionsstarten räknas från den tidigaste `amr`-tidsstämpeln och kontrolleras i `getSession()` och i RLS (`app.session_fresh()`). Kontrollen misslyckas stängt. Med Pro sätts även Auth time-box till 168 h.
**Motiv:** Gränsen ska gälla oavsett Supabase-plan och även för direkta API-anrop.

### ADR-019 – Fulltextsökning (svenska) före vektorsökning

**Beslut:** Dokumentsökning med PostgreSQL:s svenska fulltextsökning (`tsvector`, GIN och `ts_rank_cd`) i en SECURITY INVOKER-funktion.
**Motiv:** Kräver ingen embedding-leverantör (ingen är godkänd), och ingen dokumenttext lämnar systemet. RLS gäller per rad. pgvector kan läggas till senare.

### ADR-020 – Server äger chatthistoriken

**Beslut:** Klienten skickar bara det nya meddelandet. Servern sparar, läser historiken, söker och sparar svaret med källor, även vid avbrott. Protokollet har fått händelsen `conversation`.
**Motiv:** Förhindrar förfalskad historik. Konversationen får sin URL så fort den skapats.

### ADR-021 – Mock-provider som citerar källor

**Beslut:** Mock-providern svarar genom att citera de mest relevanta utdragen med `[n]`. Ingen extern AI anropas förrän en leverantör är godkänd.
**Motiv:** Hela kedjan kan testas utan att data lämnar systemet.

### ADR-022 – Dokumentgranskning per ägargrupp och intygande

**Beslut:** Dokument ägs av en grupp, delas som standard med den och kan delas med fler grupper. Endast systemadministratörer och ägargruppens ansvariga granskar. Under piloten måste uppladdaren intyga att dokumentet är internt och saknar kunduppgifter.

### ADR-023 – Egen läsning av Excel och PowerPoint

**Beslut:** `.xlsx` och `.pptx` läses som ZIP/XML med `jszip`, i stället för med `exceljs`.
**Motiv:** `exceljs` drar in en sårbar version av `uuid`. Textutvinning kräver inte ett fullständigt kalkylbibliotek.

### ADR-024 – PGlite för RLS-tester

**Beslut:** RLS testas med de riktiga migrationerna i PGlite och en minimal emulering av Supabases `auth`-schema.
**Motiv:** Snabba och deterministiska tester utan Docker. Auth, Storage och PostgREST verifieras separat mot ett riktigt projekt.

### ADR-025 – Explicita tabellbehörigheter för API-rollerna

**Beslut:** Tabellbehörigheter för `authenticated` och `service_role` ges explicit i migrationer (`20261001120000_api_grants.sql`), med kolumnbehörigheter där det behövs. `anon` får inga.
**Motiv:** Supabase-projektet ger inga automatiska behörigheter på nya tabeller. Upptäcktes när `bootstrap:admin` fick `permission denied`. RLS avgör fortfarande vilka rader som nås.
**Konsekvens:** Testmiljön (PGlite) ger inte heller några automatiska behörigheter, så saknade grants fångas av `npm run test:db`.

### ADR-026 – Frågestyrda utdrag i sökningen

**Beslut:** `search_document_chunks` returnerar ett utdrag (`ts_headline`) runt de matchande orden, och det används i källkort och mocksvar (migration `20261002090000`).
**Motiv:** Aurora-testet visade början av textbiten i stället för avsnittet med svaret. Korta dokument blir en enda textbit, så utdraget måste väljas utifrån frågan.

### ADR-027 – Åtkomst kräver registrerad TOTP

**Beslut:** `app.authorized()` kräver även `profiles.mfa_enrolled_at` (migration `20261002100000`). Administratörens TOTP-återställning nollställer den.
**Motiv:** Vid förlorad eller stulen telefon måste befintliga sessioner sluta fungera direkt, inte först när token löper ut.

### ADR-028 – Webbhärdning: CSP med nonce och httpOnly-cookies

**Beslut:** Proxyn sätter en strikt CSP (skript bara med nonce, `frame-ancestors 'none'`, `connect-src` endast den egna domänen och Supabase). Sessionscookies är `httpOnly`, `SameSite=Lax` och `Secure` över HTTPS, med en livslängd på 7 dagar. Alla sidor renderas dynamiskt.
**Motiv:** Folke ska visa modellutdata och dokumenttext. XSS ska varken kunna köra skript eller stjäla sessioner.
**Konsekvens:** Inline-skript kräver nonce. `style-src` tillåter inline-stilar för UI-komponenternas style-attribut.

### ADR-029 – Livetester mot Supabase med syntetiska användare

**Beslut:** Säkerhetskritiska regler testas även mot det riktiga projektet (`npm run test:live`) med syntetiska användare som skapas och tas bort i testet. Säkerhetsloggen lämnas orörd.
**Motiv:** PGlite emulerar inte Auth, Storage eller PostgREST. Skillnader (som saknade grants) ska upptäckas av tester, inte av användare.
**Konsekvens:** Testerna kräver `.env.local` och körs manuellt före releaser. På sikt ska de köras mot ett separat testprojekt.

### ADR-030 – Ingen automatisk permanent radering

**Beslut:** Gallring av konversationer startas manuellt av administratör (minst 12 månaders inaktivitet). Inaktiverade konton, säkerhetslogg och kostnadsstatistik raderas inte automatiskt.
**Motiv:** Det finns inget beslut om automatisk radering. Lagringstider för logg och statistik samt rutin för att radera konton är öppna beslut.

### ADR-031 – Dataspärr: endast syntetiska data till extern AI

**Beslut:** OpenAI får bara ta emot syntetiska testdokument och syntetiska testkonversationer, både för embeddings och svar. Spärren avgörs av data som användare inte kan ändra: dokumentets dataklass (bara servern sätter den, och den kan aldrig ändras), konversationens dataklass (kräver AI-testbehörighet och kan aldrig ändras), AI-testbehörigheten (bara systemadministratör) och servermiljön. En slutkontroll körs före varje anrop, och en trigger stoppar embeddings för andra dokument. Klassen `approved` är reserverad för ett framtida godkännandeflöde men nekas.
**Motiv:** Leverantörsavtal och behandling av intern information är inte godkända. Flera oberoende lager gör att ett enskilt fel inte räcker för att data ska läcka.

### ADR-032 – OpenAI via Responses API, utan lagring och utan omförsök

**Beslut:** Officiell SDK, Responses API med strömning, `store: false`, `max_output_tokens`, pseudonym `safety_identifier` och `maxRetries: 0`. Inga verktyg, inga vector stores och inga filuppladdningar. Dokument och vektorer lagras bara i Supabase. Endast endpointen `api.openai.com` eller `eu.api.openai.com` (den senare bara med godkänd regional åtkomst).
**Motiv:** Minsta möjliga data hos leverantören och full kontroll över behörigheter i databasen. Omförsök kan dubblera kostnad och svar. Användaren försöker själv igen.

### ADR-033 – Modellval per assistent i databasen, mot en central katalog

**Beslut:** Tillåtna modeller, med verifierat pris och tillgänglighet, finns i `src/server/ai/models.ts`. Systemadministratören väljer modell per assistent i `/admin/ai`. Valet sparas i `assistants.ai_model` och kontrolleras mot katalogen vid varje anrop, och okända värden ger standardmodellen. Miljövariabeln `FOLKE_CHAT_MODELS` kan bara begränsa katalogen. Standard är den billigaste modellen (`gpt-6-luna`), och `gpt-6.1-sol` är det avancerade alternativet. Svenska kvalitetstester (`npm run test:ai-eval`) avgör om en assistent behöver det avancerade alternativet.
**Motiv:** Byten utan driftsättning, men inga ogranskade modeller och inga nya endpoints. Samma begränsningar (spärr, budget, maxlängd) gäller alla modeller.
**Resultat 2026-10-01:** Båda modellerna klarade 21 av 21 svenska fall. `gpt-6-luna` kostade 0,002 USD och `gpt-6.1-sol` 0,049 USD för samma fall, och luna var cirka 2,3 gånger snabbare. Standard för alla fyra assistenter: `gpt-6-luna`. Mötesassistenten följde mallen (sammanfattning, beslut, åtgärdstabell) fullständigare med sol och är kandidat för en uppgradering om fullständiga protokoll efterfrågas.

### ADR-034 – Hybridsökning med pgvector i Supabase

**Beslut:** `halfvec(1536)` med HNSW-index (cosinus) i `document_chunks` och `text-embedding-3-small`. Svensk fulltext och vektorlikhet slås ihop med reciprocal rank fusion i en SECURITY INVOKER-funktion, så att RLS gäller varje rad. Vektorer jämförs bara när de skapats med samma modell som frågan. Utan vektor faller sökningen tillbaka på fulltext. Ersätter ADR-019 för syntetiska data. Interna dokument har inga vektorer.
**Motiv:** Semantiska frågor ("hur långt kommer den billigaste versionen") hittas, utan extern vektortjänst, och med samma behörighetsmodell som tidigare.

### ADR-035 – Kostnadskontroll i databasen

**Beslut:** `ai_usage` registrerar typ (chatt eller embedding), tokens, cachade tokens, kostnad i USD (och SEK enligt kurs i miljön) samt om värdena är uppskattade. `ai_begin_request` kontrollerar atomiskt budget per användare och dag, månadsbudget, samtidighet och frågor per minut innan ett externt anrop görs.
**Motiv:** OpenAI-projektets budget är ingen garanterad hård gräns. Ett pågående anrop kan överskrida gränsen marginellt, men det begränsas av `max_output_tokens`.

---

## Öppna beslut

| Fråga | Alternativ | Att väga in |
|---|---|---|
| **AI-leverantör för intern information** | OpenAI (används nu bara med syntetiska data, ADR-031) | Juridisk motpart, DPA, EU-dataresidens och regional behandling, underbiträden, loggning och lagring (ZDR/MAM). Se [SECURITY.md](SECURITY.md#extern-ai-openai). |
| **Lagringstid för säkerhetslogg och kostnadsstatistik** | t.ex. 12–24 månader | Krav på spårbarhet kontra minimering |
| **Radering av konton** | Manuell rutin, alternativt automatiskt efter X månader som inaktiverat | Dokument som personen laddat upp måste flyttas först |
| **Embeddings för interna dokument** | pgvector i Supabase (byggt, ADR-034) | Kräver godkänd leverantör och godkännandeflöde. Interna dokument använder fulltext tills dess. |
| **OCR för skannade PDF:er** | Lokal OCR, alternativt tjänst | Skannade dokument ger ingen text i dag och markeras som fel vid bearbetning |
| **Supabase-plan** | Free (nu) eller Pro | Pro rekommenderas före pilot: time-box för sessioner, skydd mot läckta lösenord, säkerhetskopior |
| **SSO** | E-post + lösenord + TOTP (planerat), eventuellt Microsoft Entra ID senare | Befintlig identitetsplattform hos Börjessons |
| **E2E-tester** | Playwright mot en test-databas i Supabase | Efter att projektet skapats |
