# Folke

Intern AI-plattform för Börjessons. Medarbetare får tillgång till specialiserade AI-assistenter utifrån sina behörigheter.

> **Status: Etapp 1 – frontendprototyp.** Det finns ingen riktig inloggning, ingen databas och inga anrop till AI-tjänster. All data är syntetisk. Se [Prototyp eller riktig funktion](#prototyp-eller-riktig-funktion).

## Assistenter i första versionen

| Assistent | Användning |
|---|---|
| Säljassistenten | Kundkommunikation, kampanjer, produktinformation, enklare värderingsunderlag |
| Analysassistenten | Analys av ekonomidata och verksamhetsrapporter |
| Mötesassistenten | Sammanfattningar, beslut och uppföljningslistor |
| Garantiassistenten | Sökning i garantidokument och förberedelse av ärenden |

## Kom igång

**Krav:** Node.js 22 LTS rekommenderas (se `.nvmrc`). Node 20.17 fungerar men ger varningar från några verktyg.

```bash
npm install
npm run dev
```

Öppna <http://localhost:3000>. Inloggningsvyn finns på <http://localhost:3000/login>. Knappen *Logga in* leder direkt till demoläget.

Du loggas alltid in som demoanvändaren *Anna Lindqvist* (Systemadministratör), så att alla vyer, även administrationen, går att nå.

### Skript

| Kommando | Beskrivning |
|---|---|
| `npm run dev` | Utvecklingsserver (Turbopack) |
| `npm run build` | Produktionsbuild |
| `npm run start` | Kör produktionsbuilden |
| `npm run lint` | ESLint |
| `npm run typecheck` | Genererar route-typer och kör TypeScript |
| `npm run check` | Lint + typecheck |

### Miljövariabler

Se `.env.example`. I prototypen behövs inga. Hemligheter ska aldrig checkas in. `.env*` ignoreras av git, med undantag för `.env.example`.

## Vyer

| Route | Vy |
|---|---|
| `/login` | Inloggning (visuell prototyp) |
| `/` | Startsida: snabbstart, assistenter, tidigare konversationer |
| `/chat`, `/chat?assistant=<slug>` | Ny chatt |
| `/chat/[id]` | Befintlig konversation |
| `/knowledge` | Kunskapsbank: sök, filter, dokumentdetaljer, uppladdning |
| `/admin/users` · `/groups` · `/assistants` · `/permissions` | Administration |
| `/settings` | Profil, säkerhet (planerad), preferenser |

## Teknik

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui (Radix), Lucide Icons och typsnittet Geist. Zod validerar indata vid API-gränsen, och react-markdown renderar assistentsvar.

## Projektstruktur

```
src/
  app/                 Routes (App Router)
    (auth)/login         Inloggning
    (app)/(workspace)    Startsida, kunskapsbank, inställningar
    (app)/chat           Chattvyer
    (app)/admin          Administration
    api/chat             Strömmande chatt-endpoint (NDJSON)
  components/
    ui/                  shadcn/ui-primitiver, anpassade till Folke
    brand/ layout/ common/
    chat/ home/ knowledge/ admin/ settings/ auth/
  lib/
    domain/              Domäntyper, roller, behörighetsregler, svenska etiketter
    chat/                Chattprotokoll och klient
    format.ts            Datum, storlek, initialer (sv-SE)
  server/                Endast server (import "server-only")
    auth/                Sessionsgränssnitt (demo-stub)
    data/                Repositories (mock-implementation)
    ai/                  AI-providerabstraktion + mock-provider
  mocks/               Syntetisk testdata
design/assets/         Originalfiler för logotyp och symbol
public/brand/          Oförändrade kopior av logotypfilerna
docs/                  Arkitektur, design, roadmap och beslut
```

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – lager, dataflöden, behörighetsmodell, AI-abstraktion
- [docs/DESIGN.md](docs/DESIGN.md) – designprinciper, tokens, typografi, komponenter
- [docs/ROADMAP.md](docs/ROADMAP.md) – etapper och vad som återstår
- [docs/DECISIONS.md](docs/DECISIONS.md) – arkitekturbeslut och öppna frågor
- [CLAUDE.md](CLAUDE.md) – instruktioner för AI-assisterad utveckling i repot

## Prototyp eller riktig funktion

Allt nedan är **prototyp** och måste kopplas till backend innan riktig användning. Den fullständiga listan finns i [docs/ROADMAP.md](docs/ROADMAP.md#prototyp--backend).

| Funktion | Status i etapp 1 |
|---|---|
| Inloggning och MFA | Endast visuell. Ingen autentisering sker. |
| Session och aktuell användare | Fast demoanvändare (`src/server/auth/session.ts`) |
| Behörighetskontroll | Reglerna finns (`lib/domain`), men de körs mot en falsk session och mockdata |
| Konversationer | Mockdata. Nya meddelanden lever bara i webbläsarens minne. |
| AI-svar | Förskrivna svar från mock-providern, strömmade med fördröjning |
| Filbilagor i chatt | Bara namn, typ och storlek. Innehållet läses inte. |
| Kunskapsbank och uppladdning | Mockdata. Uppladdningsformuläret skickar ingenting. |
| Administration | Visning av mockdata. Ändringar sparas inte. |
| Inställningar | Formulär utan lagring. Säkerhetsdelen är markerad som planerad. |

UI som ser funktionellt ut men inte är kopplat markeras med en streckad **prototypnotis**.

## Säkerhet

- Inga hemligheter eller API-nycklar i repot.
- Inga verkliga personuppgifter. Alla personer använder domänen `folke.example`.
- Ingen egen autentiseringslösning. Riktig inloggning delegeras till vald leverantör (planerat: Supabase Auth med TOTP).
- Grundläggande säkerhetsheaders sätts i `next.config.ts`.
