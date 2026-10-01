# Arkitektur

Folke MVP 0.2 är en Next.js-applikation med Supabase (PostgreSQL, Auth och Storage i Stockholm) som backend. AI-leverantören är utbytbar och körs i mockläge tills en leverantör är godkänd. Säkerhetsmodellen beskrivs i detalj i [SECURITY.md](SECURITY.md), och installationen i [SETUP.md](SETUP.md).

## Översikt

```
 Webbläsare
   │  HTML (Server Components) + klientkomponenter
   │  Filuppladdning direkt till Storage via engångs-URL
   ▼
 src/proxy.ts ── förnyar sessionscookies, optimistisk omdirigering
   ▼
 Next.js App Router (Vercel, senare)
   Sidor / layouter ──► getSession() ──► repositories (src/server/data)
   Server actions   ──► admin, dokument, konto, inloggning
   /api/chat        ──► behörighet → spara → sök → AIProvider → spara
   │                                   │
   │ användarens klient (RLS)          │ adminklient (hemlig nyckel)
   ▼                                   ▼  endast efter behörighetskontroll:
 Supabase (Stockholm)                     inbjudan, spärr, lagring,
   Postgres + RLS + triggers              textbitar, kostnadslogg, säkerhetslogg
   Auth (lösenord + TOTP, inbjudan)
   Storage (privat bucket "documents")
```

**Grundregel:** all läsning och alla beslut som en användare fattar går via **användarens egen Supabase-klient**, så att Row Level Security gäller. Klienten med den hemliga nyckeln används bara för operationer som användare inte själva får utföra, och först när behörigheten har kontrollerats.

## Lager

| Lager | Katalog | Ansvar |
|---|---|---|
| Routes | `src/app` | Sidor, layouter, route handlers (`/api/chat`, `/auth/*`) |
| Proxy | `src/proxy.ts` | CSP med nonce, sessionsförnyelse (`httpOnly`-cookies) och optimistisk omdirigering. Är ingen behörighetsgräns. |
| UI | `src/components` | Presentation, formulär, anrop till server actions |
| Domän | `src/lib/domain` | Typer, roller, visningsregler, svenska etiketter |
| Delad logik | `src/lib/auth`, `src/lib/chat`, `src/lib/format.ts` | Sessionsålder, lösenordspolicy, chattprotokoll |
| Server | `src/server` | Allt med `import "server-only"` |
| ↳ `auth/` | | `getSession()`, sidskydd, inloggningsactions, TOTP |
| ↳ `data/` | | Repositories mot Supabase (RLS) |
| ↳ `admin/`, `documents/`, `account/` | | Server actions per område |
| ↳ `ai/` | | Providergränssnitt, prompt, prissättning, mock-provider |
| ↳ `supabase/` | | Serverklient (användare) och adminklient (hemlig nyckel) |
| ↳ `audit.ts` | | Säkerhetshändelser som inte fångas av triggers |
| Databas | `supabase/migrations` | Versionshanterat schema, RLS, triggers, basdata |
| Tester | `tests/db`, `**/*.test.ts` | RLS-tester (PGlite) och enhetstester (Vitest) |

## Datamodell

```
profiles ─┬─< group_members >── groups (is_system: "Alla medarbetare")
          ├─< assistant_grants >── assistants ──< assistant_collections >── collections
          ├─< assistant_managers >─┘
          ├─< documents ──< document_shares >── groups
          │      ├──< document_assistants >── assistants
          │      └──< document_chunks (tsvector, svensk stemming)
          ├─< conversations ──< messages (sources, attachments som JSON)
          ├─< ai_usage          (endast servern skriver)
          └─< audit_log         (triggers + servern skriver, admin läser)
```

- **Roll** (`profiles.role`) styr administration. **Assistentåtkomst** (`assistant_grants`, direkt eller via grupp) och **dokumentåtkomst** (`document_shares` per grupp) är separata.
- Gruppen **Alla medarbetare** (`is_system`) innehåller implicit alla aktiva användare.
- **Gruppansvariga** (`group_members.is_manager`) granskar dokument som gruppen äger.

## Inloggning och session

```
/login (e-post + lösenord) ──► aal1-session
   ├─ har TOTP ──► /login/mfa ──────────────┐
   └─ saknar  ──► /login/mfa/setup (QR) ────┤
                                            ▼
                               aal2-session ──► /auth/activate ──► /
Inbjudan/återställning: e-postlänk ──► /auth/confirm (token_hash) ──► /login/set-password
```

