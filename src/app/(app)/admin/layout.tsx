import type { Metadata } from "next";

import { AdminSidebar } from "@/components/layout/admin-sidebar";
import { AppShell } from "@/components/layout/app-shell";
import { requireAdministrationAccess } from "@/server/auth/session";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireAdministrationAccess();

  return <AppShell sidebar={<AdminSidebar user={user} />}>{children}</AppShell>;
}
