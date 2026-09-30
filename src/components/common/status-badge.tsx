import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

const TONES: Record<StatusTone, { badge: string; dot: string }> = {
  success: { badge: "bg-success-subtle text-success", dot: "bg-success" },
  warning: { badge: "bg-warning-subtle text-warning", dot: "bg-warning" },
  danger: { badge: "bg-destructive/8 text-destructive", dot: "bg-destructive" },
  info: { badge: "bg-info-subtle text-info", dot: "bg-info" },
  neutral: { badge: "bg-muted text-muted-foreground", dot: "bg-navy-300" },
  brand: { badge: "bg-brand-subtle text-brand-foreground", dot: "bg-brand" },
};

/** Compact pill with a status dot. Colour is never the only signal: always pass a label. */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        TONES[tone].badge,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONES[tone].dot)} />
      {children}
    </span>
  );
}
