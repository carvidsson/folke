import { FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Marks UI that looks functional but is not connected to a backend.
 * Use wherever a user could otherwise believe a change was saved or secured.
 */
export function PrototypeNotice({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-dashed border-navy-200 bg-surface px-3.5 py-2.5 text-[0.8125rem] leading-5 text-muted-foreground",
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-subtle-foreground" strokeWidth={1.75} />
      <div>{children}</div>
    </div>
  );
}
