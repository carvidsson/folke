"use client";

import { Check, ChevronDown } from "lucide-react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Assistant } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export function AssistantPicker({
  assistants,
  value,
  onChange,
  disabled = false,
  size = "default",
  className,
}: {
  assistants: Assistant[];
  value: string;
  onChange: (assistantId: string) => void;
  disabled?: boolean;
  size?: "default" | "sm";
  className?: string;
}) {
  const current = assistants.find((a) => a.id === value) ?? assistants[0];
  if (!current) return null;

  const trigger = (
    <>
      <AssistantAvatar assistant={current} size={size === "sm" ? "xs" : "sm"} />
      <span className="truncate">{current.name}</span>
    </>
  );

  if (disabled) {
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-2 px-1.5 font-medium",
          size === "sm" ? "h-8 text-[0.8125rem]" : "h-9 text-sm",
          className,
        )}
      >
        {trigger}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex min-w-0 items-center gap-2 rounded-lg px-1.5 font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted",
          size === "sm" ? "h-8 text-[0.8125rem]" : "h-9 text-sm",
          className,
        )}
        aria-label={`Välj assistent, vald: ${current.name}`}
      >
        {trigger}
        <ChevronDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-overline">Välj assistent</DropdownMenuLabel>
        {assistants.map((a) => (
          <DropdownMenuItem
            key={a.id}
            onSelect={() => onChange(a.id)}
            className="items-start gap-3 py-2"
          >
            <AssistantAvatar assistant={a} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{a.tagline}</span>
            </span>
            {a.id === current.id && <Check className="mt-1.5 size-4 text-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
