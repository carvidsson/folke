"use client";

import { PanelLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useShell } from "./app-shell";

/** Toggles the desktop sidebar. Hidden on small screens (drawer instead). */
export function SidebarCollapseButton({ label = "Dölj sidopanel" }: { label?: string }) {
  const { toggleSidebar } = useShell();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleSidebar}
          aria-label={label}
          className="hidden text-muted-foreground lg:inline-flex"
        >
          <PanelLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
