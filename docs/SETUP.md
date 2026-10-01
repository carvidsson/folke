# Installation, konfiguration och status

Gemensam referens för utvecklingsmiljön. Dokumentera **aldrig** nycklar, lösenord eller andra hemligheter här.

**Senast uppdaterad:** 2026-10-01 · **Version:** MVP 0.2 · **Miljö:** utveckling (lokalt mot Supabase-projektet i Stockholm) · **AI:** mockläge

---

## 1. Färdigkonfigurerat

### Supabase

| Område | Status |
|---|---|
| Projekt | **North EU (Stockholm)**, plan **Free** under utvecklingen |
| CLI | Länkat till projektet (`npx supabase link`) |
| Migrationer | Alla **åtta** i `supabase/migrations/` är körda. Den senaste är `20261002100000_require_mfa_enrollment.sql` (avsnitt 6). |
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
| Riktig AI-modell | Planeras i MVP 0.3 ([MVP-0.3-PLAN.md](MVP-0.3-PLAN.md)) |

---

## 4. Utvecklingsmiljö

```bash
npm install
npm run dev          # http://localhost:3000
npm run check        # lint + typecheck + enhets- och RLS-tester (lokalt, PGlite)
npm run test:live    # säkerhetstester mot det riktiga Supabase-projektet (syntetiska användare)
npm run build
```

### Miljövariabler (`.env.local`)

Mallen finns i `.env.example`. `.env.local` ignoreras av git och delas aldrig, inte heller i chattar eller ärenden.

| Variabel | Källa (Supabase → Project Settings) | Exponering |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | API → Project URL | Publik |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | API Keys → Publishable key | Publik (RLS skyddar data) |
| `SUPABASE_SECRET_KEY` | API Keys → Secret key | **Endast server.** Kringgår RLS. |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` lokalt | Används i e-postlänkar |
| `FOLKE_AI_PROVIDER` | `mock` | Ändras först när en leverantör är godkänd |

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
2. Nya tabeller behöver: RLS, policies, **explicita `grant`** till `authenticated` och `service_role` (projektet ger inga automatiska tabellbehörigheter) samt tester i `tests/db/rls.test.ts`.
3. `npm run test:db`
4. `npx supabase db push --dry-run` och sedan `npm run db:push`.

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
| **AI-leverantör** | Ingen godkänd. Förslag: OpenAI med EU-datalagring, se [MVP-0.3-PLAN.md](MVP-0.3-PLAN.md) (öppna avtalsfrågor finns där). |
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
