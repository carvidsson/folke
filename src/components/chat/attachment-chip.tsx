import { FileSpreadsheet, FileText, Image as ImageIcon, X } from "lucide-react";

import type { Attachment } from "@/lib/domain/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const props = { className: "size-4", strokeWidth: 1.75 };
  if (mimeType.startsWith("image/")) return <ImageIcon {...props} />;
  if (mimeType.includes("sheet") || mimeType.includes("csv")) return <FileSpreadsheet {...props} />;
  return <FileText {...props} />;
}

export function AttachmentChip({
  attachment,
  onRemove,
  className,
}: {
  attachment: Pick<Attachment, "name" | "mimeType" | "sizeBytes">;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-11 max-w-64 items-center gap-2.5 rounded-lg border bg-background py-1.5 pr-2 pl-1.5 shadow-xs",
        className,
      )}
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileTypeIcon mimeType={attachment.mimeType} />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[0.8125rem] font-medium">{attachment.name}</span>
        <span className="block text-[0.6875rem] text-muted-foreground">
          {formatBytes(attachment.sizeBytes)}
        </span>
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Ta bort ${attachment.name}`}
          className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}
