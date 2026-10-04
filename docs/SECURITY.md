# Säkerhetsmodell

## Principer

1. **Databasen är sista skyddslinjen.** Varje tabell har Row Level Security. UI, proxy och serverkontroller är ytterligare lager, inte ersättningar.
2. **Allt kräver `app.authorized()`:** en aktiv profil, en **registrerad** TOTP-faktor, en session där TOTP har verifierats (`aal2`) och en session som är yngre än 7 dagar.
3. **Minsta behörighet.** Den hemliga nyckeln används bara på servern, för namngivna operationer, efter behörighetskontroll.
4. **Konversationer är privata.** Det finns ingen policy som ger administratörer läsrätt.
5. **Explicita behörigheter.** API-rollerna får bara de tabell- och kolumnbehörigheter de behöver (`20261001120000_api_grants.sql`). `anon` får inga. RLS avgör vilka rader som nås.
6. **Ingen innehållsloggning.** Säkerhetsloggen och kostnadsloggen innehåller aldrig konversations- eller dokumentinnehåll.
7. **Extern AI bara med godkända data.** Till OpenAI skickas bara dokument som en systemadministratör har godkänt ett i taget (folke-dev, ADR-036) och syntetiska testdata. Spärren avgörs på servern och i databasen, aldrig av klienten (se *Extern AI*).

## Behörighetsmatris

| Resurs | Läsa | Skapa/ändra | Ta bort |
|---|---|---|---|
| Egen profil | Alltid (även under onboarding) | Namn, titel, avdelning och anläggning | – |
| Andras profiler | Behöriga användare | Roll och status: endast systemadministratör, aldrig den egna | – |
| Grupper, medlemskap | Behöriga användare | Systemadministratör (inte systemgrupper) | Systemadministratör |
| Assistenter | De man får använda. Admin och ansvariga ser de de administrerar. | Status, instruktioner och förslag: admin och assistentansvarig | Admin |
| Instruktioner | Ingen via API:t (kolumnen är inte beviljad). Admin och ansvariga via `get_assistant_instructions`. | Admin, ansvarig | – |
| Gemensamma instruktioner | Systemadministratörer och assistentansvariga | Systemadministratörer | – |
| Instruktionshistorik | Systemadministratörer, ansvariga för respektive assistent | Endast triggers (vid publicering) | – |
| Instruktionsutkast | De som får redigera respektive text | Samma, via `save_instruction_draft` och `publish_instruction_draft` med versionskontroll | Samma |
| Personliga AI-preferenser | **Endast användaren själv** (inte administratörer) | Användaren själv (kontrollerade värden). Serveråtgärder använder sessionens användar-id, och RLS stoppar manipulerade anrop med annat id (testat live). | Användaren själv |
| Erbjudande om introduktion (`onboarding_offered`) | Användaren själv och administratörer | Administratör vid inbjudan. Användare kan inte ändra det för andra. | – |
| Assistentbehörighet | Admin, ansvariga och egna tilldelningar | Systemadministratör | Systemadministratör |
| Dokument (metadata) | Uppladdaren, granskare för ägargruppen, admin, samt medlemmar i delade grupper efter godkännande | Uppladdare (admin, assistentansvarig eller gruppansvarig) till egna grupper | Granskare, samt uppladdaren före godkännande |
| Granskningsbeslut | – | Admin och ansvariga för **ägargruppen** | – |
| Textbitar och sökning | Godkänt, bearbetat, giltigt och delat med användarens grupp, via en tilldelad assistent | Endast servern | Kaskad |
| Filer (Storage) | Signerad länk (60 s) efter RLS-kontroll | Engångs-URL för uppladdning efter RLS-kontrollerad insert | Servern |
| Konversationer, meddelanden | **Endast ägaren** | Ägaren (bara med tilldelad assistent). Meddelanden kan inte ändras. | Ägaren. Gallring via admin, endast efter ≥ 12 månaders inaktivitet. |
| Kostnadslogg | Egna rader, admin allt | Endast servern | – |
| Dataklass för dokument (`ai_data_class`) | Som dokumentet | `internal ↔ approved` endast via `set_document_ai_approval` (systemadministratör, loggas). `synthetic` endast av servern vid skapande. Kan inte ändras direkt, inte ens med servernyckeln. | – |
| Indexeringsstatus (`ai_index_status`) | Som dokumentet | Endast servern och godkännandefunktionen | – |
| AI-testbehörighet (`ai_test_access`) | Som profilen | Endast systemadministratör, via servern. Loggas. | – |
| Dataklass för konversation (`data_class`) | Ägaren | `synthetic` kräver AI-testbehörighet. Kan inte ändras. | – |
| Modellval per assistent (`ai_model`) | Behöriga användare | Endast systemadministratör, via servern, kontrollerat mot modellkatalogen. Loggas. | – |
| Embeddings | Som textbitarna | Endast servern, och bara för godkända eller syntetiska dokument (trigger) | Vid återkallelse och kaskad |
| Konversationens namn | Ägaren | Endast ägaren | Ägaren (även flera åt gången) |
| Anropslogg för AI (`ai_requests`) | Endast servern | Endast servern | Servern |
| Säkerhetslogg | Systemadministratör | Triggers och servern | Ingen |

