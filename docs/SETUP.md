# Installation, konfiguration och status

Gemensam referens för utvecklingsmiljön. Dokumentera **aldrig** nycklar, lösenord eller andra hemligheter här.

**Senast uppdaterad:** 2026-10-01 · **Version:** MVP 0.3 (under utveckling) · **Miljöer:** pilotprojektet och ett separat utvecklingsprojekt i Stockholm (avsnitt 4) · **AI:** mockläge, OpenAI endast för syntetiska testdata i utvecklingsprojektet (avsnitt 10)

---

## 1. Färdigkonfigurerat

### Supabase

| Område | Status |
|---|---|
| Projekt | **North EU (Stockholm)**, plan **Free** under utvecklingen |
| CLI | Länkat till projektet (`npx supabase link`) |
| Migrationer | Pilotprojektet: de **åtta** migrationerna i MVP 0.2 är körda, till och med `20261002100000_require_mfa_enrollment.sql`. MVP 0.3-migrationen `20261003090000_ai_integration.sql` körs **först i utvecklingsprojektet** och i pilotprojektet bara efter godkännande (avsnitt 6). |
| Registrering | Öppen registrering **avstängd**. Användare skapas bara via inbjudan. |
| MFA | TOTP **aktiverat** |
| Lösenord | Minst **12 tecken** |
| URL:er | Site URL `http://localhost:3000` · Redirect URL `http://localhost:3000/auth/confirm` |
| E-postmallar | Anpassade i Supabase. Länkarna går till `/auth/confirm?token_hash=…&type=…` (avsnitt 7). |
| Custom SMTP | Resend (avsnitt 7) |
| Administratör | Christoffer Arvidsson: **Systemadministratör**, aktiv, TOTP registrerad |

### Domän och e-post

| Område | Värde |
|---|---|
| Domän | **heyfolke.se**, registrerad och DNS hos **Loopia** |
| Transaktionsmejl | **Resend**, region Ireland (eu-west-1). Domänen är verifierad och alla DNS-poster godkända. |
| Avsändare | `Folke <no-reply@heyfolke.se>` |
| Webb | heyfolke.se pekar **inte** på någon publicerad app. `beta.heyfolke.se` är reserverad som möjlig testmiljö. |

### Lokalt

`.env.local` finns med alla variabler (avsnitt 4). Node.js 24.

---

## 2. Verifierat mot den riktiga backenden

Senaste verifiering: **2026-10-01**. Den gjordes med syntetiska testanvändare (`…@folke.example`, och `delivered+…@resend.dev` för mejl) och syntetiska dokument, som togs bort efteråt (avsnitt 5). Christoffers konto, grupp och dokument rördes inte.

**Av Christoffer i appen:** inloggning med Microsoft Authenticator, administratörsroll, skapa grupp och tilldela sig själv, uppladdning och godkännande av Word-dokument, att Säljassistenten hittar dokumentet med källhänvisning, och att Analysassistenten *inte* hittar det.

**Automatiskt i webbläsare (65 kontroller) och via API (23 tester, `npm run test:live`):**

