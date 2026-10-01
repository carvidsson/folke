import type { Metadata } from "next";
import Link from "next/link";

import { FolkeLogo } from "@/components/brand/folke-logo";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { firstName } from "@/lib/format";
import { getSession } from "@/server/auth/session";
import { getMyAIPreferences } from "@/server/data/instructions";

export const metadata: Metadata = { title: "Kom igång" };

/**
 * Optional personal onboarding (version 2). Only changes the user's own AI
 * preferences – never roles, groups, assistants or documents.
 */
export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const { user } = await getSession();
  const [prefs, { restart, step }] = await Promise.all([getMyAIPreferences(user.id), searchParams]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="Till startsidan">
          <FolkeLogo />
        </Link>
      </header>
      <main className="px-4 pt-4 sm:px-6 lg:pt-8">
        <OnboardingFlow
          firstName={firstName(user.name)}
          initial={prefs}
          restart={restart === "1"}
          startAt={step === "intro" ? "intro" : undefined}
        />
      </main>
    </div>
  );
}
