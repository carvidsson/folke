import { ArrowRight, ArrowUpRight, FileText, MessageSquare } from "lucide-react";
import Link from "next/link";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { EmptyState } from "@/components/common/empty-state";
import { QuickStart } from "@/components/home/quick-start";
import { ValidityBadge } from "@/components/knowledge/document-badges";
import { PageContainer } from "@/components/layout/page-header";
import { firstName, formatRelative, formatShortDate } from "@/lib/format";
import { getSession } from "@/server/auth/session";
import { listMyAssistants } from "@/server/data/assistants";
import { listConversations } from "@/server/data/conversations";
import { listDocuments } from "@/server/data/documents";

export default async function HomePage() {
  const { user } = await getSession();
  const [assistants, recent, documents] = await Promise.all([
    listMyAssistants(),
    listConversations(user.id, { limit: 5 }),
    listDocuments(),
  ]);
  const now = new Date();
  const assistantById = new Map(assistants.map((a) => [a.id, a]));
  const allowedIds = new Set(assistants.map((a) => a.id));
  const knowledgeUpdates = documents
    .filter(
      (d) =>
        d.reviewStatus === "approved" &&
        d.processing === "ready" &&
        d.assistantIds.some((id) => allowedIds.has(id)),
    )
    .slice(0, 4);

  return (
    <PageContainer>
      <section className="mx-auto max-w-3xl pt-2 pb-4 lg:pt-8">
        <h1 className="text-display text-center">Hej {firstName(user.name)}</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Välj en assistent och beskriv vad du behöver hjälp med.
        </p>
        <QuickStart assistants={assistants} />
      </section>

      <section className="mt-12">
        <SectionHeading title="Dina assistenter" />
        {assistants.length === 0 && (
          <p className="rounded-xl border bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
            Du har inte tilldelats några assistenter ännu. Kontakta en systemadministratör.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {assistants.map((a) => (
            <Link
              key={a.id}
              href={`/chat?assistant=${a.slug}`}
              className="group flex flex-col rounded-xl border bg-card p-5 shadow-xs transition-[border-color,box-shadow] hover:border-navy-200 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <div className="flex items-start justify-between">
                <AssistantAvatar assistant={a} size="md" />
                <ArrowUpRight className="size-4 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <p className="text-heading mt-4">{a.name}</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">{a.tagline}</p>
            </Link>
          ))}
        </div>
      </section>

      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section>
          <SectionHeading title="Fortsätt där du slutade" />
          {recent.length === 0 ? (
            <div className="rounded-xl border">
              <EmptyState
                icon={MessageSquare}
                title="Inga konversationer ännu"
                description="Dina konversationer visas här."
              />
            </div>
          ) : (
            <ul className="divide-y rounded-xl border bg-card shadow-xs">
              {recent.map((c) => {
                const assistant = assistantById.get(c.assistantId);
                return (
                  <li key={c.id}>
                    <Link
                      href={`/chat/${c.id}`}
                      className="group flex items-center gap-4 px-4 py-3.5 transition-colors first:rounded-t-xl hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
                    >
                      {assistant && <AssistantAvatar assistant={assistant} size="sm" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{c.title}</p>
                        {assistant && (
                          <p className="truncate text-[0.8125rem] text-muted-foreground">{assistant.name}</p>
                        )}
                      </div>
                      <span className="hidden shrink-0 text-xs text-subtle-foreground sm:block">
                        {formatRelative(c.updatedAt, now)}
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <SectionHeading
            title="Nytt i kunskapsbanken"
            action={
              <Link href="/knowledge" className="text-xs font-medium text-muted-foreground hover:text-foreground">
                Visa alla
              </Link>
            }
          />
          <ul className="flex flex-col gap-1">
            {knowledgeUpdates.length === 0 && (
              <li className="px-2.5 py-2 text-sm text-muted-foreground">Inga godkända dokument ännu.</li>
            )}
            {knowledgeUpdates.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/knowledge?document=${d.id}`}
                  className="flex items-start gap-3 rounded-lg p-2.5 transition-colors hover:bg-surface"
                >
                  <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                    <FileText className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{d.title}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {formatShortDate(d.uploadedAt)}
                      {d.validity !== "valid" && (
                        <ValidityBadge validity={d.validity} className="h-5 px-1.5 text-[0.6875rem]" />
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageContainer>
  );
}

function SectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-heading">{title}</h2>
      {action}
    </div>
  );
}
