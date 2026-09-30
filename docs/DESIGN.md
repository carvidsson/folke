# Design

Folke ska kännas som ett etablerat, professionellt arbetsverktyg: lugnt, tydligt och snabbt att förstå. Det kombinerar ett modernt administrativt SaaS-gränssnitt med den fokuserade, luftiga chattupplevelse som användare känner igen.

## Principer

1. **Funktion före dekoration.** Varje element ska hjälpa användaren att förstå eller göra något.
2. **Återhållsam färg.** Neutrala ytor och marinblå text. Salviagrönt är en diskret accent. Statusfärger används bara för status.
3. **Luft i översikter, täthet i administration.** Startsida och chatt har generösa marginaler. Tabellvyer får vara informationstäta.
4. **Chatten först.** I chattläget får samtalet maximal yta, och sidomenyn kan döljas.
5. **Ärlighet.** UI som inte är kopplat till en backend märks med en prototypnotis. Säkerhetsfunktioner visas aldrig som aktiva när de inte är det.
6. **Inga AI-klichéer.** Inga gradienter, glöd, gnistor, oskärpa eller animerade effekter utöver det som hjälper användaren.

## Varumärke

- Originalfilerna finns i `design/assets` och kopieras **oförändrade** till `public/brand`. Logotypen får inte ritas om eller färgas om.
- Komponenter: `FolkeLogo` (ordbild med symbol) och `FolkeSymbol` (`components/brand/folke-logo.tsx`).
- **"by Börjessons"** visas endast på inloggningssidan och startsidan, som en diskret rad under logotypen (`endorsement`-propen). Övriga vyer visar bara Folke.
- Favicon: `src/app/icon.svg` (symbolen).

## Färg

Paletten utgår från logotypens två färger.

| Token | Värde | Användning |
|---|---|---|
| `navy-900` | `#111b2b` | Ordbild. Primär text, primära knappar |
| `navy-500` | `#5f6a7c` | Sekundär text (`muted-foreground`) |
| `navy-400` | `#8a94a5` | Placeholder, överrubriker (`subtle-foreground`) |
| `navy-50…200` | `#f5f6f8` … `#dadee5` | Hover, muted-ytor, avgränsningar |
| `sage-500` | `#727d71` | Symbol. Varumärkesaccent (`brand`) |
| `sage-50…300` | `#f4f6f4` … `#b3bcb2` | Källmarkeringar, fokusring, markering |
| `background` | `#ffffff` | Huvudyta |
| `surface` | `#f7f8f9` | Sidomeny, tabellhuvud, sekundära ytor |
| `border` | `#e6e9ed` | Standardkant |

**Semantiska tokens** (`background`, `foreground`, `primary`, `muted`, `border`, `ring`, `brand` …) definieras i `src/app/globals.css`. Komponenter ska använda semantiska tokens och inte hårdkoda hex-värden.

**Status:** `success` `#2f7a4f`, `warning` `#9a5b12`, `info` `#33577f` och `destructive` `#b42318`, var och en med en ljus `*-subtle`-bakgrund. Statusfärg ska alltid kombineras med text (`StatusBadge`).

**Assistenttoner:** fyra dämpade toner som bara används i assistentikoner, för igenkänning: sage (Sälj), slate (Analys), sand (Möte) och clay (Garanti).

Endast ljust tema i etapp 1 (se DECISIONS).

## Typografi

Primärt typsnitt: **Geist Sans**, laddat med `next/font/google` i `src/app/layout.tsx` (variabel `--font-geist-sans`) och kopplat till `--font-sans` och `--font-heading` i `globals.css`. Det används för rubriker, brödtext, navigation, chatt, formulär, tabeller och övriga gränssnittselement.

**Geist Mono** (variabel `--font-geist-mono`, klassen `font-mono`) används bara där monospace är motiverat, till exempel för kod i chattsvar.

Logotypen är en bild och påverkas inte av typsnittet.

