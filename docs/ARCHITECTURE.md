# Arkitektur

Dokumentet beskriver hur Folke är uppbyggt i etapp 1 och hur strukturen är tänkt att bära en riktig backend utan att frontenden behöver skrivas om.

## Översikt

```
 Webbläsare
   │  React Server Components (HTML) + klientkomponenter för interaktion
   ▼
 Next.js App Router ─────────────────────────────────────────────┐
   app/(auth)  app/(app)/(workspace)  app/(app)/chat  app/(app)/admin
   app/api/chat (Route Handler, strömmar NDJSON)                  │
   │                                                              │
   ▼                         endast server ("server-only")        │
 src/server/auth   ──► getSession(), requireAdministrationAccess()│
 src/server/data   ──► repositories (listUsers, getConversation…) │
 src/server/ai     ──► getAIProvider() → AIProvider.streamChat()  │
   │                                                              │
   ▼                                                              │
 Etapp 1: src/mocks (syntetisk data)                              │
 Senare:  Postgres/Supabase, fillagring, AI-leverantör ◄──────────┘
```

**Grundregel:** UI-kod hämtar aldrig data direkt från källan. Serverkomponenter anropar funktioner i `src/server/*`, och klientkomponenter får färdig data via props eller går via en route handler. När mockdatan byts mot en databas ändras bara implementationen i `src/server/*`.

## Lager

| Lager | Katalog | Ansvar | Får importera |
|---|---|---|---|
| Routes | `src/app` | Routing, layout, datahämtning per sida, metadata | allt nedan |
| UI | `src/components` | Presentation och interaktion | `lib`, typer från `server` (`import type`) |
| Domän | `src/lib/domain` | Typer, roller, behörighetsregler, etiketter | inget app-specifikt |
| Delad logik | `src/lib/chat`, `src/lib/format.ts` | Chattprotokoll, formatering | `lib/domain` |
| Server | `src/server` | Session, dataåtkomst, AI | `lib`, `mocks` (endast `data/mock-store.ts`) |
| Testdata | `src/mocks` | Syntetisk data | `lib/domain` |

Allt i `src/server` börjar med `import "server-only"`, så att modulerna inte av misstag hamnar i en klientbundle. Klientkomponenter får bara importera *typer* därifrån (`import type`).

## Routes och navigeringslägen

Route-grupperna ger tre navigeringslägen med samma skal (`AppShell`):

| Grupp | Sidomeny | Karaktär |
|---|---|---|
| `(app)/(workspace)` | `WorkspaceSidebar` – huvudnavigering, assistenter, senaste konversationer | Luftig översikt |
| `(app)/chat` | `ChatSidebar` – ny chatt, historik grupperad per datum, kan döljas | Fokuserad, maximal yta för samtalet |
| `(app)/admin` | `AdminSidebar` – administrationsmeny och väg tillbaka | Informationstät |

På små skärmar blir sidomenyn en utfällbar panel (Sheet).

Sidor som visar användardata anropar `getSession()`, som anropar `connection()`. Sidorna renderas därför dynamiskt, precis som med en riktig cookie-baserad session. Bara `/login` är statisk.

## Autentisering (sessionsgränssnitt)

`src/server/auth/session.ts` är den enda punkten som svarar på frågan "vem är användaren?".

- **Etapp 1:** `getSession()` returnerar alltid en fast demoanvändare, och `Session.isPrototype` är `true`. Inloggningsformuläret skickar ingenting.
- **Nästa etapp:** `getSession()` läser sessionen från auth-leverantören (planerat: Supabase Auth med e-post, lösenord och obligatorisk TOTP) och skickar oinloggade användare vidare till `/login`. Signaturen behålls, så att sidor och route handlers inte behöver ändras.

Folke ska inte ha en egen autentiseringslösning. Lösenordshantering, MFA-enrollment och sessionsförnyelse delegeras till leverantören.

## Behörighetsmodell

Tre separata begrepp:

1. **Roll** (`system_admin`, `assistant_manager`, `employee`) styr vad användaren får *administrera*. Se `lib/domain/roles.ts`.
2. **Assistentåtkomst** (`AssistantGrant`) styr vilka assistenter användaren får *använda*. Den tilldelas direkt till användare eller via grupp.
3. **Dokumentåtkomst** (`DocumentVisibility` per dokument) styr vilka dokument användaren får *se*: alla med assistentåtkomst, utvalda grupper eller begränsad.

