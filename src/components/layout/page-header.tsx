import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: string;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && <p className="text-overline mb-1.5">{eyebrow}</p>}
        <h1 className="text-title">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Standard content container for workspace and admin pages. */
export function PageContainer({
  children,
  width = "default",
  className,
}: {
  children: React.ReactNode;
  width?: "default" | "wide" | "narrow";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 lg:px-10 lg:py-10",
        width === "default" && "max-w-6xl",
        width === "wide" && "max-w-7xl",
        width === "narrow" && "max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
