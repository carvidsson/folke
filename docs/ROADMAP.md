# Roadmap

## Etapp 1 – Frontendprototyp ✅

Designsystem, alla vyer, navigering, domänmodell och AI-abstraktion med mock-provider. Se git-historiken (`feat: initial Folke frontend prototype`).

## MVP 0.2 – Riktig backend ✅ verifierad 2026-10-01

Detaljerad verifiering finns i [SETUP.md](SETUP.md#2-verifierat-mot-den-riktiga-backenden).

| Del | Status |
|---|---|
| 1. Supabase-grund: schema, RLS, triggers, explicita behörigheter, migrationer | ✅ Verifierat live (23 API-tester) |
| 1. Inloggning: inbjudan, lösenord, obligatorisk TOTP, återställning, 7-dagarssessioner | ✅ Verifierat i webbläsare och live |
| 2. Användaradministration: inbjudan, roller, inaktivering, TOTP-återställning, grupper, behörigheter | ✅ Verifierat. Ändringar gäller direkt för inloggade användare. |
| 3. Dokument: alla format, felaktiga filer, granskning, delning, giltighet, nedladdning | ✅ Verifierat |
| 4. Chatt med källor, historik, borttagning | ✅ Verifierat i mockläge · ⛔ ingen AI-leverantör godkänd |
| 5. Kostnadsuppföljning, säkerhetslogg, gallring | ✅ Verifierat |
| Säkerhetshärdning (CSP, httpOnly, MFA-krav i RLS) | ✅ Verifierat |

### Kvar inom MVP 0.2

- Mejlleverans till en riktig kollegas inkorg (pilotstart)
- Prova på mobil med riktiga data
- Beslut om lagringstider och radering av konton (DECISIONS)
- ~~Commit av MVP 0.2-koden till git~~ ✅ `v0.2.0`

## MVP 0.3 – OpenAI med syntetiska data och semantisk sökning (under utveckling)

| Del | Status |
|---|---|
| Dataspärr: dataklasser, AI-testbehörighet, slutkontroll, embeddings-trigger (ADR-031) | ✅ Byggt och testat (PGlite och enhetstester) |
| OpenAI-provider: Responses API, strömning, `store: false`, felhantering (ADR-032) | ✅ Byggt och testat (fejkad klient och riktiga anrop) |
| Modellkatalog och modellval per assistent i admin (ADR-033) | ✅ Byggt. Standard `gpt-6-luna` enligt svenska kvalitetstester. |
| pgvector och hybridsökning (ADR-034) | ✅ Byggt och testat i PGlite |
| Kostnad, budgetar, rate limiting och samtidighet (ADR-035) | ✅ Byggt och testat i PGlite |
| Källkontroll, historikfilter och skydd mot injektion | ✅ Byggt och testat, även med riktiga anrop |
| Svensk kvalitetssvit (21 fall, `npm run test:ai-eval`) | ✅ Båda modellerna 21/21 |
| Separat Supabase-utvecklingsprojekt `folke-dev` (Stockholm) | ✅ Skapat, alla 9 migrationer körda |
| Livetester mot `folke-dev` | ✅ 31/31 (varav 8 för AI-spärren) |
| Webbläsartest av hela AI-flödet med syntetisk administratör | ✅ 51/51 kontroller (SETUP.md avsnitt 10) |
| Migration i pilotprojektet | ⏳ Väntar på godkännande |
| Avtal och godkännande för intern information | ⛔ Öppet (SECURITY.md) |

Bakgrund och ursprunglig plan: [MVP-0.3-PLAN.md](MVP-0.3-PLAN.md).

## Riktiga dokument med OpenAI i folke-dev ✅ verifierat 2026-10-01

| Del | Status |
|---|---|
| Godkännande per dokument, återkallelse och indexeringsstatus (ADR-036) | ✅ PGlite, live och webbläsare |
| Vanliga konversationer med OpenAI och godkända dokument, utan val av läge för användaren | ✅ |
| Källhänvisning till rätt dokument och sida | ✅ |
| Ändra assistenter för ett befintligt dokument | ✅ |
| Chatthistorik: byt namn, radera en eller flera med bekräftelse | ✅ |
| Pilotprojektet | Oförändrat (mockläge) |

## AI-instruktioner (version 1) ✅ verifierat i folke-dev 2026-10-01

| Del | Status |
|---|---|
| Gemensamma instruktioner, med den tidigare hårdkodade tonregeln som standard | ✅ |
| Assistentspecifika instruktioner, versionshistorik och återställning | ✅ |
| Förhandsgranskning av den sammansatta instruktionen | ✅ |
| Fasta regler för källor och säkerhet visas skrivskyddade | ✅ |
| Datamodell för personliga preferenser och koppling till prompten | ✅ Förberett (inga användare har preferenser ännu) |
| Utkast och publicering med konfliktskydd, säker återställning | ✅ PGlite, live och webbläsare |
| Jämförelse publicerat mot utkast med riktig OpenAI | ✅ Samma modell, fråga och underlag. Underlaget visas. |
| Preferensernas effekt mätt med riktiga anrop | ✅ Utförligt mot kort: +85 % (sälj) och +31 % (garanti) i värsta fallet |
| Källhänvisningar numreras om så att de matchar källkorten | ✅ |
| Förtydligade fasta regler för källor och dokumentinnehåll (ADR-039) | ✅ Webbsökning är inte aktiverad |
| Test av publicerade instruktioner med riktig OpenAI | ✅ Fakta, källor, säkerhet och struktur i alla körningar. Kvarstår några stilavvikelser (ADR-039). |
| LaTeX-avgränsare i svar visas som vanlig text | ✅ |
| Kundtexter utan källmarkörer, med "Underlag för medarbetaren" (ADR-040) | ✅ |
| Justerade instruktioner för Sälj (vi-form, källor i kundtexter) och Analys (beräkningar, Förslag) | ✅ Publicerade via utkast |
| **Version 1 av AI-instruktionssystemet** | ✅ Klar |

## Version 2: personlig introduktion och Mina AI-inställningar (utvecklad i folke-dev, granskas)

| Del | Status |
|---|---|
| Val vid inbjudan, frivillig introduktion (Kom igång, Senare, Hoppa över) | ✅ |
| Svarslängd och skrivstil via färdiga exempel, snabbval, egna önskemål och skrivexempel | ✅ |
| Direkt förhandsgranskning utan AI-anrop | ✅ |
| Mina AI-inställningar: ändra, återställ, starta om introduktionen | ✅ |
| Valfritt AI-test: sparade mot föreslagna inställningar | ✅ |
| Kort introduktion till Folke | ✅ |
| Effekt och säkerhet mätt med riktiga anrop (ADR-041) | ✅ |

## Konversationsmedveten retrieval ✅ i betan 2026-10-02

| Del | Status |
|---|---|
| Följdfrågor söks med föregående fråga, och förra svarets källor läses om (ADR-042) | ✅ PGlite, enhetstester och utvärdering |
| Större urval för breda frågor och spridning mellan dokument | ✅ |
| Dokumentmetadata och dagens datum i prompten | ✅ |
| Fasta regler: resonemang och delvisa svar, aldrig nya faktauppgifter | ✅ |
| Säljassistentens nya instruktion (jämförelser, luckor, giltighet) | ✅ Publicerad i betan (folke) · utkast i folke-dev |
| Migration `20261007090000_retrieval_context.sql` | ✅ folke-dev och folke |
| Efter betatest (ADR-043): källor före tidigare påståenden, källor från två svar | ✅ |
| Giltighet i flera nivåer, kontrollpunkt vid motsägelse | ✅ |
| Kompakta breda svar, output-tak 2 000 tokens, tydligare meddelande vid kapning | ✅ |
| Chatten scrollar inte längre förbi slutet | ✅ Webbläsartest |
| Tidigare bedömningar är inte bindande, stegvis giltighet med kvartal, Säljinstruktion v4 (ADR-044) | ✅ Realistiskt test 5/5, även med felaktig historik |
| Resonemangsnivå utvärderad: `low` behålls, `FOLKE_AI_REASONING_EFFORT` för mätningar | ✅ |

## Konversationsbilagor (ADR-045) – i folke-dev, granskas

| Del | Status |
|---|---|
| Datamodell, privat bucket, RLS och borttagningskö | ✅ Migration `20261008090000` i folke-dev · PGlite 13, live 7 |
| Uppladdning, bearbetning, inklistring, status, miniatyrbilder, panelen Bilagor | ✅ Webbläsartest 20/20 |
| Dokument, bilder och inskannade PDF:er i svaren, källhierarki mot kunskapsbanken | ✅ Utvärdering 15/15 i 3/3 körningar |
| Betan | ✅ Aktiverad 2026-10-02 med informationstext. Avtalsfrågorna ska lösas innan fler användare bjuds in. |
| Schemalagd städning (Vercel Cron) | Senare. Kön är förberedd. |

## Senare

- **Versionshistorik:** bevara publicerarens namn även när användarkontot tas bort (i dag blir det "Folke"). Mindre förbättring som inte ska försena introduktionen.
- Kontrollerad webbsökning (de fasta reglerna är förberedda, men ingen sökning är byggd eller aktiverad).

## Version 2 – exempelbaserad introduktion (planerad)

- Tre steg med färdiga exempel: svarslängd, skrivstil och frivilliga tillval, plus frivillig fritext och egen exempeltext. Exemplen finns i `src/lib/onboarding/catalog.ts`, och inga AI-anrop krävs.
- Varje steg och hela flödet kan hoppas över. Standardvärden gäller alltid.
- Min profil → Mina AI-inställningar med förhandsgranskning.
- Administratören väljer vid inbjudan om introduktionen erbjuds (`profiles.onboarding_offered`).
- Valfri interaktiv guide: starta konversation, välja assistent, källhänvisningar och tidigare chattar.

## Senare

- Godkännandeflöde för extern AI-behandling av interna dokument (förberett i schemat, ADR-031), när avtalen är klara.
- Uppföljning av OpenAI-kostnader mot fakturan. Larm när en budget närmar sig gränsen.
- Filbilagor i chatten, där innehållet läses och används i svaret. Knappen är avstängd tills dess.
- Redigering av metadata och delning för befintliga dokument (i dag: ta bort och ladda upp på nytt).
- Påminnelser om dokument som snart går ut. Versionshantering av dokument.
- OCR för skannade PDF:er.
- Rate limiting av chatt i mockläge och larm på säkerhetshändelser (externa AI-anrop är begränsade sedan MVP 0.3).
- Automatiska E2E-tester (Playwright) mot ett separat Supabase-testprojekt, där webbläsarverifieringen från 2026-10-01 blir en permanent svit.
- Eventuellt SSO mot Microsoft Entra ID.
- Driftsättning på Vercel (efter godkännande).

## Kvar som inte är kopplat

| Område | Var i koden | Status |
|---|---|---|
| AI-svar med interna dokument | `src/server/ai/guard.ts` | folke-dev: OpenAI med dokument som godkänts ett i taget. Pilot: mockläge. |
| Filbilagor i chatt | `components/chat/composer.tsx` | Avstängt i chattvyn |
| Tidsbegränsning av sessioner i Auth | Supabase Dashboard | Kräver Pro. Upprätthålls redan av appen och databasen. |
