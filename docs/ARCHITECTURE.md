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
4. Konversationen skapas eller hämtas (RLS: endast ägaren), och användarens meddelande sparas.
5. **Retrieval:** `search_document_chunks` körs som användaren (SECURITY INVOKER). Svensk fulltextsökning ger bara godkända, giltiga och bearbetade dokument som delats med användarens grupper och som är kopplade till assistenten. Funktionen returnerar även ett frågestyrt utdrag (`ts_headline`), som visas i källkorten. Modellen får hela textbiten.
6. Prompten byggs av assistentens instruktioner, som läses på servern och aldrig visas för användare. Till det kommer fasta regler och källor markerade som data, inte instruktioner.
7. `AIProvider.streamChat()` strömmar text. Servern skickar NDJSON-händelserna `conversation`, `sources`, `text`, `done` och `error`.
8. Svaret sparas tillsammans med källorna, även när användaren stoppar svaret. Förbrukningen skrivs till `ai_usage` med adminklienten, så att den inte kan förfalskas.

## Dokumentflödet

1. `createDocumentUploadAction`: dokumentposten skapas som användaren (RLS avgör om hen får ladda upp och till vilken grupp). Extra delning och assistentkopplingar sparas, och servern skapar en **engångs-URL** för uppladdning.
2. Webbläsaren laddar upp filen direkt till den privata bucketen. Servern har inget uppladdningsflöde som begränsar filstorleken.
3. `processDocumentAction`: servern kontrollerar att anroparen är uppladdaren och verifierar filtypen via filsignaturen. Därefter extraheras texten (PDF: `unpdf`, Word: `mammoth`, Excel och PowerPoint: ZIP/XML via `jszip`, text: UTF-8), texten delas upp i överlappande textbitar med plats (sida, flik eller bild), och textbitarna indexeras.
4. **Granskning:** systemadministratörer och ansvariga för ägargruppen godkänner eller avvisar (med motivering) och kan arkivera. En trigger stoppar alla andra.
5. Först ett **godkänt** dokument blir sökbart och visas för gruppmedlemmar.
6. Nedladdning sker via en signerad länk som gäller i 60 sekunder, efter att RLS-läsning bevisat åtkomst. Nedladdningen loggas.

## AI-abstraktion

- `AIProvider.streamChat({ system, messages, context, signal })` ger en ström av `text`- och `usage`-händelser.
- Providers registreras i `src/server/ai/index.ts` och väljs med `FOLKE_AI_PROVIDER`. Bara `mock` är registrerad.
- **Mock-providern** svarar genom att citera de mest relevanta utdragen med korrekta `[n]`-hänvisningar. Hela kedjan (behörighet, sökning, källor, sparande och kostnad) kan därmed testas utan AI-leverantör och utan att någon data lämnar systemet.
- Kostnad räknas i `pricing.ts` (kr per miljon tokens och modell). Okända modeller loggas med kostnaden 0 och en varning.

## Administration

Admin-sidorna anropar `requireSystemAdminPage()` eller `requireAdministrationAccess()` i varje sida, och actions kontrollerar rollen igen. Alla ändringar skrivs med administratörens egen klient, så RLS och revisionstriggrarna gäller med rätt aktör. Undantag, som görs efter rollkontroll:

- **Inbjudan och ny inbjudan:** Auth-admin-API:t.
- **Inaktivering:** kontot spärras i Auth (`ban_duration`), så befintliga refresh tokens slutar fungera.
- **Återställning av TOTP:** faktorerna tas bort via admin-API:t.

## Drift

- **Användning och kostnad:** aggregat per assistent, användare och modell. Konversationsinnehåll visas aldrig.
- **Säkerhetslogg:** `audit_log` med triggers för profiler, grupper, behörigheter och dokument, plus serverhändelser som inloggning, MFA, nekad åtkomst, inbjudningar och nedladdningar.
- **Gallring:** administratörer ser bara antal konversationer per inaktivitetsintervall och kan ta bort konversationer som varit inaktiva i minst 12 månader. Gränsen upprätthålls i databasen, och åtgärden loggas.

## Rendering

Alla sidor bakom inloggning renderas dynamiskt (serverklienten läser cookies). `/login/forgot` och ikonen är statiska. Sidorna hämtar data parallellt med `Promise.all`, och `resolveSession` cachas per begäran.

## Driftsättning

Förberett för Vercel: standardbuild och `maxDuration` 60 s för `/api/chat`. Miljövariablerna i `.env.example` sätts i Vercel. Ingen driftsättning är gjord.

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
