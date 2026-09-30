"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { FolkeLogo } from "@/components/brand/folke-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface ShellContextValue {
  /** Desktop: whether the sidebar is shown. */
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  openMobileNav: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell() {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <AppShell>");
  return ctx;
}

/**
 * Application frame: left sidebar + main area.
 *
 * The sidebar content is supplied by each section layout (workspace, chat,
 * admin) so navigation adapts to the kind of view the user is in.
 * On small screens the sidebar becomes a slide-over sheet.
 */
export function AppShell({
  sidebar,
  children,
  mobileTopBar = true,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  /** Set false when the page renders its own top bar (e.g. chat). */
  mobileTopBar?: boolean;
}) {
  const pathname = usePathname();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarVisible((v) => !v), []);
  const openMobileNav = useCallback(() => setMobileOpen(true), []);
  const value = useMemo(
    () => ({ sidebarVisible, toggleSidebar, openMobileNav }),
    [sidebarVisible, toggleSidebar, openMobileNav],
  );

  return (
    <ShellContext.Provider value={value}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <aside
          className={cn(
            "hidden w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex",
            !sidebarVisible && "lg:hidden",
          )}
        >
          {sidebar}
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-[284px] gap-0 bg-sidebar p-0 sm:max-w-[284px]"
            // Close the drawer as soon as the user follows a link.
            onClickCapture={(e) => {
              if ((e.target as HTMLElement).closest("a")) setMobileOpen(false);
            }}
          >
            <SheetTitle className="sr-only">Navigering</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {mobileTopBar && (
            <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3 lg:hidden">
              <Button
                variant="ghost"
                size="icon"
                onClick={openMobileNav}
                aria-label="Öppna meny"
              >
                <Menu />
              </Button>
              <Link href="/" aria-label="Folke – startsida">
                <FolkeLogo height={20} endorsement={pathname === "/"} />
              </Link>
            </div>
          )}
          <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
