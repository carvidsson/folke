import { History, House, Library, SquarePen } from "lucide-react";
import Link from "next/link";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Button } from "@/components/ui/button";
import type { Assistant, ConversationSummary, User } from "@/lib/domain/types";
import { DATE_BUCKET_LABELS, dateBucket, type DateBucket } from "@/lib/format";

import { SidebarBody, SidebarHeader, SidebarSection } from "./sidebar";
import { SidebarCollapseButton } from "./sidebar-collapse-button";
import { SidebarFooterUser } from "./sidebar-footer-user";
import { SidebarNavLink } from "./sidebar-nav-link";

const BUCKET_ORDER: DateBucket[] = ["today", "yesterday", "week", "month", "older"];

/** History-focused sidebar used in the chat views. */
export function ChatSidebar({
  user,
  assistants,
  conversations,
  now,
}: {
  user: User;
  assistants: Assistant[];
  conversations: ConversationSummary[];
  now: Date;
}) {
  const byId = new Map(assistants.map((a) => [a.id, a]));
  const grouped = new Map<DateBucket, ConversationSummary[]>();
  for (const c of conversations) {
    const bucket = dateBucket(c.updatedAt, now);
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), c]);
  }

  return (
    <>
      <SidebarHeader action={<SidebarCollapseButton />} />
      <div className="px-3 pb-2">
        <Button asChild variant="outline" className="h-9 w-full justify-start gap-2.5 bg-background px-2.5 shadow-xs">
          <Link href="/chat">
            <SquarePen />
            Ny chatt
          </Link>
        </Button>
      </div>
      <SidebarBody>
        <SidebarSection>
          <SidebarNavLink href="/" match="exact">
            <House />
            Översikt
          </SidebarNavLink>
          <SidebarNavLink href="/knowledge">
            <Library />
            Kunskapsbank
          </SidebarNavLink>
          <SidebarNavLink href="/chat/history">
            <History />
            Alla konversationer
          </SidebarNavLink>
        </SidebarSection>

        {BUCKET_ORDER.filter((b) => grouped.has(b)).map((bucket) => (
          <SidebarSection key={bucket} title={DATE_BUCKET_LABELS[bucket]}>
            {grouped.get(bucket)!.map((c) => {
              const assistant = byId.get(c.assistantId);
              return (
                <SidebarNavLink
                  key={c.id}
                  href={`/chat/${c.id}`}
                  className="h-8"
                  title={c.title}
                >
                  {assistant && <AssistantAvatar assistant={assistant} size="xs" />}
                  <span className="truncate text-[0.8125rem]">{c.title}</span>
                </SidebarNavLink>
              );
            })}
          </SidebarSection>
        ))}
      </SidebarBody>
      <SidebarFooterUser user={user} />
    </>
  );
}
