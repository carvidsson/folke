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

## Senare

- Godkännandeflöde för extern AI-behandling av interna dokument (förberett i schemat, ADR-031), när avtalen är klara.
- Uppföljning av OpenAI-kostnader mot fakturan. Larm när en budget närmar sig gränsen.
- Filbilagor i chatten, där innehållet läses och används i svaret. Knappen är avstängd tills dess.
- Redigering av metadata och delning för befintliga dokument (i dag: ta bort och ladda upp på nytt).
- Påminnelser om dokument som snart går ut. Versionshantering av dokument.
- OCR för skannade PDF:er.
- Byte av namn på konversationer (borttagning finns).
- Rate limiting av chatt i mockläge och larm på säkerhetshändelser (externa AI-anrop är begränsade sedan MVP 0.3).
- Automatiska E2E-tester (Playwright) mot ett separat Supabase-testprojekt, där webbläsarverifieringen från 2026-10-01 blir en permanent svit.
- Eventuellt SSO mot Microsoft Entra ID.
- Driftsättning på Vercel (efter godkännande).

## Kvar som inte är kopplat

| Område | Var i koden | Status |
|---|---|---|
| AI-svar för intern information | `src/server/ai/guard.ts` | Mockläge. OpenAI bara för syntetiska testkonversationer. |
| Embeddings för interna dokument | `src/server/ai/test-data.ts`, trigger i databasen | Spärrat. Bara syntetiska dokument indexeras. |
| Filbilagor i chatt | `components/chat/composer.tsx` | Avstängt i chattvyn |
| Tidsbegränsning av sessioner i Auth | Supabase Dashboard | Kräver Pro. Upprätthålls redan av appen och databasen. |