## Skydd mot vanliga angrepp

| Hot | Skydd |
|---|---|
| Stulen lösenordssession | `aal2` krävs i RLS. Utan TOTP ges ingen data. |
| Stulen eller förlorad telefon | Administratören återställer TOTP. `mfa_enrolled_at` nollställs, och **alla befintliga sessioner** förlorar åtkomst direkt. |
| Stöld av sessionstoken via XSS | Sessionscookies är `httpOnly` (används aldrig i webbläsaren). Strikt CSP med nonce: endast egna skript körs. |
| Clickjacking | `frame-ancestors 'none'` och `X-Frame-Options: DENY` |
| Gammal eller stulen session | 7-dagarsgräns i `app.session_fresh()` och `getSession()` (Pro: även Auth time-box). Inaktivering spärrar kontot i Auth. |
| Rollhöjning via metadata | Roll och status läses aldrig från användarmetadata. Triggern `protect_profile_columns` stoppar ändringar som inte görs av en admin. |
| IDOR (gissa id:n) | RLS på alla tabeller. Repositories filtrerar dessutom på ägare. |
| Förfalskad chatthistorik | Klienten skickar bara det nya meddelandet, och historiken läses från databasen. |
| Promptinjektion via dokument | Källor markeras som information att analysera, sammanfatta och hänvisa till, inte som instruktioner till modellen. Arbetsinstruktioner i dokument får återges och förklaras, men uppmaningar som försöker ändra regler, behörigheter eller arbetssätt följs aldrig. Den fasta regeln läggs alltid till och är testad med riktiga anrop (bulletin med både arbetsinstruktion och injektionsförsök). Dokumenttext kan inte stänga eller öppna källmarkeringar, inte heller med varianter i versaler eller blanksteg (enhetstestat). Otillåtna dokument når aldrig servern, eftersom filtreringen sker i databasen. |
| Skadlig modellutdata | Markdown renderas utan rå HTML. CSP stoppar injicerade skript. |
| Felaktig filtyp | Filtyp från filändelse plus kontroll av filsignaturen. Maxstorlek 50 MB i bucket och kod. |
| Kunduppgifter i pilot | Obligatoriskt intygande (`internal_only_attested_at`) och granskning före publicering. |
| Förfalskad kostnad | `ai_usage` kan inte skrivas av användare. |
| Intern information till OpenAI | Dataspärr i flera lager, se *Extern AI*. Varje lager testas för sig. |
| AI-test av egna inställningar | Samma behörigheter, dokumentgodkännanden, spärr och budget som chatten. Ingen konversation sparas, och användaren jämför bara sina egna inställningar. |
| Utkast som påverkar användare | Chatten läser bara publicerade texter. Publicering kräver ett aktivt val och stoppas vid konflikter. |
| Två redigerare skriver över varandra | Optimistisk låsning i databasen: inaktuella versioner ger HTTP 409 och skrivs inte. |
| AI-jämförelse som kringgår regler | Samma behörighetskontroll, samma spärr (endast godkända dokument, `assertExternalAllowed`), samma budget och gränser som chatten. Inga konversationer sparas, och preferenserna är fasta exempel. |
| Promptinjektion via personliga önskemål | Önskemål sparas strukturerat. Fritext citeras och kan inte skapa nya avsnitt eller källor. Önskemålen går före allmänna stilanvisningar men uttryckligen aldrig före regler, uppdrag, format, fakta, källkrav eller behörigheter. Påminnelsen efter källorna innehåller bara serverns egen text. Testat med fientlig fritext och riktiga anrop. De fasta reglerna kan inte redigeras i administrationen. |
| Promptinjektion via användarens fråga | Reglerna säger uttryckligen att frågor inte kan upphäva regler, behörigheter eller källor. Behörigheter avgörs i databasen innan modellen anropas, så modellen kan aldrig nå otillåtna dokument. Testat med riktiga anrop (avslöja systemprompt, använd förbjuden källa, strunta i spärrar). |
| Påhittade källor | Modellen får bara citera numrerade utdrag som servern hämtat. Andra nummer tas bort innan svaret sparas, och endast citerade utdrag sparas som källor. |
| Bakdörr via gamla svar | Sparade källor visas bara medan användaren kan läsa dokumentet. Tidigare svar som bygger på dokument som inte längre är läsbara skickas inte med i historiken till modellen. |
| Kostnadsattack eller loop | Budget per användare och dag, månadsbudget, samtidighets- och minutgräns i databasen (atomiskt). Maxlängd på svar. Inga automatiska omförsök. |
| Läckt OpenAI-nyckel | Nyckeln finns bara i servermiljön och loggas aldrig. Felmeddelanden till användare innehåller aldrig leverantörens feltext. Separat, begränsat OpenAI-projekt för utveckling. |
| Insyn i privata konversationer | Det finns ingen admin-policy för konversationer. Gallringsvyn visar bara antal. |

