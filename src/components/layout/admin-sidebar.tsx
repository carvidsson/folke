import {
  ArrowLeft,
  Archive,
  Bot,
  Gauge,
  KeyRound,
  ScrollText,
  Users,
  UsersRound,
} from "lucide-react";
import Link from "next/link";

import type { User } from "@/lib/domain/types";

import { SidebarBody, SidebarHeader, SidebarSection } from "./sidebar";
import { SidebarFooterUser } from "./sidebar-footer-user";
import { SidebarNavLink, sidebarItemClass } from "./sidebar-nav-link";

/** Sidebar for the administration area. Items follow the user's role. */
export function AdminSidebar({ user }: { user: User }) {
  const isAdmin = user.role === "system_admin";
  return (
    <>
      <SidebarHeader />
      <SidebarBody>
        <Link href="/" className={sidebarItemClass}>
          <ArrowLeft />
          Tillbaka till Folke
        </Link>
        <SidebarSection title="Administration">
          {isAdmin && (
            <>
              <SidebarNavLink href="/admin/users">
                <Users />
                Användare
              </SidebarNavLink>
              <SidebarNavLink href="/admin/groups">
                <UsersRound />
                Grupper
              </SidebarNavLink>
            </>
          )}
          <SidebarNavLink href="/admin/assistants">
            <Bot />
            Assistenter
          </SidebarNavLink>
          {isAdmin && (
            <SidebarNavLink href="/admin/permissions">
              <KeyRound />
              Behörigheter
            </SidebarNavLink>
          )}
        </SidebarSection>
        {isAdmin && (
          <SidebarSection title="Drift och säkerhet">
            <SidebarNavLink href="/admin/usage">
              <Gauge />
              Användning och kostnad
            </SidebarNavLink>
            <SidebarNavLink href="/admin/security">
              <ScrollText />
              Säkerhetslogg
            </SidebarNavLink>
            <SidebarNavLink href="/admin/retention">
              <Archive />
              Gallring
            </SidebarNavLink>
          </SidebarSection>
        )}
      </SidebarBody>
      <SidebarFooterUser user={user} />
    </>
  );
}
