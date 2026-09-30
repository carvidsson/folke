import {
  CarFront,
  ChartLine,
  NotebookPen,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import type { Assistant, AssistantIconKey, AssistantTone } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export const ASSISTANT_ICONS: Record<AssistantIconKey, LucideIcon> = {
  sales: CarFront,
  analysis: ChartLine,
  meetings: NotebookPen,
  warranty: ShieldCheck,
};

const TONE_CLASSES: Record<AssistantTone, string> = {
  sage: "bg-tone-sage-subtle text-tone-sage",
  slate: "bg-tone-slate-subtle text-tone-slate",
  sand: "bg-tone-sand-subtle text-tone-sand",
  clay: "bg-tone-clay-subtle text-tone-clay",
};

const SIZES = {
  xs: "size-5 rounded-[5px] [&_svg]:size-3",
  sm: "size-7 rounded-md [&_svg]:size-4",
  md: "size-9 rounded-lg [&_svg]:size-[18px]",
  lg: "size-11 rounded-xl [&_svg]:size-5",
} as const;

export function AssistantAvatar({
  assistant,
  size = "md",
  className,
}: {
  assistant: Pick<Assistant, "icon" | "tone">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = ASSISTANT_ICONS[assistant.icon];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        TONE_CLASSES[assistant.tone],
        SIZES[size],
        className,
      )}
    >
      <Icon strokeWidth={1.75} />
    </span>
  );
}
