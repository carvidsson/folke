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
- Commit av MVP 0.2-koden till git

## MVP 0.3 – OpenAI och semantisk sökning (planerad)

Se [MVP-0.3-PLAN.md](MVP-0.3-PLAN.md). Rekommenderad ordning: beslut och avtal (0.3a) parallellt med pgvector och hybridsökning (0.3b), därefter OpenAI-provider med kostnadsgränser (0.3c) och en svensk testsvit (0.3d).

## Senare

- Semantisk sökning (pgvector och embeddings) som komplement till fulltextsökning, när leverantören är vald.
- Filbilagor i chatten, där innehållet läses och används i svaret. Knappen är avstängd tills dess.
- Redigering av metadata och delning för befintliga dokument (i dag: ta bort och ladda upp på nytt).
- Påminnelser om dokument som snart går ut. Versionshantering av dokument.
- OCR för skannade PDF:er.
- Byte av namn på konversationer (borttagning finns).
- Rate limiting på `/api/chat` och larm på säkerhetshändelser.
- Automatiska E2E-tester (Playwright) mot ett separat Supabase-testprojekt, där webbläsarverifieringen från 2026-10-01 blir en permanent svit.
- Nytt försök i chatten skickar frågan igen. Om felet uppstod efter att frågan sparats blir den dubblerad i historiken.
- Eventuellt SSO mot Microsoft Entra ID.
- Driftsättning på Vercel (efter godkännande).

## Kvar som inte är kopplat

| Område | Var i koden | Status |
|---|---|---|
| AI-svar | `src/server/ai/providers/mock.ts` | Mockläge: citerar hittade utdrag. Ingen extern AI. |
| Kostnad i kronor | `src/server/ai/pricing.ts` | 0 kr i mockläge. Prislista fylls i när leverantör och modell är valda. |
| Filbilagor i chatt | `components/chat/composer.tsx` | Avstängt i chattvyn |
| Tidsbegränsning av sessioner i Auth | Supabase Dashboard | Kräver Pro. Upprätthålls redan av appen och databasen. |
