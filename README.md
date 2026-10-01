# Folke

Intern AI-plattform för Börjessons. Medarbetare får tillgång till specialiserade AI-assistenter utifrån sina behörigheter.

> **Status: MVP 0.2, verifierad mot den riktiga backenden 2026-10-01.** Riktig backend med Supabase (Stockholm), inloggning med lösenord och obligatorisk TOTP, användaradministration, dokumenthantering med granskning, sparade konversationer, kostnadsuppföljning och säkerhetslogg. **AI-svaren körs i mockläge** tills en AI-leverantör är godkänd. Använd endast syntetiska eller godkända interna dokument utan kunduppgifter.

## Assistenter

| Assistent | Användning |
|---|---|
| Säljassistenten | Kundkommunikation, kampanjer, produktinformation, enklare värderingsunderlag |
| Analysassistenten | Analys av ekonomidata och verksamhetsrapporter |
| Mötesassistenten | Sammanfattningar, beslut och uppföljningslistor |
| Garantiassistenten | Sökning i garantidokument och förberedelse av ärenden |

## Kom igång

**Krav:** Node.js 24 (se `.nvmrc`). Supabase-projektet i Stockholm är konfigurerat. Status, miljövariabler och verifieringar finns i **[docs/SETUP.md](docs/SETUP.md)**.

```bash
npm install
cp .env.example .env.local   # fyll i Supabase-värdena
npm run db:push              # migrationer (efter supabase link)
npm run dev
npm run bootstrap:admin -- fornamn.efternamn@exempel.se "Förnamn Efternamn"
```

Öppna <http://localhost:3000>. Den första administratören bjuder sedan in övriga användare i **Administration → Användare**.

### Skript

| Kommando | Beskrivning |
|---|---|
| `npm run dev` / `build` / `start` | Utveckling, produktionsbuild, körning |
| `npm run lint` / `typecheck` | ESLint, TypeScript |
| `npm run test` | Alla tester (RLS och enhetstester) |
| `npm run test:db` | Endast RLS-testerna (PGlite) |
| `npm run test:live` | Säkerhetstester mot det riktiga Supabase-projektet (syntetiska användare, städar efter sig) |
| `npm run check` | Lint, typecheck och tester |
| `npm run db:push` | Kör migrationerna mot det länkade Supabase-projektet |
| `npm run bootstrap:admin` | Bjuder in den första systemadministratören |
| `npm run seed:synthetic` | Syntetisk testdata (`-- --remove` tar bort den) |

## Funktioner

- **Inloggning:** endast inbjudan. Lösenord och obligatorisk TOTP. Sessioner gäller i högst 7 dagar. Lösenordsåterställning och återställning av TOTP via administratör.
- **Assistenter:** tilldelas grupper eller enskilda användare. Instruktionerna finns bara på servern.
- **Kunskapsbank:** privat uppladdning av PDF, Word, Excel, PowerPoint, text, Markdown och CSV. Texten extraheras och indexeras. Granskning av systemadministratör eller gruppansvarig. Delning per grupp. Giltighetsperiod. Svensk fulltextsökning.
- **Chatt:** strömmande svar med källhänvisningar till godkända dokument. Konversationerna sparas och är privata, även gentemot administratörer.
- **Administration:** användare, grupper, gruppansvariga, behörigheter och assistentkonfiguration.
- **Drift:** användning och kostnad, säkerhetslogg, årlig gallringsgranskning (visar bara antal).

## Teknik

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Lucide, Geist · Supabase (PostgreSQL, Auth, Storage) · Zod · Vitest och PGlite för tester.

## Projektstruktur

```
supabase/
  migrations/          Versionshanterat schema, RLS, triggers, basdata
  templates/           E-postmallar (inbjudan, återställning)
src/
  proxy.ts             Sessionsförnyelse och omdirigering
  app/                 Routes: (auth)/login/*, (app)/…, api/chat, auth/*
  components/          UI (ui/ = shadcn anpassat till Folke)
  lib/                 Domän, chattprotokoll, sessionsregler, formatering
  server/              Endast server: auth, data, admin, documents, ai, supabase
tests/db/              RLS-tester mot riktiga migrationer (PGlite)
scripts/               bootstrap-admin, seed-synthetic
docs/                  Arkitektur, säkerhet, installation, design, roadmap, beslut
```

## Dokumentation

- [docs/SETUP.md](docs/SETUP.md) – Supabase-projekt, auth-inställningar, nycklar, första admin
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – lager, datamodell, flöden
- [docs/SECURITY.md](docs/SECURITY.md) – behörighetsmodell, skydd, tester
- [docs/DESIGN.md](docs/DESIGN.md) – designsystem
- [docs/ROADMAP.md](docs/ROADMAP.md) – status och nästa steg
- [docs/MVP-0.3-PLAN.md](docs/MVP-0.3-PLAN.md) – plan för OpenAI och semantisk sökning
- [docs/DECISIONS.md](docs/DECISIONS.md) – arkitekturbeslut och öppna frågor
- [CLAUDE.md](CLAUDE.md) – instruktioner för AI-assisterad utveckling

## Säkerhet i korthet

- RLS på alla tabeller. Allt kräver en aktiv användare, TOTP-verifierad session och en session yngre än 7 dagar.
- Konversationer är privata. Det finns ingen administratörsåtkomst.
- Den hemliga Supabase-nyckeln används bara på servern, för namngivna operationer.
- Inga hemligheter i repot: `.env*` ignoreras (utom `.env.example`).
- Ingen AI-leverantör anropas. Inga verkliga dokument får laddas upp innan leverantörer och databehandling är godkända.