## Tester

`npm run test:db` kör alla migrationer mot PGlite (PostgreSQL 18 i WASM) med en minimal emulering av Supabases `auth`-schema och testar RLS som riktiga användare med olika JWT:er. Täckningen omfattar bland annat:

- Anonyma användare, aal1-sessioner, sessioner över 7 dagar samt inbjudna och inaktiverade användare får ingen data.
- Användare ser bara egna konversationer, och **administratörer ser inga andras**.
- Man kan inte skriva i, ändra eller ta bort någon annans konversation, och inte skapa konversationer med assistenter man saknar behörighet till.
- Dokument syns bara för rätt grupper. Väntande dokument syns bara för uppladdare, granskare och administratörer.
- Bara ansvariga för ägargruppen (eller administratörer) kan godkänna. Medlemmar i en delad grupp kan inte det.
- Sökningen läcker inte dokument från andra grupper, väntande, utgångna eller otilldelade assistenter.
- Rollhöjning, egen statusändring och ändring av bearbetningsfält nekas.
- Säkerhetsloggen skrivs med rätt aktör och kan bara läsas av administratörer.
- Kostnadsloggen kan inte skrivas av användare.
- Gallringen är bara tillgänglig för administratörer, visar bara antal och kräver minst 12 månaders inaktivitet.

Begränsning: Supabase Auth, Storage och PostgREST körs inte i PGlite. Därför finns även **livetester** (`npm run test:live`, 23 tester) som kör mot det riktiga projektet med syntetiska användare och täcker:

- aal1, anonym åtkomst och `amr`-formatet i riktiga tokens
- dokument- och sökbehörighet mellan grupper och assistenter
- direktåtkomst till Storage och bucketens gränser
- konversationers integritet mot andra användare och administratörer
- försök till självhöjning
- att ändrade roller, grupper och assistenter samt inaktivering och TOTP-återställning gäller direkt för befintliga sessioner
- gallring
- att säkerhetsloggen saknar hemligheter

**MVP 0.3:** `tests/db/ai-guard.test.ts` (25 tester) täcker dataklasser, AI-testbehörighet, embeddings-spärren, hybridsökning med RLS, gränser och modellval. Samma spärrar testas live i `tests/live/ai.test.ts`, som bara körs mot utvecklingsprojektet. Enhetstester täcker routingen, slutkontrollen, OpenAI-leverantören mot en fejkad klient (parametrar, användning och felmappning), källkontrollen och historikfiltret. `npm run test:ai-eval` kör 21 svenska fall med riktiga anrop, bland dem tre injektionsfall, ett behörighetsfall och två giltighetsfall.