- Användare skapas **endast via inbjudan** (`inviteUserByEmail`). Öppen registrering är avstängd.
- En inbjuden användare blir `active` först efter första lyckade TOTP-verifieringen (`/auth/activate`).
- `getSession()` kräver en verifierad JWT, `aal2`, en session som är yngre än 7 dagar, en aktiv profil och en registrerad TOTP-faktor (`mfa_enrolled_at`). Annars skickas användaren till rätt steg. Databasen kräver samma sak i RLS (`app.authorized()`), så en läckt aal1-token eller en gammal session ger ingen data.
- 7-dagarsgränsen räknas från sessionens första autentisering (`amr`-tidsstämpeln), inte från senaste tokenförnyelse. Med Supabase Pro sätts dessutom *time-box* till 7 dagar på Auth-sidan.

## Chattflödet (`POST /api/chat`)

1. `getApiSession()` → 401 om ingen giltig session finns.
2. Zod-validering. Klienten skickar **bara det nya meddelandet**, eftersom historiken läses från databasen.
3. `getMyAssistant()` → 403 och en säkerhetshändelse om assistenten inte är tilldelad.
4. Konversationen skapas eller hämtas (RLS: endast ägaren). En ny konversation får dataklassen `synthetic` bara om klienten begär det **och** användaren har AI-testbehörighet. Annars blir den `internal`.
5. **Val av leverantör (dataspärren, `src/server/ai/guard.ts`):** med `FOLKE_AI_PROVIDER=openai` och `approved-documents` besvaras vanliga konversationer av OpenAI med enbart godkända dokument. Syntetiska konversationer kräver AI-testbehörighet och använder bara syntetiska dokument. Allt annat besvaras av mock-providern. Modellen är assistentens val i databasen, kontrollerat mot modellkatalogen.
6. För OpenAI kontrolleras gränserna atomiskt i databasen (`ai_begin_request`: budgetar, samtidighet och frågor per minut). Därefter sparas användarens meddelande.
7. **Retrieval:** `search_document_chunks_hybrid` körs som användaren (SECURITY INVOKER, RLS). Svensk fulltext och, i syntetiska konversationer, vektorlikhet (pgvector, frågans embedding) slås ihop med reciprocal rank fusion. Syntetiska konversationer hämtar bara syntetiska dokument. Funktionen returnerar ett frågestyrt utdrag för källkorten. Modellen får hela textbiten.
8. **Historik:** de senaste meddelandena inom en teckengräns. Tidigare svar som bygger på dokument som användaren inte längre kan läsa skickas inte med.
9. Prompten byggs i lager (ADR-037): gemensamma instruktioner, assistentens instruktioner (båda läses på servern och visas aldrig för användare), användarens egna önskemål om form och ton, och sist fasta regler. Till det kommer fasta regler, bland annat mot injektion i dokument och frågor, och källor markerade som data. **Slutkontrollen** `assertExternalAllowed` körs innan något skickas externt.
10. `AIProvider.streamChat()` strömmar text. Servern skickar NDJSON-händelserna `conversation` (med leverantör och modell), `sources`, `text`, `done` (slutligt, kontrollerat svar med citerade källor) och `error`.
11. **Källkontroll:** källnummer som inte motsvarar ett hämtat utdrag tas bort, och endast citerade utdrag sparas som källor. Svaret sparas även när användaren stoppar. Om leverantören fel tas frågan bort, så att ett nytt försök inte dubblerar historiken.
12. Förbrukningen (tokens, cachade tokens och uppskattad kostnad i USD och SEK) skrivs till `ai_usage` med adminklienten, så att den inte kan förfalskas. Det görs även vid fel och avbrott, då markerat som uppskattat.

## Dokumentflödet

Godkännande för OpenAI (ADR-036): `setDocumentAIApprovalAction` anropar `set_document_ai_approval` med användarens klient (databasen kontrollerar att det är en systemadministratör) och indexerar sedan med `src/server/ai/indexing.ts`, i batchar om 100 textavsnitt. Statusen skrivs till `ai_index_status`. Återkallelse tar bort embeddings direkt.


