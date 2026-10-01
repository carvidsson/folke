import { FileSpreadsheet, FileText, Presentation } from "lucide-react";

import type { DocumentFileType } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

const ICONS = {
  pdf: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  csv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
} satisfies Record<DocumentFileType, unknown>;

export function DocumentIcon({
  type,
  className,
}: {
  type: DocumentFileType;
  className?: string;
}) {
  const Icon = ICONS[type];
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
}