**Retrieval i konversationer (ADR-042):**
- `search_document_context` och `get_document_context_chunks` är SECURITY INVOKER, får inte köras av `anon` och följer samma RLS som tidigare. Det betyder grupper, assistent, granskning, giltighet och dataklass.
- Textbitar från ett tidigare svar läses om under samma regler. Om ett dokument har återkallats, gått ut eller inte längre delas med användaren följer det därför inte med.
- Tidigare svar skickas aldrig som källor, och deras källmarkörer tas bort ur historiken.
- Loggraden `[chat/retrieval]` innehåller bara konversationens id, leverantör, antal och textbitarnas id:n, aldrig dokument- eller konversationsinnehåll (ADR-043).

**Konversationsbilagor (ADR-045):**

| Skydd | Hur |
|---|---|
| Åtkomst | `conversation_attachments` och textbitarna: **endast ägaren** (RLS), ingen administratörspolicy. En bilaga kan bara kopplas till egen konversation och inte flyttas. Status, sökväg och textbitar skrivs bara av servern (kolumnbehörigheter och triggrar). |
| Filer | Privat bucket `conversation-attachments` (högst 20 MB, elva tillåtna MIME-typer), inga policyer för slutanvändare. Uppladdning via engångs-URL efter ägarkontroll. Visning via `/api/attachments/[id]` efter ägarkontroll, inga signerade länkar. |
| Validering | Filändelse, storlek (dokument 20 MB, bilder 10 MB) och filsignatur kontrolleras på servern. En text som utger sig för att vara en bild avvisas. Högst 5 filer per meddelande, 20 och 100 MB per konversation. |
| Isolering från kunskapsbanken | Egna tabeller och en egen sökfunktion som kräver ägd konversation. Kunskapsbankens sökning läser aldrig bilagor. `[n]`-källor gäller bara kunskapsbanken. |
| Extern AI | `FOLKE_AI_ATTACHMENTS` (standard `off`). När den är av döljs funktionen, servern avvisar bilagor och slutkontrollen stoppar varje externt anrop med bilagor. Bilder och PDF:er skickas inline (base64), aldrig till OpenAI:s Files API. **Betan: `on` sedan 2026-10-02** (produktägarens beslut, en användare). Vid bilagefunktionen visas: *"Ladda inte upp kunduppgifter, känsliga personuppgifter eller annan information som inte får delas med externa AI-tjänster."* Avtalsfrågorna ovan är fortfarande öppna och måste lösas innan fler användare bjuds in. |
| Injektion | Bilagornas text omges av `<bilaga>`-taggar som texten inte kan stänga, och reglerna anger att innehållet är information, inte instruktioner (testat). |
| Radering | Kaskad från konversation och användare. En trigger köar filen vid varje radering, och servern tar bort den. Misslyckade borttagningar ligger kvar i `storage_deletion_queue` med fel och antal försök. Osända uppladdningar tas bort efter 24 timmar. |
| Loggning | Bara id, antal och storlek, aldrig filnamn eller innehåll. Säkerhetsloggen får inga filnamn. |

Testat: `tests/db/attachments.test.ts` (13), `tests/live/attachments.test.ts` (7, folke-dev), enhetstester (18) och ett webbläsartest (20 kontroller, bland annat 404 för en annan användare och radering i Storage).

**Leadanalys från HubSpot (experiment, ADR-046, ADR-047 och ADR-048):**

