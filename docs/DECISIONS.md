# Beslut

Korta beslutsposter i ADR-stil. Nya beslut läggs till sist. Ett beslut som ändras markeras som *Ersatt av ADR-xxx*.

---

### ADR-001 – Next.js 16 med App Router

**Beslut:** Next.js (App Router), React 19 och TypeScript i strict-läge.
**Motiv:** Serverkomponenter gör att data och behörighet kan hanteras på servern från början. Route handlers och server actions ger backend-for-frontend utan separat API-server. Förstklassigt stöd på Vercel.
**Konsekvens:** Next 16 kallar middleware för `proxy.ts`, och `params`/`searchParams` är promises. Läs `node_modules/next/dist/docs` vid osäkerhet (se AGENTS.md).

### ADR-002 – shadcn/ui (Radix) som komponentgrund

**Beslut:** shadcn/ui med Radix och förinställningen "Nova". Komponenterna ligger i `src/components/ui` och ägs av projektet.
**Motiv:** Tillgängliga primitiver utan inlåsning i ett tungt komponentbibliotek. Koden kan anpassas fritt.
**Konsekvens:** Anpassningar (tabell, overlay, Toaster) görs direkt i filerna. Om shadcn-CLI:n körs igen med `--overwrite` måste de göras om.

### ADR-003 – Tailwind CSS 4 med tokens i CSS

**Beslut:** Designtokens definieras i `globals.css` (`@theme`) i två nivåer: varumärkesskalor och semantiska tokens.
**Motiv:** En plats för paletten. Komponenter refererar semantiska namn.

### ADR-004 – Endast ljust tema i etapp 1

**Beslut:** Mörkt tema byggs inte nu. `next-themes` är borttaget.
**Motiv:** Kravet är vit eller mycket ljus bakgrund. Ett halvfärdigt mörkt tema skulle behöva underhållas utan att användas.
**Konsekvens:** Tokens är semantiska, så ett mörkt tema kan läggas till senare utan att komponenterna ändras.

### ADR-005 – Serverlager med `server-only` och repositories

**Beslut:** All dataåtkomst går via `src/server/data/*`. I etapp 1 läser funktionerna från mockdata.
**Motiv:** Frontenden behöver inte skrivas om när databasen kopplas in, och data kan inte av misstag läcka till klientbundlen.

### ADR-006 – Sessionsgränssnitt utan skenbar autentisering

**Beslut:** `getSession()` returnerar en uttryckligen märkt demoanvändare (`isPrototype: true`). Inloggningsformuläret skickar ingenting och är tydligt märkt som prototyp.
**Motiv:** Ingen egen auth ska byggas, och inget får se ut som ett säkerhetsskydd det inte är. Gränssnittet finns ändå, så att sidorna redan är skrivna mot det riktiga mönstret.

### ADR-007 – Separat assistentåtkomst och dokumentåtkomst

**Beslut:** Roller, assistenttilldelning (grants till användare eller grupp) och dokumentsynlighet är tre separata begrepp (`lib/domain`).
**Motiv:** Kravet att behörighet till assistenter och till dokument ska vara separata. Retrieval måste filtrera på båda.

### ADR-008 – Leverantörsneutral AI-abstraktion och NDJSON-protokoll

**Beslut:** Ett eget `AIProvider`-gränssnitt och ett eget strömprotokoll (`sources`/`text`/`done`/`error` som NDJSON).
**Motiv:** AI-leverantören är inte vald. Protokollet är litet och lätt att förstå.
**Alternativ:** Vercel AI SDK, som stöder många leverantörer och har färdiga UI-hooks. Den är en stark kandidat att *implementera* `AIProvider` med när leverantören är vald. Om AI SDK:s UI-protokoll tas i bruk ersätts `lib/chat/*` och `useChat`.

### ADR-009 – Inter via `next/font`

*Ersatt av ADR-013.*

**Beslut:** Inter laddas med `next/font/google`, som hämtar filerna vid build och sedan serverar dem från den egna domänen.
**Konsekvens:** Builden kräver nätverksåtkomst till Google Fonts. Om det är ett problem kan `@fontsource-variable/inter` användas i stället.

### ADR-010 – Svenska i gränssnittet, engelska i koden

**Beslut:** All användarsynlig text är på svenska och samlas i komponenter eller `lib/domain/labels.ts`. Ingen i18n-ram införs nu.
**Motiv:** Endast svenska användare. Ett i18n-bibliotek kan införas senare om behovet uppstår.

### ADR-011 – Prompt från startsidan via sessionStorage

**Beslut:** Snabbstarten lägger prompten i `sessionStorage` i stället för i URL:en.
**Motiv:** Användartext ska inte hamna i webbläsarhistorik, delade länkar eller serverloggar.
**Ersätts av:** en server action som skapar konversationen, när persistens finns.

### ADR-012 – Markdown utan rå HTML

**Beslut:** Assistentsvar renderas med `react-markdown`, `remark-gfm` och `remark-breaks`. Rå HTML renderas inte.
**Motiv:** Modellutdata ska aldrig kunna injicera markup eller skript.

### ADR-013 – Geist Sans som primärt typsnitt

**Beslut:** Geist Sans ersätter Inter i hela gränssnittet. Geist Mono används för monospace, till exempel kod. Båda laddas med `next/font/google` och kopplas centralt via `--font-sans`, `--font-heading` och `--font-mono` i `globals.css`.
**Konsekvens:** Storlekar, vikter, radavstånd och övrig design är oförändrade. De Inter-specifika OpenType-inställningarna (`cv11`, `ss01`) togs bort, eftersom de betyder något annat i Geist. Builden kräver fortfarande nätverksåtkomst till Google Fonts.

---

## Öppna beslut inför etapp 2

| Fråga | Alternativ | Att väga in |
|---|---|---|
| **AI-leverantör** | Anthropic (Claude), OpenAI, Azure OpenAI, Google, Mistral med flera | Datalagring och behandling inom EU, avtal (DPA), zero data retention, kvalitet på svenska, kostnad |
| **Databas och auth** | Supabase (Postgres, Auth, Storage, pgvector), alternativt Neon + separat auth | Region i EU, TOTP-stöd, RLS, självhosting kontra managed |
| **Embeddings och vektorlager** | pgvector i samma databas, alternativt separat vektordatabas | Enkelhet kontra skala. För 20–50 användare räcker pgvector sannolikt. |
| **Textutvinning ur dokument** | Egen pipeline, alternativt tjänst | Kvalitet på Excel/PowerPoint och skannade PDF:er |
| **Loggning och lagringstid** | – | Hur länge konversationer sparas, vem som får se dem och om promptar loggas |
| **SSO** | E-post + lösenord + TOTP (planerat), eventuellt Microsoft Entra ID senare | Befintlig identitetsplattform hos Börjessons |
| **Node-version** | 22 LTS (rekommenderas), lokal miljö kör 20.17 | Vissa verktyg kräver ≥ 20.19 |
| **Testverktyg** | Vitest + Testing Library, Playwright | Införs i etapp 2 |
