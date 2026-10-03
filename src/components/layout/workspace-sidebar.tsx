import { ChartColumn, House, Library, Settings, ShieldCheck, SquarePen } from "lucide-react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { canSeeAdministration } from "@/lib/domain/roles";
import type { Assistant, ConversationSummary, User } from "@/lib/domain/types";

import { SidebarBody, SidebarSection } from "./sidebar";
import { SidebarFooterUser } from "./sidebar-footer-user";
import { SidebarHeaderForPath } from "./sidebar-header-for-path";
import { SidebarNavLink } from "./sidebar-nav-link";

/** Sidebar for general workspace views: start page, knowledge base, settings. */
export function WorkspaceSidebar({
  user,
  assistants,
  recent,
  leadAnalysis = false,
}: {
  user: User;
  assistants: Assistant[];
  recent: ConversationSummary[];
  /** The user has access to the lead analysis (checked on the server; ADR-048). */
  leadAnalysis?: boolean;
}) {
  return (
    <>
      <SidebarHeaderForPath />
      <SidebarBody>
        <SidebarSection>
          <SidebarNavLink href="/" match="exact">
            <House />
            Översikt
          </SidebarNavLink>
          <SidebarNavLink href="/chat" match="none">
            <SquarePen />
            Ny chatt
          </SidebarNavLink>
          <SidebarNavLink href="/knowledge">
            <Library />
            Kunskapsbank
          </SidebarNavLink>
          {leadAnalysis && (
            <SidebarNavLink href="/leads">
              <ChartColumn />
              Leadanalys
            </SidebarNavLink>
          )}
          {canSeeAdministration(user.role) && (
            <SidebarNavLink href="/admin">
              <ShieldCheck />
              Administration
            </SidebarNavLink>
          )}
          <SidebarNavLink href="/settings">
            <Settings />
            Inställningar
          </SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="Assistenter">
          {assistants.map((a) => (
            <SidebarNavLink key={a.id} href={`/chat?assistant=${a.slug}`} match="none">
              <AssistantAvatar assistant={a} size="xs" />
              <span className="truncate">{a.name}</span>
            </SidebarNavLink>
          ))}
        </SidebarSection>

        {recent.length > 0 && (
          <SidebarSection title="Senaste">
            {recent.map((c) => (
              <SidebarNavLink key={c.id} href={`/chat/${c.id}`} className="h-8">
                <span className="truncate text-[0.8125rem]">{c.title}</span>
              </SidebarNavLink>
            ))}
          </SidebarSection>
        )}
      </SidebarBody>
      <SidebarFooterUser user={user} />
    </>
  );
}