| Skydd | Hur |
|---|---|
| Behörighet (ADR-048) | Åtkomst ges i `lead_access_grants` till en Folke-grupp eller en användare, för alla regioner eller en region. Systemadministratörer har alltid full åtkomst. Kontrollen görs på tre nivåer: i varje sida (`requireLeadAccessPage` ger 404 och loggar `access.denied`), i varje server action (`requireLeadAccess`) och med RLS. Urvalet i en action räknas fram ur listor som RLS redan har filtrerat, så en annan regions inkorg eller tråd-id i anropet ger inga data. Sammanvägningen för alla regioner kräver åtkomst till alla regioner. Konfigurationen (`/admin/leads`, inkorgar, regioner, åtkomst, länkmall) kan bara ändras av systemadministratörer och loggas som `leads.config_changed` och `leads.access_changed`. Varje hämtning (`leads.synced`) och AI-körning loggas, utan innehåll. |
| HubSpot | Servicenyckel med **bara** `conversations.read`. Klienten (`src/server/leads/hubspot.ts`) har bara `GET` mot `api.hubapi.com/conversations/v3`. Den gör inga skrivningar och använder inga andra API:er. Anropen sprids ut (≈ 8/s, API:t tillåter 19/s), och 429/5xx görs om med väntetid. |
| Nyckeln | Läses bara i servermiljön och skickas bara i `Authorization`-huvudet. Den ingår aldrig i fel, loggar, svar till webbläsaren eller anrop till OpenAI (testat). |
| Lagring (ADR-047) | HubSpot är källan till dialogerna. Folke sparar bara strukturerad analysdata i `lead_regions`, `lead_inboxes`, `lead_sellers`, `lead_threads` (inklusive märke och modell när de kan fastställas), `lead_dialogue_analyses` (inklusive AI:s avidentifierade situationsbeskrivning), `lead_analysis_runs` och `lead_syncs`: beräknade fakta per lead, AI-klassificeringar per dialog och en post per AI-körning. **Inga** meddelandetexter, kundnamn, e-postadresser, telefonnummer, personnummer eller registreringsnummer (testat i databasen och i webbläsartestet mot riktiga data). Säljare identifieras med HubSpot-id (`A-…`). Namnet uppdateras i `lead_sellers`, och den sparade sammanvägda analysen refererar till säljare med id, inte namn. AI:s egen text (motiveringar, iakttagelser) kontrolleras mot kända kundvärden och mönster innan den sparas. Trådhistorik från HubSpot ligger bara i minnet (30 min). |
| Åtkomst till sparad data | RLS via `app.can_read_lead_inbox` (aktiv inkorg i en region som användaren har åtkomst till) och funktioner för trådar, analyser, körningar och hämtningar. Användare med åtkomst kan hämta och analysera inom sin region. Hämtningar och körningar kan bara skrivas i det egna namnet. Ingen användare kan ta bort historik. En inaktiverad inkorg eller en borttagen åtkomst döljer datan direkt. Testat i `tests/db/leads.test.ts` (13), `tests/live/leads.test.ts` (5) och i webbläsartestet (URL och server actions för en regionbegränsad användare och en användare utan åtkomst). |
| Bilagor och registreringsnummer (ADR-049) | Från HubSpots meddelanden läses bara vilken sorts bilaga det är (`type`, `fileUsageType` och om filnamnet tyder på en offert). Filnamn och fil-url sparas aldrig och skickas aldrig till OpenAI; modellen ser bara markeringar som "[Bilaga: offertliknande dokument enligt filnamnet]" (testat med ett syntetiskt filnamn som innehåller kundens namn). Av registreringsnumret sparas bara sorten (`plate`, `virtual` eller `other`, med en check-constraint), aldrig numret. |
| RLS-prestanda (ADR-049) | Policyerna på `lead_threads`, `lead_syncs` och `lead_dialogue_analyses` jämför med `app.readable_lead_inboxes()`, som räknas ut en gång per fråga (InitPlan) i stället för en funktion per rad. Reglerna är oförändrade: systemadministratörer läser allt, andra läser aktiva inkorgar i sina regioner (alla 131 databastester och 57 livetester oförändrade och godkända). |
| Länk till HubSpot (ADR-048) | Folke gissar inte HubSpots adress till en konversation. En systemadministratör klistrar in en riktig adress. Folke kontrollerar värden och kontots portal-id och att exakt ett tal i adressen är en befintlig tråd (GET mot HubSpot), och sparar sedan mallen utan frågesträng i `lead_settings`. Länkar öppnas i en ny flik med `rel="noopener noreferrer"`. |
| Webbläsaren | Rapporten innehåller inga kundnamn, e-postadresser, telefonnummer eller meddelandetexter, bara beräknade fakta, säljarnas namn (anställda) och AI-klassificeringar. |
| Extern AI | Bara med `FOLKE_LEAD_ANALYSIS_AI=on` och `FOLKE_AI_PROVIDER=openai`. Dialogerna avidentifieras först (e-post, telefon, personnummer, registreringsnummer, länkar, adresser, signaturer, kundens namn från formuläret och avsändarnamn). Säljare får pseudonymer som översätts tillbaka på servern. En **andra kontroll** stoppar en dialog som fortfarande innehåller ett känt värde eller mönster. `store: false`, inga verktyg och inga användaridentifierare. Strukturerat svar valideras med zod. |
| Kostnad | Användarens dagsbudget, samtidighet och takt kontrolleras per körning och månadsbudgeten före varje anrop. Kostnaden loggas som `lead_analysis`. |
| Avidentifiering, skärpt 2026-10-03 | Valideringen mot riktiga dialoger hittade tre luckor. Alla är rättade och har regressionstester. **(1)** Ett okänt förnamn direkt efter en maskering (`[personnummer] Förnamn`) togs inte av skyddsnätet. **(2)** Ett säljarförnamn som satt ihop med en tid i ett citerat mejlhuvud (`17:21Förnamn`) missades, eftersom en siffra räknades som ordgräns. **(3)** Citerade mejlhuvuden utan "Den …" (`lör 5 sep. 2026 kl. 09:28 skrev …`, `tisdag 8 september 2026 …, <adress>:`) togs inte bort, så att citerad historik följde med. **Före rättelsen skickades några sådana förnamn till OpenAI** (`store: false`) i folke-dev-testerna 2026-10-02 och 2026-10-03. Efter rättelsen: inga kända kundvärden, inga säljarnamnsdelar och inga citathuvuden finns kvar i 84 av 84 riktiga dialoger, och ord med inledande versal som bara förekommer i en dialog maskeras. |
| Kvarvarande risk | Mönsterbaserad avidentifiering kan fortfarande missa ett ovanligt namn som också är ett vanligt ord, eller ett namn som återkommer i flera dialoger, till exempel en kollegas. Därför är AI-analysen avstängd som standard och kräver ett uttryckligt beslut. Avtalsfrågorna för OpenAI ovan gäller även här. |
**Leadanalys i chatten (ADR-050):**

