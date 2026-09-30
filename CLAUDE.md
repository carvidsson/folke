@AGENTS.md

# Folke – instruktioner för AI-assisterad utveckling

Folke är Börjessons interna AI-plattform. Projektet är i **etapp 1: frontendprototyp** och har ingen riktig auth, ingen databas och inga AI-anrop. Läs `docs/ARCHITECTURE.md` innan du gör strukturella ändringar.

## Kommandon

```bash
npm run dev         # utvecklingsserver
npm run check       # lint + typecheck – ska passera innan du är klar
npm run build       # produktionsbuild – ska passera innan du är klar
```

## Arkitekturregler

- **Dataåtkomst endast via `src/server/*`.** Sidor (serverkomponenter) anropar repositories. Klientkomponenter får data via props eller `/api/*`. Importera aldrig `src/mocks` utanför `src/server/data/mock-store.ts`.
- **`import "server-only"`** först i varje ny modul under `src/server`. Klientkomponenter får bara `import type` därifrån.
- **Aktuell användare** hämtas endast med `getSession()` från `src/server/auth/session.ts`.
- **Admin-sidor** anropar `requireAdministrationAccess()` i varje sida, inte bara i layouten.
- **Behörighet:** roll ≠ assistentåtkomst ≠ dokumentåtkomst. Se `src/lib/domain/access.ts` och `roles.ts`. Att dölja något i UI:t är aldrig ett skydd.
- **AI:** gå via `getAIProvider()`. UI:t pratar bara protokollet i `src/lib/chat/protocol.ts`.
- **Domäntyper** i `src/lib/domain/types.ts` är kontraktet mellan lagren.
- **Next.js 16:** `params` och `searchParams` är promises. Använd de globala typerna `PageProps<"/route">` och `LayoutProps`. Middleware heter `proxy.ts`.

## UI-konventioner

- All användarsynlig text på **svenska**, med versal bara i början av meningen. Kod och identifierare på engelska.
- Använd semantiska tokens (`bg-surface`, `text-muted-foreground`, `border`, `bg-brand-subtle` …), inte hex-värden. Tokens finns i `src/app/globals.css`, och regler i `docs/DESIGN.md`.
- Återanvänd befintliga byggstenar: `PageContainer`/`PageHeader`, `Panel`/`StatTile`, `FilterBar`/`SearchInput`/`FilterSelect`, `StatusBadge`, `AssistantAvatar`, `UserAvatar`, `EmptyState`, `DetailList` och `PrototypeNotice`.
- Ikoner: endast `lucide-react`.
- Logotypen: använd `FolkeLogo`/`FolkeSymbol`. Rita aldrig om och färga aldrig om. "by Börjessons" (`endorsement`) visas bara på `/login` och `/`.
- Inga gradienter, glöd, oskärpa eller dekorativa AI-effekter.
- Datum och tal formateras med `src/lib/format.ts` (sv-SE, Europe/Stockholm).

## Säkerhetsregler

- Bygg **aldrig** egen autentisering, lösenordshantering eller kryptografi.
- Skapa inga skenbara säkerhetsfunktioner. Okopplad funktionalitet märks med `PrototypeNotice` eller en toast som säger "Prototyp: …".
- Inga hemligheter eller API-nycklar i koden. Miljövariabler läses bara på servern. Dokumentera nya variabler i `.env.example`.
- Inga verkliga personuppgifter eller interna verksamhetsdata. Testdata ska vara syntetisk och använda domänen `folke.example`.
- Validera all indata till route handlers och server actions med Zod.
- Rendera aldrig modellutdata som rå HTML.
- Gör inga driftsättningar och skapa inga molnresurser utan uttryckligt godkännande.

## Dokumentation

Uppdatera `docs/ROADMAP.md` (tabellen "Prototyp → backend") när något kopplas in eller tillkommer som prototyp. Lägg till en ADR i `docs/DECISIONS.md` vid arkitekturval.
