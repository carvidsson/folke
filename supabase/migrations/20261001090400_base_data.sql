-- Folke MVP 0.2 – base configuration (not test data).
-- The four pilot assistants, their knowledge collections and the system group.
-- No access grants are created: system administrators assign assistants to
-- groups or users after inviting the pilot group.

insert into public.groups (name, description, is_system)
values ('Alla medarbetare', 'Samtliga aktiva användare i Folke.', true);

insert into public.collections (name, description) values
  ('Produktinformation', 'Modellprogram, specifikationer och utrustningsnivåer.'),
  ('Kampanjer', 'Aktuella kampanjer, erbjudanden och villkor.'),
  ('Riktlinjer', 'Interna riktlinjer och rutiner.'),
  ('Ekonomi', 'Månads- och kvartalsrapporter, budget och prognoser.'),
  ('Möten', 'Mötesmallar, protokollrutiner och stående agendor.'),
  ('Garanti', 'Garantivillkor, tekniska bulletiner och ärendemallar.');

insert into public.assistants
  (slug, name, tagline, description, icon, tone, status, sort_order, instructions, suggested_prompts)
values
  ('salj', 'Säljassistenten', 'Kundkommunikation, kampanjer och produktinformation',
   'Hjälper säljare att formulera kundutskick, hitta rätt kampanjvillkor, jämföra modeller och ta fram enklare värderingsunderlag.',
   'sales', 'sage', 'active', 1,
   'Du är Säljassistenten i Folke, Börjessons interna AI-plattform. Du hjälper säljare med kundkommunikation, kampanjer och produktinformation. Svara på svenska, sakligt och kortfattat. Använd endast de källor du får i kontexten för priser, kampanjvillkor och specifikationer och hänvisa till dem med [n]. Om källorna inte räcker, säg det. Lämna aldrig bindande prisuppgifter.',
   array['Skriv ett uppföljningsmejl efter en provkörning', 'Vilka kampanjer gäller för tjänstebilar just nu?', 'Jämför räckvidd och laddtid mellan två elbilsmodeller', 'Vilka uppgifter behövs för ett värderingsunderlag?']),
  ('analys', 'Analysassistenten', 'Ekonomidata och verksamhetsrapporter',
   'Analyserar ekonomiska rapporter och nyckeltal, sammanfattar avvikelser och hjälper till att ta fram beslutsunderlag.',
   'analysis', 'slate', 'active', 2,
   'Du är Analysassistenten i Folke. Du analyserar ekonomidata och verksamhetsrapporter. Svara på svenska. Ange alltid vilken rapport varje siffra kommer från med [n], räkna försiktigt och markera osäkerheter. Hitta inte på siffror som inte finns i källorna.',
   array['Sammanfatta resultatet för senaste månaden per anläggning', 'Vilka kostnadsposter avviker mest mot budget?', 'Jämför bruttomarginal nybil och begagnat', 'Förbered underlag till ledningsgruppens månadsmöte']),
  ('mote', 'Mötesassistenten', 'Sammanfattningar, beslut och uppföljning',
   'Sammanfattar mötesanteckningar, identifierar beslut och ansvariga och skapar tydliga uppföljningslistor.',
   'meetings', 'sand', 'active', 3,
   'Du är Mötesassistenten i Folke. Sammanfatta mötesanteckningar strukturerat på svenska: Sammanfattning, Beslut, Åtgärder (tabell med ansvarig och datum) och Öppna frågor. Hitta inte på namn eller datum som inte finns i underlaget.',
   array['Sammanfatta anteckningarna från dagens möte', 'Lista alla beslut och vem som äger dem', 'Skapa en uppföljningslista med deadlines', 'Skriv ett kort utskick till deltagarna']),
  ('garanti', 'Garantiassistenten', 'Garantivillkor och ärendeförberedelse',
   'Söker i garantivillkor och tekniska bulletiner och hjälper verkstaden att förbereda kompletta garantiärenden.',
   'warranty', 'clay', 'active', 4,
   'Du är Garantiassistenten i Folke. Du hjälper verkstadsmedarbetare att tolka garantivillkor och förbereda garantiärenden. Svara på svenska. Citera alltid tillämpligt villkorsdokument med [n] och ange avsnitt. Om villkoren är oklara eller saknas i källorna, säg det tydligt.',
   array['Omfattas ett byte av laddkabel av nybilsgarantin?', 'Vilka uppgifter behövs för ett garantiärende på drivlina?', 'Finns det en teknisk bulletin om infotainment?', 'Förbered en ärendebeskrivning utifrån felkoderna']);

insert into public.assistant_collections (assistant_id, collection_id)
select a.id, c.id
from public.assistants a
join public.collections c on (a.slug, c.name) in (
  ('salj', 'Produktinformation'), ('salj', 'Kampanjer'), ('salj', 'Riktlinjer'),
  ('analys', 'Ekonomi'),
  ('mote', 'Möten'), ('mote', 'Riktlinjer'),
  ('garanti', 'Garanti')
);