1. `createDocumentUploadAction`: dokumentposten skapas som användaren (RLS avgör om hen får ladda upp och till vilken grupp). Extra delning och assistentkopplingar sparas, och servern skapar en **engångs-URL** för uppladdning.
2. Webbläsaren laddar upp filen direkt till den privata bucketen. Servern har inget uppladdningsflöde som begränsar filstorleken.
3. `processDocumentAction`: servern kontrollerar att anroparen är uppladdaren och verifierar filtypen via filsignaturen. Därefter extraheras texten (PDF: `unpdf`, Word: `mammoth`, Excel och PowerPoint: ZIP/XML via `jszip`, text: UTF-8), texten delas upp i överlappande textbitar med plats (sida, flik eller bild), och textbitarna indexeras.
4. **Granskning:** systemadministratörer och ansvariga för ägargruppen godkänner eller avvisar (med motivering) och kan arkivera. En trigger stoppar alla andra.
5. Först ett **godkänt** dokument blir sökbart och visas för gruppmedlemmar.
6. Nedladdning sker via en signerad länk som gäller i 60 sekunder, efter att RLS-läsning bevisat åtkomst. Nedladdningen loggas.

## AI-abstraktion

| Modul (`src/server/ai/`) | Ansvar |
|---|---|
| `types.ts` | `AIProvider.streamChat({ system, messages, context, model, safetyIdentifier, signal, onUsage })` strömmar text. `onUsage` anropas exakt en gång när tokens förbrukats, även vid fel och avbrott. |
| `index.ts` | Registret: `mock` och `openai`. Vilken som används avgörs av `guard.ts`, inte av klienten. |
| `guard.ts` | Dataspärren: `chooseProviderId`, `retrievalDataClass`, `assertExternalAllowed` och `assertEmbeddable` |
| `models.ts` | Central modellkatalog med pris, kostnadsnivå och `reasoning.effort`. Tillåtna modeller (`FOLKE_CHAT_MODELS` kan bara begränsa), standardmodell och embeddingmodell. |
| `providers/openai.ts` | Officiell SDK, Responses API med strömning, `store: false`, inga omförsök och felmappning till svenska meddelanden. Embeddings och modellistning. |
| `providers/mock.ts` | Citerar hämtade utdrag. Inga externa anrop. |
| `limits.ts`, `usage.ts`, `pricing.ts` | Gränser och budgetstopp (databasfunktion), kostnadsloggning och kostnadsberäkning i USD (omräknad till SEK) |
| `citations.ts`, `prompt.ts` | Källkontroll, systemprompt med regler och historikgräns |
| `synthetic-corpus.ts`, `test-data.ts`, `embeddings.ts` | Syntetisk testsamling, inläsning, indexering och frågeembedding |

Att byta leverantör innebär en ny modul i `providers/` och ett nytt kostnadsavsnitt i katalogen. Allt ovanför gränssnittet är leverantörsneutralt. Att byta OpenAI-projekt (till exempel till Börjessons företagsprojekt) kräver bara nya miljövariabler.

## Personliga AI-inställningar

`/onboarding` (frivillig introduktion) och `/settings/ai` (Mina AI-inställningar) skriver till `user_ai_preferences` via `src/server/account/ai-preferences-actions.ts`, med användarens egen klient. Startsidan visar introduktionen när `onboarding_offered` är satt och status är `not_started`. Exemplen och förhandsgranskningen är statiska (`src/lib/onboarding/catalog.ts`, `src/components/ai-settings/pickers.tsx`). Chatten läser preferenserna per begäran och omvandlar dem med `personalInstructions()` och `personalReminder()`. AI-testet använder `runSideBySideTest()`.

## Administration

**AI-instruktioner** (`/admin/instructions`): utkast och publicering (`save_instruction_draft`, `publish_instruction_draft` med optimistisk låsning), versionshistorik, förhandsgranskning och jämförelse med OpenAI (`src/server/ai/instruction-test.ts`: en hämtning, två anrop, ingen konversation, `ai_usage.purpose = instruction_test`). De fasta reglerna visas skrivskyddade. Promptens ordning är: gemensamma instruktioner → assistentens instruktioner → regler → användarens önskemål → källor → påminnelse om svarslängd.

Admin-sidorna anropar `requireSystemAdminPage()` eller `requireAdministrationAccess()` i varje sida, och actions kontrollerar rollen igen. Alla ändringar skrivs med administratörens egen klient, så RLS och revisionstriggrarna gäller med rätt aktör. Undantag, som görs efter rollkontroll:

