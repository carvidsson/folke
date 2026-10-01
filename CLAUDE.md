@AGENTS.md

# Folke – instruktioner för AI-assisterad utveckling

Folke är Börjessons interna AI-plattform, nu i **MVP 0.3**: Supabase-backend (Stockholm), inloggning med TOTP, RLS, AI i mockläge och OpenAI **endast för syntetiska testdata** (ADR-031). Läs `docs/ARCHITECTURE.md` och `docs/SECURITY.md` innan du gör strukturella ändringar.

## Kommandon

```bash
npm run dev
npm run check      # lint + typecheck + tester – ska passera innan du är klar
npm run test:db    # RLS-tester (kör alltid efter ändringar i supabase/migrations)
npm run test:live  # mot Supabase-projektet i .env.local – ska vara utvecklingsprojektet
npm run test:ai-eval # riktiga OpenAI-anrop, syntetiska data, kostar några cent – kör bara vid behov
npm run test:live  # säkerhetstester mot riktiga Supabase (efter migrationer och behörighetsändringar)
npm run build      # ska passera innan du är klar
```

## Arkitekturregler

- **Aktuell användare** hämtas endast med `getSession()` / `getApiSession()` (`src/server/auth/session.ts`). Sidor skyddas i varje sida med `requireSystemAdminPage()` eller `requireAdministrationAccess()`, inte bara i layouten.
- **Dataåtkomst** går via `src/server/data/*` med **användarens klient** (`createSupabaseServerClient`), så att RLS gäller.
- **Adminklienten** (`createSupabaseAdminClient`, hemlig nyckel) används bara för: inbjudan och spärr i Auth, TOTP-återställning, Storage, textbitar och bearbetningsfält, `ai_usage` och `audit_log`, och **endast efter** behörighetskontroll. Läs aldrig konversationer med den.
- **Server actions** validerar med Zod, kontrollerar rollen och returnerar `ActionResult`. Felmeddelanden till användaren är på svenska. Databasfel loggas på servern.
- **`import "server-only"`** först i varje ny modul under `src/server` (utom `"use server"`-filer). Exportera bara async actions från `"use server"`-filer.
- **Välj aldrig `instructions`** från `assistants` med användarklienten. Kolumnen är inte beviljad.
- **Chatten:** klienten skickar bara nya meddelanden, och servern äger historiken. UI:t använder protokollet i `src/lib/chat/protocol.ts`. Leverantören väljs **bara** av `chooseProviderId()` i `src/server/ai/guard.ts`, och `assertExternalAllowed()` körs före varje externt anrop.
- **Extern AI:** skicka aldrig dokument eller konversationer med dataklassen `internal` till en extern leverantör, inte heller som embeddings. Lägg inte till vägar runt dataspärren, aktivera inte dataklassen `approved` och använd inte OpenAI:s vector stores, filer eller verktyg. Modeller läggs bara till i katalogen `src/server/ai/models.ts`, med kontrollerat pris och verifierad tillgänglighet.
- **Next.js 16:** `params` och `searchParams` är promises, och middleware heter `proxy.ts`.

## Databasregler

- Alla ändringar görs som **nya migrationer** i `supabase/migrations/` (`YYYYMMDDHHMMSS_namn.sql`). Ändra inte migrationer som körts mot en delad miljö.
- Varje ny tabell: `enable row level security`, **explicita `grant` till `authenticated` och `service_role`** (projektet ger inga automatiska tabellbehörigheter), policies via `app.authorized()` eller andra hjälpfunktioner, revisionstrigger vid behov, samt **tester i `tests/db/rls.test.ts`**.
- Kör `npx supabase db push --dry-run` före `npm run db:push`. Status och verifieringar dokumenteras i `docs/SETUP.md`.
- Hjälpfunktioner i schemat `app` är `SECURITY DEFINER`, `STABLE` och har `set search_path = ''`.
- `INSERT … RETURNING` kräver att den nya raden kan läsas direkt i select-policyn.

## UI-konventioner

- All användarsynlig text är på **svenska** och har versal bara i början av meningen. Kod är på engelska.
- Använd semantiska tokens (`bg-surface`, `text-muted-foreground`, `bg-brand-subtle` …) och befintliga byggstenar: `PageContainer`/`PageHeader`, `Panel`/`StatTile`, `FilterBar`, `StatusBadge`, `AssistantAvatar`, `UserAvatar`, `EmptyState`, `DetailList` och `useAdminAction`.
- Endast `lucide-react`. Logotypen via `FolkeLogo`/`FolkeSymbol`. "by Börjessons" visas bara på inloggningssidorna och `/`.
- Visa inte funktioner som om de fungerade när de inte gör det. Hellre avstängt eller dolt.

## Säkerhetsregler

- Bygg **aldrig** egen autentisering, lösenordshantering eller kryptografi. Använd Supabase Auth.
- Inga hemligheter i koden. Nya miljövariabler dokumenteras i `.env.example` och `docs/SETUP.md`.
- **Endast syntetisk testdata** (domänen `folke.example`, taggen `syntetisk`). Koppla inte in verkliga dokument utan uttryckligt godkännande. OpenAI-nyckeln finns bara i `.env.local` och får aldrig skrivas ut, loggas eller checkas in.
- **Två Supabase-projekt:** nya migrationer och tester körs mot utvecklingsprojektet. Pilotprojektet (Christoffers konto, MFA, grupper och dokument) ändras inte utan uttryckligt godkännande.
- Tester mot det riktiga projektet får aldrig ändra befintliga användare, grupper, dokument eller säkerhetsloggen. Allt som skapas ska städas bort, inklusive `ai_usage`. Mejl i tester går bara till `delivered@resend.dev`.
- Inline-skript kräver CSP-nonce (`src/proxy.ts`). Sessionscookies är `httpOnly`. Använd inte Supabase Auth i webbläsaren.
- Rendera aldrig modellutdata som rå HTML. Logga aldrig konversations- eller dokumentinnehåll.
- Gör inga driftsättningar och skapa inga molnresurser utan uttryckligt godkännande.

## Dokumentation

Uppdatera `docs/ROADMAP.md`, `docs/SECURITY.md` (vid behörighetsändringar) och `docs/DECISIONS.md` (lägg till en ADR vid arkitekturval) löpande.