| Skydd | Hur |
|---|---|
| Behörighet | Assistenten "Leadanalys" kräver både en assistentbehörighet och leadåtkomst. Utan leadåtkomst ger `/api/chat` 403 och loggar `access.denied` innan något sparas, och insert-policyn för konversationer kräver `app.has_lead_access()` och dataklassen `lead`. Allt läses med användarens egen klient, så RLS avgör varje rad. Indragen åtkomst stoppar nästa fråga, och gamla leadkällor visas inte längre. |
| Urval | Sidans urval ("Fråga Folke") och konversationens sparade urval (`lead_context`) valideras med zod och löses på nytt mot vad användaren får se, varje tur. Ett förfalskat id ignoreras. Ett namn utanför åtkomsten ger "hittar ingen …" utan att avslöja om det finns. `assistants.kind` kan bara ändras i databasen. |
| Extern AI | Bara med `FOLKE_LEAD_CHAT_AI=on`, `FOLKE_LEAD_ANALYSIS_AI=on` och `FOLKE_AI_PROVIDER=openai`. Anropet innehåller underlaget (siffror med population, avidentifierade motiveringar, inkorgs- och regionnamn, bil och källa), frågan och historiken. Synliga säljare ersätts med "Säljare N" och mappas tillbaka på servern. Andra kända säljarnamn och delade förnamn blir "[namn]". Inga tråd-id, HubSpot-länkar, kundnamn, e-postadresser, telefonnummer eller dialogtexter skickas. `store: false`, inga verktyg och inga användaridentifierare. Kontrollerat i folke-dev genom att spela in exakt det som skickades i 31 anrop (0 säljarnamn, 0 långa id, 0 länkar, 0 kända kundvärden). |
| Åtgärder från chatten | "Uppdatera från HubSpot" och "Analysera dialogerna" visas när underlag saknas, men körs bara när användaren klickar. De anropar samma server actions som Leadanalys-sidan, som löser urvalet på nytt via RLS och kontrollerar åtkomst och kostnadsgränser. Testat med förfalskade anrop för en annan regions inkorg: båda nekades, utan hämtning, körning eller kostnad. |
| Fynd 2026-10-04 (rättat före release) | **(1)** En sparad sammanvägning refererar till säljare som `{{A-…}}` (HubSpot-användar-id). Texten gick in i underlaget oförändrad, så ett id skickades till OpenAI i ett anrop i folke-dev (`store: false`). Id:t översätts nu till aliaset. **(2)** Förnamnet "Per" maskerades skiftlägesokänsligt, så "per telefon" i historiken blev "Säljare N telefon". Förnamn som också är vanliga ord räknas nu bara med versal. Båda har regressionstester. En sista kontroll (`assertNoIdentifiers`) stoppar nu anropet om underlaget eller tidigare svar innehåller ett HubSpot-id, en säljartoken eller en HubSpot-länk. |
| Kvarvarande risk | Det användaren själv skriver skickas, efter att säljarnamn ersatts. Ett förnamn som också är ett vanligt ord ("per", "hans") och skrivs med gemener ersätts inte. Ett kundnamn som användaren skriver in fångas inte. Samma ansvar gäller som i den vanliga chatten. |
| Lagring | Frågor och svar sparas som andra konversationer. Leadkällor sparar tråd-id, rubrik, inkorg, säljarens namn och den avidentifierade motiveringen, men inga dialogtexter. `lead_context` innehåller bara id och en period. |
| Kostnad | Samma spärrar som chatten (`beginAIRequest`). Kostnaden loggas som `lead_chat` med dataklassen `lead`. |
| Tester | `src/server/lead-chat/lead-chat.test.ts` (40), `tests/db/leads.test.ts` (4 nya), `tests/live/lead-chat.test.ts` (3) och ett webbläsar- och API-test i folke-dev (48 kontroller: 10 testkonversationer, fria formuleringar, åtkomst, PII, källor och vanlig chatt). |

