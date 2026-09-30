import Link from "next/link";

import { FolkeLogo } from "@/components/brand/folke-logo";
import { cn } from "@/lib/utils";

/**
 * Sidebar building blocks shared by the workspace, chat and admin sidebars.
 * Layout-only; active-state logic lives in <SidebarNavLink> (client).
 */

export function SidebarHeader({
  endorsement = false,
  action,
}: {
  endorsement?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5">
      <Link
        href="/"
        aria-label="Folke – startsida"
        className="-mx-1 rounded-md px-1 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <FolkeLogo height={22} endorsement={endorsement} priority />
      </Link>
      {action}
    </div>
  );
}

export function SidebarBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "scrollbar-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pt-2 pb-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidebarSection({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      {title && (
        <div className="flex h-7 items-center justify-between px-2.5">
          <h2 className="text-overline">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function SidebarFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 border-t border-sidebar-border p-3">{children}</div>
  );
}
