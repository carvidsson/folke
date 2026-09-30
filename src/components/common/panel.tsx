import { cn } from "@/lib/utils";

/** Bordered surface for tables and grouped content. */
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      {children}
    </div>
  );
}

/** Compact KPI tile used above list views. */
export function StatTile({
  label,
  value,
  hint,
  active = false,
  onClick,
}: {
  label: string;
  value: number | string;
  hint?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="text-caption block">{label}</span>
      <span className="mt-1 flex items-baseline gap-2">
        <span className="text-[1.375rem] leading-7 font-semibold tracking-tight tabular-nums">{value}</span>
        {hint}
      </span>
    </>
  );
  const className = cn(
    "rounded-xl border bg-card px-4 py-3 text-left shadow-xs transition-colors",
    onClick && "hover:border-navy-200 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
    active && "border-navy-300 bg-surface",
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className={className}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