- Täcks av `tests/db/ai-guard.test.ts` (4 tester) och `tests/ai-eval/retrieval.eval.ts`. Utvärderingen kontrollerar bland annat att utgångna dokument aldrig hamnar i kontexten.

## Extern AI (OpenAI)

**Policy (ADR-031, ADR-036):** inga dokument är godkända för extern AI-behandling som standard. I folke-dev (`approved-documents`) får en systemadministratör godkänna enskilda dokument. Då skickas deras utdrag och embeddings, samt frågor och svar i vanliga konversationer, till OpenAI. Ej godkända dokument skickas aldrig. Pilotprojektet är i mockläge. Syntetiska testdata används för automatiserade tester.

### Spärren i lager

| Lager | Vad det stoppar |
|---|---|
| `FOLKE_AI_PROVIDER` (server) | Standard är `mock`, så inga externa anrop görs alls. Pilotprojektet körs i mockläge. |
| `FOLKE_AI_EXTERNAL_DATA=synthetic-only` | Det enda tillåtna värdet. Allt annat stoppar uppstarten av AI-funktionen. |
| `documents.ai_data_class` | Standard är `internal`. `approved` sätts bara via godkännandefunktionen (systemadministratör), aldrig genom ändrad metadata. Återkallelse tar bort embeddings. `synthetic` sätts bara av servern. |
| `profiles.ai_test_access` | Bara systemadministratören kan ge behörigheten, via servern, och ändringen loggas. Användare kan inte ge sig själva den. |
| `conversations.data_class` | En syntetisk konversation kan bara skapas med AI-testbehörighet (RLS) och kan aldrig ändras. Vanliga konversationer besvaras alltid i mockläge. |
| Hämtning | Vanliga konversationer med OpenAI hämtar **bara** godkända dokument, och syntetiska konversationer bara syntetiska. Klassen kontrolleras vid varje fråga. RLS gäller som vanligt (grupp, assistent, granskning, giltighet). |
| Historik | Tidigare svar skickas bara med om deras källdokument fortfarande är läsbara och godkända |
| Slutkontroll före anrop (`assertExternalAllowed`) | Avbryter om policyn inte tillåter konversationstypen eller om något utdrag har fel klass |
| Trigger på `document_chunks` | Embeddings kan bara sparas för godkända eller syntetiska dokument, även med servernyckeln |

Användarens egen text i en syntetisk konversation kan tekniskt sett innehålla vad som helst. Därför ges testbehörighet bara till utsedda testare, och gränssnittet varnar tydligt: "Skriv inte in verklig information".

