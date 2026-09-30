# Roadmap

## Etapp 1 – Frontendprototyp och grundstruktur ✅

- Next.js-projekt med TypeScript, Tailwind, shadcn/ui, Lucide och Geist
- Designsystem med tokens från logotypen, typografisk hierarki och gemensamma komponenter
- Vyer: inloggning, startsida, chatt, kunskapsbank, administration (användare, grupper, assistenter, behörigheter) och inställningar
- Tre navigeringslägen: arbetsyta, chatt och administration. Responsivt.
- Domänmodell, behörighetsregler och sessionsgränssnitt
- AI-providerabstraktion med mock-provider och strömmande `/api/chat`
- Syntetisk testdata och dokumentation

## Etapp 2 – Backendgrund (föreslagen)

1. **Beslut:** databas- och auth-leverantör (se DECISIONS, öppna frågor).
2. **Autentisering:** e-post och lösenord med obligatorisk TOTP via leverantören. Ersätt `getSession()`. Skicka oinloggade till `/login`. Invite-flöde.
3. **Datamodell:** tabeller för users/profiles, groups, group_members, assistants, assistant_grants, collections, documents, document_group_shares, conversations och messages.
4. **Row Level Security:** policies för konversationer (ägare), dokument (synlighet) och administration (roll).
5. **Repositories:** byt implementationerna i `src/server/data/*` mot databasfrågor. Ta bort `mock-store.ts`.
6. **Server actions** för administration, med rollkontroll och auditlogg.

## Etapp 3 – AI och konversationer

1. Välj AI-leverantör och implementera `AIProvider` i `src/server/ai/providers/`.
2. Spara konversationer och meddelanden. Ny chatt skapas på servern och omdirigeras till `/chat/[id]`.
3. Generera titlar för nya konversationer.
4. Rate limiting och kostnadsloggning per användare och assistent.
5. Byt namn på och ta bort konversationer, samt sök i historik.

## Etapp 4 – Kunskapsbank och retrieval

1. Fillagring (privat bucket) med signerade uppladdningar och virusskanning.
2. Textutvinning ur PDF, Word, Excel och PowerPoint. Chunkning och embeddings (t.ex. pgvector).
3. Retrieval som filtrerar på **både** assistentens samlingar och användarens dokumentåtkomst, samt på giltighetsperiod.
4. Riktiga källhänvisningar (dokument, sida och utdrag) från retrieval.
5. Påminnelser om dokument som går ut. Versionshantering.

## Etapp 5 – Drift och kvalitet

- Driftsättning på Vercel (efter godkännande), miljöer för preview och produktion
- Content Security Policy, säkerhetsgranskning och penetrationstest
- Övervakning, loggning och datalagringspolicy (GDPR)
- Automatiska tester: enhet (domänregler), komponent och E2E (Playwright)

---

## Prototyp → backend

Komplett lista över det som är prototyp i etapp 1 och vad som krävs för riktig funktion.

| Område | Var i koden | Prototyp idag | Krävs för riktig funktion |
|---|---|---|---|
| Inloggning | `components/auth/login-form.tsx` | Formulär utan `name`. Skickar ingenting. Går direkt till `/`. | Auth-leverantörens inloggning med TOTP. Felhantering och låsning. |
| Session | `server/auth/session.ts` | Fast demoanvändare | Läsa riktig session. Redirect till `/login`. |
| Utloggning | `layout/user-menu.tsx` | Länk till `/login` | Avsluta sessionen hos leverantören |
| Adminskydd | `requireAdministrationAccess()` | Kontroll mot demoanvändarens roll | Samma anrop mot riktig session, plus RLS |
| Assistentåtkomst | `server/data/assistants.ts` | Regler körs mot mockade grants | Grants i databasen, plus RLS |
| Dokumentåtkomst | `server/data/documents.ts` | Alla dokument visas (`TODO(backend)`) | Filtrera på användarens åtkomst |
| Konversationer | `server/data/conversations.ts`, `chat/use-chat.ts` | Mockhistorik. Nya meddelanden bara i minnet. | Spara meddelanden, skapa konversation via server action |
| AI-svar | `server/ai/providers/mock.ts` | Förskrivna svar | Riktig provider, prompt och retrieval |
| Källhänvisningar | `mocks/responses.ts` | Hårdkodade källor | Från retrieval |
| Filbilagor i chatt | `chat/composer.tsx` | Bara metadata, filen läses inte | Uppladdning, skanning, textutvinning, lagring |
| Dokumentuppladdning | `knowledge/upload-dialog.tsx` | Formulär utan sändning | Uppladdning, metadata i databasen, indexering |
| Redigera och ladda ned dokument | `knowledge/document-sheet.tsx` | Toast | Server actions och signerade nedladdningar |
| Bjud in användare | `admin/invite-user-dialog.tsx` | Toast | Invite via auth-leverantören |
| Användaråtgärder | `admin/users-view.tsx` | Toast | Server actions med auditlogg |
| Grupper | `admin/group-actions.tsx` | Toast | CRUD via server actions |
| Behörighetsmatris | `admin/permissions-view.tsx` | Lokalt tillstånd, sparas inte | Server action, auditlogg |
| Assistentkonfiguration | `admin/assistants-view.tsx` | Visning, sparas inte | Versionshanterade instruktioner, val av samlingar |
| Profil och preferenser | `settings/settings-view.tsx` | Sparas inte | Profil- och preferenstabell |
| Säkerhetsinställningar | `settings/settings-view.tsx` | Markerade "Planerad" | Byte av lösenord, TOTP-hantering och sessioner via leverantören |
