import { CarFront, ChartLine, NotebookPen, ShieldCheck } from "lucide-react";

import { FolkeLogo, FolkeSymbol } from "@/components/brand/folke-logo";

/** Static product overview for the sign-in pages (no data before sign-in). */
const ASSISTANTS = [
  { name: "Säljassistenten", tagline: "Kundkommunikation, kampanjer och produktinformation", icon: CarFront, tone: "bg-tone-sage-subtle text-tone-sage" },
  { name: "Analysassistenten", tagline: "Ekonomidata och verksamhetsrapporter", icon: ChartLine, tone: "bg-tone-slate-subtle text-tone-slate" },
  { name: "Mötesassistenten", tagline: "Sammanfattningar, beslut och uppföljning", icon: NotebookPen, tone: "bg-tone-sand-subtle text-tone-sand" },
  { name: "Garantiassistenten", tagline: "Garantivillkor och ärendeförberedelse", icon: ShieldCheck, tone: "bg-tone-clay-subtle text-tone-clay" },
];

/** Layout for all sign-in steps: form column + product panel. */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:px-16 lg:py-12">
        <FolkeLogo height={30} endorsement priority className="self-start" />

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12">
          <h1 className="text-display">{title}</h1>
          {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>

        <p className="text-caption">Intern plattform för Börjessons medarbetare.</p>
      </div>

      <aside className="relative hidden overflow-hidden border-l bg-surface lg:flex lg:flex-col lg:justify-center lg:px-16 xl:px-24">
        <FolkeSymbol
          size={520}
          className="pointer-events-none absolute -right-28 -bottom-24 opacity-[0.06]"
        />
        <div className="relative max-w-md">
          <p className="text-overline">Folke</p>
          <h2 className="mt-3 text-[1.625rem] leading-9 font-semibold tracking-[-0.02em] text-balance">
            Rätt assistent för varje uppgift – samlad på ett ställe.
          </h2>
          <ul className="mt-10 flex flex-col gap-5">
            {ASSISTANTS.map(({ name, tagline, icon: Icon, tone }) => (
              <li key={name} className="flex items-start gap-3.5">
                <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-background shadow-xs ${tone}`}>
                  <Icon className="size-[18px]" strokeWidth={1.75} />
                </span>
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-sm text-muted-foreground">{tagline}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