### Anropen

- OpenAI:s officiella SDK och Responses API med strömning, `store: false` och `max_output_tokens`. Inga verktyg, ingen filuppladdning och inga vector stores. Dokument och vektorer lagras bara i Supabase.
- Inga användaridentifierare skickas: ingen `safety_identifier`, inga namn, e-postadresser, id:n eller metadata. Utdrag skickas med titel och sida.
- `maxRetries: 0` och tidsgräns 45 sekunder. Fel visas på svenska utan leverantörens feltext. En fråga som misslyckas tas bort, så att ett nytt försök inte ger dubbla meddelanden.
- Endast endpoints `api.openai.com` och `eu.api.openai.com` accepteras. Den senare används bara om projektet har godkänd EU-dataresidens.

### Öppna avtals- och integritetsfrågor (blockerar intern information)

| Fråga | Status |
|---|---|
| Juridisk motpart (OpenAI Ireland Ltd för EU-kunder?) och vem som tecknar för Börjessons | Öppen |
| Personuppgiftsbiträdesavtal (DPA) | Öppen |
| EU-dataresidens: projekt i regionen Europe, krav på godkännande, +10 % på nyare modeller | Öppen. Utvecklingsprojektet använder den globala endpointen. |
| Underbiträden och tredjelandsöverföring | Öppen |
| Loggning och lagring hos OpenAI: `store: false` är **inte** Zero Data Retention. Standard för missbruksövervakning är upp till 30 dagar. ZDR eller Modified Abuse Monitoring kräver godkännande. | Öppen |
| Att API-data inte används för träning (enligt OpenAI:s villkor) bekräftas i avtalet | Öppen |
| Beslut om vilka dokument som får behandlas | Aktiverat i folke-dev som godkännande per dokument (ADR-036). Pilotprojektet: ej aktiverat. |

### Godkännandeflöde (ADR-036)

`public.set_document_ai_approval(dokument, true/false)` är den enda vägen mellan `internal` och `approved`. Funktionen kräver systemadministratör, kräver att texten är inläst, loggas i säkerhetsloggen och tar bort embeddings vid återkallelse. Testat i PGlite, live och i webbläsaren.

## Granskning 2026-10-01

Utförd mot den riktiga Supabase-miljön (se SETUP.md, avsnitt 2):

- **Behörigheter i databasen:** explicita grants granskade. `anon` har ingen tabellåtkomst, `service_role` har alla, och `authenticated` har bara de kolumner som behövs. RLS är provat live med fem roller och sessionstyper.
- **Server:** samtliga 27 server actions kontrollerar sessionen eller rollen först (inloggningsstegen verifierar via Supabase Auth). Den hemliga nyckeln används på 13 ställen, alla efter en behörighetskontroll.
- **Hemligheter:** den hemliga nyckeln finns inte i klientbundlen, serverbygget, repot eller git-historiken. `.env.local` ignoreras.
- **Fynd som åtgärdats:**
  1. TOTP-återställning stängde inte befintliga sessioner. `app.authorized()` kräver nu registrerad faktor.
  2. Sessionscookies var läsbara för JavaScript. De är nu `httpOnly` med en livslängd på 7 dagar.
  3. CSP saknades. Nu finns nonce-baserad CSP och HSTS.
  4. Fem servermoduler saknade `server-only`.
  5. Testdata (kostnadsposter) blev kvar efter tester. Städningen är rättad och de kvarlämnade raderna är borttagna.
- **Loggning:** inga lösenord, tokens eller TOTP-hemligheter (kontrolleras automatiskt i livetesterna). E-postadress loggas vid misslyckad inloggning bara om den är en giltig adress, så att ett lösenord som skrivits i fel fält inte loggas. IP-adress och webbläsare loggas för spårbarhet.

## Kvar att göra

- Rate limiting av chatten i mockläge och av inloggning i appen. Externa AI-anrop begränsas sedan MVP 0.3. Supabase begränsar inloggning.
- Larm på upprepade misslyckade inloggningar och nekad åtkomst.
- Periodisk genomgång av behörigheter (pilotansvarig).
- Penetrationstest före bredare utrullning.