Assistent- och dokumentåtkomst är avsiktligt oberoende. När retrieval byggs måste en assistent bara få söka i dokument som (a) ingår i assistentens kunskapssamlingar **och** (b) användaren själv har åtkomst till.

### Var kontrollerna ska ligga

| Nivå | Etapp 1 | Senare |
|---|---|---|
| UI (dölja menyval) | `canSeeAdministration()` och filtrerade listor | Oförändrat. Är aldrig ett skydd i sig. |
| Sidor | `requireAdministrationAccess()` i varje admin-sida | Oförändrat, mot riktig session |
| Route handlers / server actions | `/api/chat` validerar indata och kontrollerar assistentåtkomst | Samma mönster för alla muterande anrop |
| Databas | – | Row Level Security (RLS) i Postgres som sista skyddslinje |

Layouts räcker inte som skydd, eftersom de inte körs om vid klientnavigering. Kontrollen görs därför i varje sida och i varje handler.

## Dataåtkomst

`src/server/data/*` exponerar asynkrona funktioner, till exempel `listAssistantsForUser()`, `getConversation(ownerId, id)` och `listDocuments()`. I etapp 1 läser de från `mock-store.ts`, som bygger datan per anrop så att relativa tidsstämplar alltid ser aktuella ut.

Principer inför databasen:

- Funktioner som agerar för en användare tar användarens id och filtrerar själva (`getConversation` returnerar `null` om man inte äger konversationen).
- Domäntyperna i `lib/domain/types.ts` är kontraktet. Tabellstrukturen mappas till dem i data-lagret.
- `listDocuments()` är märkt `TODO(backend)`. Den ska filtrera på användarens dokumentåtkomst.

## AI-abstraktion och chattprotokoll

```
ChatView (klient) ──POST /api/chat──► route handler ──► AIProvider.streamChat()
      ▲                                   │                   (mock i etapp 1)
      └──────── NDJSON-händelser ◄─────────┘
```

- `src/server/ai/types.ts` definierar `AIProvider` med `streamChat({ assistant, messages, context, signal })`, som returnerar en asynkron ström av `ChatStreamEvent`.
- `src/server/ai/index.ts` väljer provider via `FOLKE_AI_PROVIDER` (standard `mock`). En ny leverantör läggs till som en implementation i `providers/`. API-nycklar läses bara där, från miljövariabler på servern.
- `src/lib/chat/protocol.ts` definierar begäran (Zod-schema) och händelser: `sources`, `text`, `done` och `error`. Protokollet är leverantörsneutralt, så UI:t påverkas inte av valet av AI-tjänst.
- `context: RetrievedChunk[]` är förberett för RAG och är tomt i prototypen.
- Instruktionerna (`Assistant.instructions`) ska bara användas på servern.

### Chatten i klienten

`useChat` (`components/chat/use-chat.ts`) håller meddelanden, status (`idle | submitted | streaming | error`), avbrott (`AbortController`) och omförsök. I etapp 1 sparas ingenting, och en ny chatt får ingen egen URL. När persistens införs skapas konversationen på servern (server action), och klienten omdirigeras till `/chat/[id]`.

Snabbstarten på startsidan lämnar över prompten via `sessionStorage`, inte via URL:en, så att användartext inte hamnar i webbläsarhistorik eller serverloggar.

### Rendering av svar

Assistentsvar renderas med `react-markdown`, `remark-gfm` och `remark-breaks`. Rå HTML renderas inte. Källmarkeringar som `[1]` blir länkar till motsvarande källa under svaret, med id:n som är unika per meddelande.

## Säkerhetsförberedelser i etapp 1

- `server-only` på alla servermoduler.
- Zod-validering av all indata till `/api/chat`, med storleksgränser.
- Åtkomstkontroll av assistenten i route handlern, även om sessionen är falsk.
- Säkerhetsheaders: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` och `Permissions-Policy`. `poweredByHeader` är avstängt.
- Inga hemligheter i repot, och `.env*` ignoreras.
- Inloggningsfälten saknar `name` och skickas inte.

Kvar till senare: Content Security Policy (med nonce), rate limiting på `/api/chat`, auditlogg för administrativa ändringar och loggpolicy för promptar.

## Driftsättning

Appen är förberedd för Vercel, med standardbuild och utan egen server. Inga molnresurser är skapade. Inför driftsättning behöver datalagring i EU, miljövariabler och domän beslutas (se [DECISIONS.md](DECISIONS.md)).
