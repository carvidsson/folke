import { ArrowLeft, Bot, KeyRound, Users, UsersRound } from "lucide-react";
import Link from "next/link";

import type { User } from "@/lib/domain/types";

import { SidebarBody, SidebarHeader, SidebarSection } from "./sidebar";
import { SidebarFooterUser } from "./sidebar-footer-user";
import { SidebarNavLink, sidebarItemClass } from "./sidebar-nav-link";

/** Sidebar for the administration area. */
export function AdminSidebar({ user }: { user: User }) {
  return (
    <>
      <SidebarHeader />
      <SidebarBody>
        <Link href="/" className={sidebarItemClass}>
          <ArrowLeft />
          Tillbaka till Folke
        </Link>
        <SidebarSection title="Administration">
          <SidebarNavLink href="/admin/users">
            <Users />
            Användare
          </SidebarNavLink>
          <SidebarNavLink href="/admin/groups">
            <UsersRound />
            Grupper
          </SidebarNavLink>
          <SidebarNavLink href="/admin/assistants">
            <Bot />
            Assistenter
          </SidebarNavLink>
          <SidebarNavLink href="/admin/permissions">
            <KeyRound />
            Behörigheter
          </SidebarNavLink>
        </SidebarSection>
      </SidebarBody>
      <SidebarFooterUser user={user} />
    </>
  );
}
