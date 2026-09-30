"use client";

import { usePathname } from "next/navigation";

import { SidebarHeader } from "./sidebar";

/** Shows the "by Börjessons" endorsement only on the start page. */
export function SidebarHeaderForPath({ action }: { action?: React.ReactNode }) {
  const pathname = usePathname();
  return <SidebarHeader endorsement={pathname === "/"} action={action} />;
}
