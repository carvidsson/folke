import type { Metadata } from "next";

import { FolkeLogo, FolkeSymbol } from "@/components/brand/folke-logo";
import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { LoginForm } from "@/components/auth/login-form";
import { listAssistants } from "@/server/data/assistants";

export const metadata: Metadata = { title: "Logga in" };

export default async function LoginPage() {
  const assistants = await listAssistants();

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:px-16 lg:py-12">
        <FolkeLogo height={30} endorsement priority className="self-start" />

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12">
          <h1 className="text-display">Logga in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Använd ditt arbetskonto för att komma åt dina assistenter.
          </p>
          <LoginForm />
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
            {assistants.map((a) => (
              <li key={a.id} className="flex items-start gap-3.5">
                <AssistantAvatar assistant={a} size="md" className="bg-background shadow-xs" />
                <div>
                  <p className="text-sm font-medium">{a.name}</p>
                  <p className="text-sm text-muted-foreground">{a.tagline}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