| Område | Verifierat |
|---|---|
| Inbjudan | Via **Administration → Bjud in**: mejlet accepteras av SMTP (Resend), användaren blir *medarbetare, inbjuden* i vald grupp |
| Onboarding | Inbjudningslänk, lösenord (policy i formulär och server), QR-kod, TOTP och aktivering |
| Inloggning | Lösenord → TOTP. Fel lösenord och fel kod nekas med generiska meddelanden. Utan TOTP nås inga sidor eller data. |
| Lösenordsåterställning | Mejlet skickas via SMTP, och länken leder till val av lösenord. Ogiltiga länkar nekas. |
| Sessioner | Token har `aal2` med tidsstämplad `amr` (grund för 7-dagarsregeln). Cookies är `httpOnly`. |
| Roller | Rollbyte via UI gäller **direkt** för inloggad användare. Uppgradering och nedgradering är provade. |
| Inaktivering | Befintlig session loggas ut, API:t nekas (401), ny inloggning nekas. Återaktivering fungerar. |
| TOTP-återställning | Befintlig session stängs **direkt** och användaren måste registrera ny faktor |
| Grupper och behörigheter | Medlemskap via dialog och assistenter via matris gäller direkt (borttagen grupp ger 403). Individuella tilldelningar fungerar. |
| Självhöjning | Användare kan inte ändra egen roll, status, MFA, grupp, assistent eller kostnadspost. Administratörer kan inte ändra sin egen roll. |
| Dokumentformat | **PDF, Word, Excel, PowerPoint, text, Markdown och CSV**: uppladdning, textutvinning, indexering och sökning |
| Felaktiga filer | Över 50 MB, filtyp som inte stöds, tom fil, falsk PDF (signaturkontroll) och fil utan text: alla stoppas med begripligt meddelande |
| Granskning | Väntande dokument används inte. Godkännande och avvisning med motivering. Arkivering och borttagning (inklusive fil) tar bort dokumentet ur sökningen. |
| Giltighet | Utgånget dokument används inte som källa |
| Delning | Delning med annan grupp gäller direkt och kan återkallas. Dokument utanför användarens grupper syns inte via URL eller API. |
| Lagring | Användare kan inte ladda ned, signera, lista eller ladda upp direkt mot bucketen. Bucketens gränser för storlek och filtyp gäller även med giltig uppladdningstoken. Behörig nedladdning via 60-sekunderslänk fungerar. |
| Chatt | Svar med källa till rätt dokument **och rätt avsnitt**. Konversationen sparas, kan återupptas och tas bort av ägaren. Nätverksfel visas med "Försök igen". |
| Integritet | Administratörer kan inte läsa, öppna, skriva i eller ta bort andras konversationer (UI, API och databas) |
| Gallring | Bara administratörer. Vyn visar bara antal. Gränsen på 12 månader gäller. Endast inaktiva konversationer raderas. |
| Säkerhetslogg | Händelser loggas med rätt aktör, utan lösenord eller tokens |
| Säkerhetsheaders | CSP med nonce (inga överträdelser under hela flödet), HSTS, X-Frame-Options med flera |

---

## 3. Återstår att verifiera

| Funktion | Hur och varför |
|---|---|
| Att mejl faktiskt **landar i inkorgen** hos andra mottagare än Christoffer | Testerna använder Resends testadress, så leverans är bekräftad till SMTP-nivå. Prova med en kollega när piloten startar. |
| 7-dagarsgränsen i realtid | Testad med konstruerade tokens (RLS) och enhetstester. Inträffar först efter 7 dagar. |
| Gallring av riktigt gamla konversationer | Testad med syntetisk, bakdaterad konversation. Gäller i praktiken först efter 12 månader. |
| Mobil layout med riktiga data | Skärmdumpar är granskade. Bör provas på telefon. |
| Skannade PDF:er | Stöds inte (ingen OCR) och markeras som fel |
| Riktig AI-modell med interna dokument | Inte tillåtet förrän leverantörsavtal och behandling är godkända. Med syntetiska data, se avsnitt 10. |

---

## 4. Utvecklingsmiljö

```bash
npm install
npm run dev          # http://localhost:3000
npm run check        # lint + typecheck + enhets- och RLS-tester (lokalt, PGlite)
npm run test:live    # säkerhetstester mot Supabase-projektet i .env.local (syntetiska användare)
npm run test:ai-eval # svenska kvalitetstester med riktiga OpenAI-anrop, endast syntetiska data (kostar några cent)
npm run build
```

### Två Supabase-projekt