| Klass | Storlek / radhöjd | Vikt | Användning |
|---|---|---|---|
| `.text-display` | 28 / 36 | 600 | Sidhälsning, tom chatt |
| `.text-title` | 20 / 28 | 600 | Sidrubrik (`PageHeader`) |
| `.text-heading` | 16 / 24 | 600 | Sektions- och kortrubrik |
| `.text-body` / `text-sm` | 14 / 24 | 400 | Brödtext i UI |
| Chattsvar | 15 / 28 | 400 | Läsbarhet i långa svar |
| `.text-caption` | 12 / 20 | 400 | Hjälptext, metadata |
| `.text-overline` | 11 / 16, versaler, spärrad | 500 | Sektionsetiketter i meny och paneler |

Rubriker har lätt negativ spärrning. Siffror i tabeller använder `tabular-nums`.

## Spacing och layout

- **Skala:** Tailwinds 4 px-skala. Vanliga steg är 1 (4), 2 (8), 3 (12), 4 (16), 5 (20), 6 (24), 8 (32), 10 (40) och 12 (48).
- **Sidcontainer** (`PageContainer`): `max-w-6xl` som standard, `max-w-7xl` för tabeller (`wide`) och `max-w-3xl` för formulär (`narrow`). Sidmarginal 16, 24 eller 40 px beroende på brytpunkt.
- **Chatt:** innehållskolumn `max-w-3xl`, centrerad. Composern ligger i botten, eller mitt på sidan i tomt läge.
- **Sidomeny:** 264 px. Rader är 36 px höga (32 px för historik).
- **Radie:** `--radius` 8 px. Kort och paneler använder `rounded-xl` (11 px), composern `rounded-2xl`.
- **Skuggor:** marinblått tonade och mycket svaga (`shadow-xs` till `shadow-lg`). Kort använder `shadow-xs` med kant. Djup används sparsamt.

## Komponenter

Baserade på shadcn/ui (Radix, förinställningen "Nova") i `src/components/ui`, anpassade till Folkes tokens:

- **Table:** tätare rader, `surface`-färgat tabellhuvud med små gråa rubriker.
- **Dialog/Sheet:** enkel nedtoning (`navy-950/20`) utan oskärpa.
- **Sonner:** alltid ljust tema.

Folke-specifika byggstenar:

| Komponent | Plats | Syfte |
|---|---|---|
| `AppShell`, `Sidebar*`, `SidebarNavLink` | `layout/` | Skal och navigering |
| `PageHeader`, `PageContainer` | `layout/page-header.tsx` | Sidrubrik och bredd |
| `AssistantAvatar` | `common/` | Ikon plus ton per assistent |
| `UserAvatar` | `common/` | Initialer |
| `StatusBadge` | `common/` | Status med prick och text |
| `Panel`, `StatTile` | `common/panel.tsx` | Tabellram och nyckeltal |
| `FilterBar`, `SearchInput`, `FilterSelect` | `common/filters.tsx` | Filtrering i listvyer |
| `DetailList`, `DetailSection` | `common/detail-list.tsx` | Detaljpaneler |
| `EmptyState` | `common/` | Tomma tillstånd |
| `PrototypeNotice` | `common/` | Markerar okopplad funktionalitet |
| `Composer`, `AssistantPicker`, `Markdown`, `Sources` | `chat/` | Chattupplevelsen |

## Ikoner

Lucide används genomgående. Standardstorleken är 16 px i knappar och menyer, med `strokeWidth` 1.75 i ikonrutor. Ikonen för en assistent bestäms av `Assistant.icon` och mappas i `AssistantAvatar`.

## Språk och ton

- All användarsynlig text är på svenska. Kod och identifierare är på engelska.
- Använd versal bara i början av meningen ("Ladda upp dokument", inte "Ladda Upp Dokument").
- Skriv kort och sakligt och tilltala användaren med "du".
- Datum formateras med `sv-SE` och tidszonen Europe/Stockholm (`lib/format.ts`).
- Enum-etiketter samlas i `lib/domain/labels.ts`.

## Tillgänglighet

- Synlig fokusring (`ring`, salviagrön) på alla interaktiva element.
- Ikonknappar har `aria-label`, och tooltip används som komplement.
- Status förmedlas med både text och färg.
- Laddningsindikatorn har `role="status"`, och resultaträknare använder `aria-live`.
- `prefers-reduced-motion` stänger av animationer.
- Textkontrasten för `muted-foreground` mot vit bakgrund är cirka 5,5:1 (WCAG AA).
