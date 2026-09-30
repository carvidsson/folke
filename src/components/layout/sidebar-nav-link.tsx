"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export const sidebarItemClass =
  "group/nav flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground aria-[current=page]:[&>svg]:text-foreground";

/**
 * Navigation link with active state.
 * `match="exact"` for leaf pages, "prefix" for section roots.
 */
export function SidebarNavLink({
  href,
  match = "prefix",
  className,
  children,
  title,
}: {
  href: string;
  match?: "exact" | "prefix" | "none";
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const pathname = usePathname();
  const active =
    match === "exact"
      ? pathname === href
      : match === "prefix"
        ? pathname === href || pathname.startsWith(`${href}/`)
        : false;

  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(sidebarItemClass, className)}
    >
      {children}
    </Link>
  );
}