| Projekt | Används till | AI |
|---|---|---|
| **Pilotprojektet** (det befintliga) | Christoffers administratörskonto, MFA, grupper och dokument. Lämnas orört under MVP 0.3. | Mockläge |
| **Utvecklingsprojektet** `folke-dev` (Stockholm, Free) | Nya migrationer, livetester och AI-tester med syntetiska data | OpenAI för syntetiska testkonversationer |

`.env.local` pekar på utvecklingsprojektet under MVP 0.3. Pilotens värden sparas i `.env.pilot.local` (ignoreras av git, precis som `.env.local`). Byt miljö genom att byta fil och länka CLI:t:

```bash
npx supabase link --project-ref <projekt-ref>   # dev eller pilot
```

> **Kör inte MVP 0.3-koden mot pilotprojektet** förrän migrationen har körts där. Koden läser kolumner som bara finns efter `20261003090000_ai_integration.sql`. Tills dess används `git checkout v0.2.0` mot piloten.

### Miljövariabler (`.env.local`)

Mallen finns i `.env.example`. `.env.local` ignoreras av git och delas aldrig, inte heller i chattar eller ärenden.

| Variabel | Källa (Supabase → Project Settings) | Exponering |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | API → Project URL | Publik |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | API Keys → Publishable key | Publik (RLS skyddar data) |
| `SUPABASE_SECRET_KEY` | API Keys → Secret key | **Endast server.** Kringgår RLS. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` lokalt | Används i e-postlänkar |
| `FOLKE_AI_PROVIDER` | `mock` (pilot) eller `openai` (utveckling) | `openai` gäller **endast** syntetiska testkonversationer (avsnitt 10) |
| `FOLKE_ENVIRONMENT` | `development` i utvecklingsprojektet | Krävs för att AI-livetesterna ska köras |
| `OPENAI_API_KEY` m.fl. | OpenAI-projektet, se avsnitt 10 och `.env.example` | **Endast server** |

Om en hemlig nyckel kan ha exponerats: rotera den i Supabase (API Keys) och uppdatera `.env.local`.

### Syntetisk testdata

```bash
npm run seed:synthetic              # testgrupper, behörigheter, sex syntetiska dokument
npm run seed:synthetic -- --remove  # tar bort allt skriptet lagt till
```

Kräver en **aktiv** systemadministratör. Inga verkliga dokument får laddas upp innan leverantörer och databehandling är godkända.

### Tester mot det riktiga projektet

`npm run test:live` kör säkerhetstester mot Supabase-projektet (PostgREST, Auth, Storage och RLS). Regler:

- **Endast syntetiska användare** (`live-…@folke.example`), skapade via admin-API:t, så inget mejl skickas. Testgrupper heter `Test – live …` och dokument taggas `syntetisk`.
- Allt som skapas tas bort efteråt: dokument, filer, grupper, kostnadsposter och användare. **Säkerhetsloggen lämnas orörd** (append-only), så testanvändarnas händelser syns där som "Borttagen användare".
- Befintliga användare, grupper och dokument ändras aldrig. Gallringstestet raderar bara om den enda konversationen äldre än 13 månader är testets egen.
- Gränssnittstestet i webbläsaren (65 kontroller) kördes 2026-10-01 med samma regler. Mejl gick då till Resends testadress `delivered@resend.dev`. Det ska automatiseras med Playwright i en egen testmiljö (ROADMAP).

---

## 5. Administratörer och användare

### Första administratören (redan gjort)

```bash
npm run bootstrap:admin -- <e-post> "<namn>"            # ny eller befintlig användare
npm run bootstrap:admin -- <e-post> "<namn>" --resend   # skicka inbjudan igen (om den inte accepterats)
```

Skriptet är idempotent. En befintlig användare får rollen utan ny inbjudan och utan dubbletter. Skriptet vägrar köra om en **annan** aktiv systemadministratör redan finns.

### Övriga användare

**Administration → Användare → Bjud in användare.** Tilldela grupper och sedan assistenter under **Behörigheter**. Om någon byter telefon: **Återställ tvåstegsverifiering** i användarens meny.

---

## 6. Databasändringar

1. Skapa en **ny** migration i `supabase/migrations/` (`YYYYMMDDHHMMSS_namn.sql`). Ändra aldrig en migration som redan körts.
2. Nya tabeller behöver: RLS, policies, **explicita `grant`** till `authenticated` och `service_role` (projektet ger inga automatiska tabellbehörigheter) samt tester i `tests/db/`.
3. `npm run test:db`
4. Kontrollera att CLI:t är länkat till **utvecklingsprojektet**, kör `npx supabase db push --dry-run` och sedan `npm run db:push`. Kör `npm run test:live`.
5. Pilotprojektet uppdateras först efter godkännande, med samma steg.

**MVP 0.3** (`20261003090000_ai_integration.sql`) är additiv: nya kolumner med säkra standardvärden (`internal`, `false`, `null`), nya tabeller och funktioner samt tillägget `vector`. Inga data tas bort. Befintliga dokument och konversationer blir `internal` och kan aldrig klassas om.

---

## 7. E-post (Resend via Supabase SMTP)

| Inställning (Supabase → Authentication → Emails → SMTP) | Värde |
|---|---|
| Host / port | `smtp.resend.com` / `465` |
| Användarnamn | `resend` |
| Lösenord | Resend-API-nyckel, lagrad **endast** i Supabase |
| Avsändare | `no-reply@heyfolke.se`, namn `Folke` |

- **Mallarna i Supabase-dashboarden gäller.** `supabase/templates/` är referensversioner för lokal utveckling. Länken måste behålla formatet `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (respektive `type=recovery`).
- DNS-poster för Resend (SPF, DKIM, MX för retur) ligger hos Loopia. Ändra dem inte utan att verifiera domänen igen i Resend.
- Mottagaradress och namn behandlas av Resend i EU (Irland).