- **Inbjudan och ny inbjudan:** Auth-admin-API:t.
- **Inaktivering:** kontot spärras i Auth (`ban_duration`), så befintliga refresh tokens slutar fungera.
- **Återställning av TOTP:** faktorerna tas bort via admin-API:t.

## Drift

- **AI och modeller** (`/admin/ai`, endast systemadministratör): leverantörsstatus utan hemligheter, kontroll av modeller, modell per assistent (rullista med kostnadsnivå), gränser, månadens kostnad, syntetiska testdata och AI-testbehörighet. Testverktygen finns bara när OpenAI är konfigurerat.
- **Användning och kostnad:** aggregat per assistent, användare och modell, med embeddings separat och USD/SEK. Uppskattade värden markeras. Konversationsinnehåll visas aldrig.
- **Säkerhetslogg:** `audit_log` med triggers för profiler, grupper, behörigheter och dokument, plus serverhändelser som inloggning, MFA, nekad åtkomst, inbjudningar och nedladdningar.
- **Gallring:** administratörer ser bara antal konversationer per inaktivitetsintervall och kan ta bort konversationer som varit inaktiva i minst 12 månader. Gränsen upprätthålls i databasen, och åtgärden loggas.

## Rendering

Alla sidor bakom inloggning renderas dynamiskt (serverklienten läser cookies). `/login/forgot` och ikonen är statiska. Sidorna hämtar data parallellt med `Promise.all`, och `resolveSession` cachas per begäran.

## Driftsättning

Förberett för Vercel: standardbuild och `maxDuration` 60 s för `/api/chat`. Miljövariablerna i `.env.example` sätts i Vercel. Ingen driftsättning är gjord.

**Miljöer:** pilotprojektet (MVP 0.2, mockläge) och utvecklingsprojektet `folke-dev` (nya migrationer och AI-tester med syntetiska data). Se SETUP.md avsnitt 4.

## Livscykel och gallring

Beslut som gäller (DECISIONS): konversationer sparas och granskas årligen. Ingen automatisk permanent radering är beslutad, och därför finns ingen.

| Objekt | Vad händer | Raderas permanent? |
|---|---|---|
| **Användare, inaktiverad** | `status = disabled` och kontot spärras i Auth. Sessionen upphör direkt. Profil, gruppmedlemskap, konversationer och uppladdade dokument **finns kvar**. Kan återaktiveras. | Nej. Permanent radering finns inte i appen (öppet beslut). Om ett Auth-konto raderas manuellt försvinner profil, medlemskap och konversationer (kaskad). Dokument som personen laddat upp blockerar raderingen tills de flyttats eller tagits bort. |
| **TOTP-faktor, återställd** | Faktorerna tas bort och `mfa_enrolled_at` nollställs. All åtkomst stoppas tills en ny faktor registrerats. | Faktorn: ja |
| **Konversation** | Sparas tills ägaren tar bort den (meny i chatten) eller tills den gallras | Ja, när ägaren tar bort den eller vid gallring. Meddelanden följer med (kaskad). |
| **Gallring** | Administratören ser **antal** per inaktivitetsintervall och kan radera konversationer som varit inaktiva i **minst 12 månader**. Åtgärden startas manuellt och loggas. | Ja, efter uttryckligt beslut i gallringsvyn. Inget sker automatiskt. |
| **Dokument, väntande eller avvisat** | Syns för uppladdaren och granskare. Används aldrig som källa. | Nej (tas bort manuellt) |
| **Dokument, arkiverat** (avpublicerat) | Syns för granskare, används inte som källa. Kan återställas till granskning. | Nej |
| **Dokument, giltighetstiden passerad** | Syns i listan som *Utgånget* och används inte som källa från dagen efter slutdatum. Ingen statusändring sker. | Nej |
| **Dokument, borttaget** | Rad, textbitar, delningar och fil i Storage tas bort | **Ja** |
| **Dokument där bearbetningen misslyckats** | Markeras *Fel vid bearbetning*, kan inte godkännas | Nej (tas bort manuellt) |
| **Säkerhetslogg** | Append-only. Kan inte ändras eller raderas via appen. | Nej. Lagringstid är ett öppet beslut. |
| **Kostnadsstatistik (`ai_usage`)** | Behålls. Kopplingen till konversationen nollställs när konversationen raderas, och användarkopplingen när användaren raderas. | Nej. Lagringstid är ett öppet beslut. |