---

## 8. Återstående beslut

| Beslut | Kommentar |
|---|---|
| **AI-leverantör för intern information** | Ingen godkänd. OpenAI används bara med syntetiska testdata. Öppna avtalsfrågor: se [SECURITY.md](SECURITY.md#extern-ai-openai). |
| **Lagringstid för säkerhetslogg och kostnadsstatistik** | Sparas i dag utan tidsgräns (se [ARCHITECTURE.md – Livscykel](ARCHITECTURE.md#livscykel-och-gallring)) |
| **Radering av användarkonton** | I dag kan konton bara inaktiveras. Rutin för permanent radering (t.ex. vid anställningens slut) behöver beslutas. |
| **Supabase Pro** | Ger tidsbegränsade sessioner i Auth, skydd mot läckta lösenord, dagliga säkerhetskopior och fler resurser. 7-dagarsgränsen gäller redan via appen och databasen. |
| **Produktionsdriftsättning** | Plattform (förberett för Vercel), miljöer och godkännande |
| **Domän för appen** | t.ex. `beta.heyfolke.se`. Kräver DNS hos Loopia och uppdaterad Site URL/Redirect URL i Supabase. |
| **Godkännande av databehandling** | Krävs innan verkliga interna dokument laddas upp |
| **Separat projekt för test/produktion** | Utvecklingsprojektet bör inte bli produktion |

---

## 9. Felsökning

| Symptom | Orsak / åtgärd |
|---|---|
| `permission denied for table …` | Tabellbehörighet saknas. Lägg till `grant` i en ny migration (avsnitt 6). |
| "Folke är inte konfigurerad" | `.env.local` saknas eller variabelnamn är fel. Starta om `npm run dev`. |
| "Länken är ogiltig eller har gått ut" | Länken är använd eller för gammal, eller mallen saknar `token_hash`. Skicka en ny med `--resend` eller **Glömt lösenordet?**. |
| Inloggad men tomma listor | Användaren saknar grupper eller assistentbehörigheter. |
| "Koden stämmer inte" vid TOTP | Kontrollera att telefonens tid är automatisk. Skanna den senast visade QR-koden. |
| Inget mejl kommer fram | Kontrollera Resend → Logs och Supabase → Auth Logs. |
| AI: "Du har nått dagens AI-budget" | Spärr per användare (`FOLKE_AI_USER_DAILY_LIMIT_USD`). Höj värdet i `.env.local` eller vänta till nästa dag. |
| AI: "Den valda AI-modellen är inte tillgänglig" | Modellen saknas i OpenAI-projektet. **Administration → AI och modeller → Kontrollera modeller**. |
| AI: "AI-tjänsten är felkonfigurerad" | Nyckeln saknas, är fel eller saknar behörighet till Responses/Embeddings. Kontrollera nyckeln i OpenAI-projektet. |
| Syntetiskt testläge syns inte i chatten | Kräver `FOLKE_AI_PROVIDER=openai`, en nyckel och **AI-testbehörighet** för användaren (Administration → AI och modeller). |

---

## 11. Riktiga dokument med OpenAI (folke-dev)

Gäller utvecklingsprojektet med `FOLKE_AI_PROVIDER=openai` och `FOLKE_AI_EXTERNAL_DATA=approved-documents`. Pilotprojektet påverkas inte. Beslut: ADR-036.

### Så laddar du upp ett dokument, godkänner det och ställer frågor

1. **Ladda upp:** **Kunskapsbank → Ladda upp dokument**. Välj fil, titel, samling, ansvarig grupp, vilka **assistenter** som får använda dokumentet och vilka grupper det delas med. Intyga att det är internt utan kunduppgifter.
2. **Granska:** öppna dokumentet och klicka **Godkänn**. Det är den vanliga granskningen, som avgör att dokumentet får användas som källa.
3. **Godkänn för OpenAI:** i samma panel, avsnittet **OpenAI**, klicka **Godkänn för OpenAI** och bekräfta. Folke skapar embeddings direkt. Statusen visas som *OpenAI: godkänt* när indexeringen är klar, eller som *OpenAI: indexeringsfel* med en förklaring och knappen **Indexera igen**.
4. **Fråga:** behöriga användare öppnar **Ny chatt** med en av dokumentets assistenter och ställer frågan som vanligt. Svaret kommer från OpenAI med källkort som visar dokument och sida.

Ändra assistenter i efterhand med **Ändra assistenter** i panelen. **Återkalla godkännande** i samma avsnitt gäller direkt: dokumentet används inte i nästa AI-svar och dess embeddings tas bort.

### Vad som gäller

- Godkännandet gäller **ett dokument i taget** och är avstängt som standard. Inga befintliga dokument godkänns automatiskt.
- Ett godkänt dokument används bara om det också är granskat och godkänt, giltigt, delat med användarens grupp och kopplat till assistenten. Allt detta kontrolleras i databasen innan text hämtas.
- Ej godkända dokument skickas aldrig till OpenAI, varken som svar eller som embeddings.
- Till OpenAI skickas assistentens instruktioner, regler, frågan, en begränsad historik och de hämtade utdragen med titel och sida. Inga namn, e-postadresser, användar-id eller andra interna metadata skickas.
- Syntetiskt testläge (avsnitt 10) finns kvar för automatiserade tester och behövs inte för vanliga konversationer.

### AI-instruktioner

**Administration → AI-instruktioner.** Gemensamma instruktioner (systemadministratörer) och instruktioner per assistent (administratörer och assistentansvariga).

1. Ändra texten och klicka **Spara utkast**. Utkastet gäller **inte** för användarna. Märkningen visar *Utkast, inte publicerat*.
2. **Förhandsgranska** visar hela instruktionen, publicerad eller med utkast, med eller utan exempel på användarönskemål.
3. **Testa med OpenAI** (per assistent): skriv en fråga och jämför ett svar med publicerade instruktioner mot ett svar med utkastet. Båda använder samma modell och samma hämtade dokumentutdrag, med dina behörigheter och bara godkända dokument. Underlaget visas. Svaren kan ändå variera mellan anrop. Inget sparas som konversation, men anropen räknas mot din AI-budget.
4. **Publicera** gör utkastet aktivt för nya svar och sparar en version i **Historik**. **Kasta utkast** behåller den publicerade versionen.

- **Samtidiga ändringar:** om någon annan har sparat eller publicerat under tiden visas *"har ändrats av någon annan"*, och ingenting skrivs över. Ladda om sidan.
- **Återställa en version:** klicka **Använd** i historiken. Finns ett utkast måste du bekräfta. Texten laddas i redigeraren och sparas först när du klickar **Spara utkast**.
- **Assistentvyn** (Administration → Assistenter) visar instruktionerna skrivskyddat.
- De **fasta reglerna** om källor och säkerhet visas skrivskyddade.
- **Kundtexter** (mejl, SMS) har inga källmarkörer i själva texten. Källor och kontrollpunkter visas efter texten under "Underlag för medarbetaren", och servern flyttar dit eventuella markörer som hamnat i kundtexten.
- **Användarnas önskemål** (version 2) om längd, detaljnivå och ton går före allmänna stilanvisningar, men aldrig före uppdrag, obligatoriska format, regler, fakta, källkrav eller behörigheter. Undvik därför ord om svarslängd ("kortfattat", "utförligt") i assistentinstruktionerna, om de inte är ett obligatoriskt format.

### Personlig introduktion och Mina AI-inställningar (version 2)

- **Inbjudan:** "Erbjud personlig introduktion" är förvalt i inbjudningsdialogen. Användaren möter introduktionen vid första inloggningen och kan välja **Kom igång**, **Senare** (då visas en påminnelse på startsidan) eller **Hoppa över**.
- **Introduktionen:** tre steg med färdiga exempel (svarslängd, skrivstil för mejl, snabbval och egna önskemål) och en valfri kort introduktion till Folke. Valen sparas efter varje steg.
- **Mina AI-inställningar** finns i användarmenyn och under Inställningar. Där kan användaren se och ändra valen, återställa till standard och starta introduktionen igen. Exemplen uppdateras direkt utan AI-anrop.
- **Testa med riktig AI** (frivilligt, när OpenAI är aktiverat) jämför sparade inställningar med valen på sidan. Testet gör två anrop och räknas mot användarens budget.
- **Prioritet:** inställningarna gäller bara användaren själv och kan aldrig åsidosätta Folkes fasta regler, assistentens uppdrag, obligatoriska format, behörigheter, källkrav eller fakta.
- **Test:** `node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.eval.config.mts tests/ai-eval/personal.eval.ts` (riktiga anrop, syntetiska dokument).

### Chatthistorik

- **Byt namn** och **Ta bort konversation** finns i menyn (⋯) i chattens huvud.
- **Alla konversationer** i sidomenyn visar alla egna konversationer. Där kan man byta namn och markera flera för borttagning. Borttagning kräver alltid bekräftelse.
- Bara ägaren kan ändra eller ta bort en konversation (RLS).

### Verifierat i folke-dev 2026-10-01

Livetester 37/37. Webbläsartest 33/33 med syntetiska användare och testdokument som togs bort efteråt. Christoffers konto och dokument rördes inte.

| Område | Verifierat |
|---|---|
| Status | Panel och lista visar *OpenAI: ej godkänt* eller *godkänt*, vem som godkänt, assistenter och indexeringsstatus |
| Godkännande | Via UI. Indexering av alla textavsnitt (s. 1–3). Ej godkänt dokument får inga embeddings. |
| Svar | Rätt pris med källa *s. 2*, följdfråga med källa *s. 3*. Kostnad registreras som intern konversation med gpt-6-luna. |
| Spärrar | Ej godkänt dokument används aldrig. En annan grupp med samma assistent ser inte dokumentet. |
| Återkallelse | Gäller direkt, embeddings tas bort, och historiken i samma konversation används inte längre som väg till dokumentet |
| Historik | Byt namn, radering av flera med bekräftelse, enskild radering. Andra användares konversationer påverkas inte. |
| Säkerhet | API-nyckeln syns inte i sidorna. Inga JavaScript- eller CSP-fel. |

---

## 10. AI med OpenAI (endast syntetiska testdata)

Gäller tills leverantörsavtal och behandling av Börjessons interna information är godkända. Bakgrund: [SECURITY.md](SECURITY.md#extern-ai-openai) och ADR-031–035 i [DECISIONS.md](DECISIONS.md).

### Vad som skickas till OpenAI

| Skickas | Skickas aldrig |
|---|---|
| Frågor och svar i **syntetiska testkonversationer** av användare med AI-testbehörighet | Konversationer i vanligt läge, även för samma användare |
| Utdrag ur dokument med dataklass `synthetic` (syntetiska testdokument) | Dokument med dataklass `internal`, det vill säga alla befintliga och uppladdade dokument |
| Embeddings av syntetiska textavsnitt och av frågor i syntetiska konversationer | Hela filer. Inga vector stores, inga filuppladdningar och inga verktyg. |

Anrop görs med `store: false`, utan automatiska omförsök och med maxlängd för svaren. `store: false` innebär **inte** Zero Data Retention.

### Aktivera lokalt (utvecklingsprojektet)

1. Lägg in i `.env.local`: `FOLKE_AI_PROVIDER=openai`, `OPENAI_API_KEY` (projektet *Folke Development*) och `FOLKE_ENVIRONMENT=development`. Övriga AI-variabler har standardvärden, se `.env.example`.
2. `npm run dev` och logga in som systemadministratör.
3. **Administration → AI och modeller**:
   - **Kontrollera modeller.** Visar vilka modeller i katalogen projektet har tillgång till. Inga tokens förbrukas.
   - **Läs in testdokument.** Skapar gruppen *AI-test (syntetiskt)*, ger gruppen alla fyra assistenter och lägger in nio fiktiva dokument.
   - **Skapa embeddings.** Kostar mindre än 0,01 USD för hela testsamlingen.
   - Slå på **AI-testbehörighet** för testanvändaren. Användaren läggs då i testgruppen.
4. Öppna **Ny chatt**, slå på **Syntetiskt testläge med OpenAI** och ställ en fråga. Huvudet visar *Syntetiskt test · gpt-6-luna*.

### Byta modell

Under **Administration → AI och modeller → Modell per assistent** väljer du bland godkända modeller. Kostnadsnivå och ungefärlig kostnad per svar visas. Bytet gäller direkt, utan kodändring eller driftsättning.

- Listan med tillåtna modeller finns centralt i `src/server/ai/models.ts`, med pris och datum för kontroll. Med `FOLKE_CHAT_MODELS` kan listan bara **begränsas**, inte utökas.
- En ny modell kräver en kodändring i katalogen och en ny kontroll av pris och tillgänglighet. Det är avsiktligt, så att en modell inte kan aktiveras utan granskning.
- Värden i databasen kontrolleras mot listan vid varje anrop. Okända värden ger standardmodellen.

### Byta embeddingmodell eller textavsnitt

- Embeddingmodellen anges med `FOLKE_EMBEDDING_MODEL` och måste finnas i katalogen. Kolumnen har 1536 dimensioner. En modell med annan dimension kräver en migration.
- Vektorer jämförs bara med frågor gjorda med **samma** modell. Efter ett byte visar AI-sidan antalet avsnitt med "annan modell". Kör **Skapa embeddings** igen, och till dess faller sökningen tillbaka på fulltext.
- Textavsnitt: 1 200 tecken med 200 tecken överlapp (`src/server/documents/chunk.ts`). Ändras storleken behöver dokumenten bearbetas och indexeras om.

### Kostnad och gränser

- **Administration → Användning och kostnad** visar kostnad i SEK och USD per assistent, användare och modell. Embeddings redovisas separat. Anrop utan slutlig tokenrapport, till exempel avbrutna svar, markeras som uppskattade.
- Spärrar i servern, kontrollerade i databasen före varje anrop: budget per användare och dag, månadsbudget, antal samtidiga svar och antal frågor per minut (`FOLKE_AI_*` i `.env.example`).
- Budgeten i OpenAI-projektet är ett extra skydd men **ingen garanterad hård gräns**. Kontrollera också användningen i OpenAI-dashboarden.

### Testa

```bash
npm run check        # bland annat dataspärren, OpenAI-leverantören (fejkad klient) och källkontroll
npm run test:db      # dataklasser, embeddings-spärr, hybridsökning och gränser i databasen (PGlite)
npm run test:live    # samma spärrar mot utvecklingsprojektet (kräver FOLKE_ENVIRONMENT=development)
npm run test:ai-eval # 21 svenska testfall × 2 modeller med riktiga anrop, ca 0,05 USD
# Publicerade instruktioner i folke-dev (läser instruktionerna, ändrar inget, bara godkända och syntetiska dokument):
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.eval.config.mts tests/ai-eval/published.eval.ts
```

### Verifierat i utvecklingsprojektet 2026-10-01

Med syntetiska användare (`ui-ai…@folke.example`) och den syntetiska testsamlingen. Allt togs bort efteråt, och pilotprojektet användes inte. Livetester: 31/31. Webbläsartest: 51/51 kontroller.

| Område | Verifierat |
|---|---|
| AI-sidan | Status utan nyckel, modellkontroll (luna, sol och embeddings tillgängliga), endast systemadministratör |
| Testdata | Inläsning av 9 syntetiska dokument, embeddings för 12 avsnitt (bara syntetiska), embeddingkostnad registreras separat, borttagning via UI |
| Testbehörighet | Ges och återkallas via UI och loggas. Efter återkallad behörighet blir det mockläge i befintlig syntetisk konversation och 403 för nya. |
| Modellval | Rullista med kostnadsnivå. Bytet gäller nästa svar direkt. Ett ogodkänt värde i databasen (`gpt-6-astra`) ger standardmodellen. |
| Chatt | Syntetiskt läge med varning, svar från gpt-6-luna med rätt fakta och källkort, följdfråga med historik, märkning efter omladdning, tokens och kostnad registrerade |
| Hämtning | Semantisk fråga besvaras. Utgångna, ogranskade och andra assistenters dokument används inte. |
| Injektion | Systemprompten avslöjas inte, och instruktioner i dokument följs inte |
| Spärrar | Vanlig konversation (även med testbehörighet) använder mockläge utan OpenAI-kostnad. Användare utan behörighet nekas syntetiskt läge via API (403) och ser det inte i UI. |
| Gränser | Avbrutet svar registreras som `aborted`. Samtidighetsgräns (2) och minutgräns (10) stoppar med svenska meddelanden. |
| Kostnadsöversikt | Embeddings och USD separat, per modell |
| Webb | Inga JavaScript- eller CSP-fel |

### Byta till Börjessons företagsprojekt i OpenAI

Byt `OPENAI_API_KEY` (och vid behov `OPENAI_PROJECT` och `OPENAI_ORGANIZATION`) i servermiljön. Kontrollera sedan modellerna på AI-sidan. Ingen kodändring behövs. Om projektet har godkänd EU-dataresidens sätts `OPENAI_BASE_URL=https://eu.api.openai.com/v1`, annars inte. Dataspärren gäller fortfarande. Att tillåta intern information är ett separat beslut (ADR-031).
