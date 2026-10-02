import { CircleAlert, FileSpreadsheet, FileText, Image as ImageIcon, Loader2, X } from "lucide-react";

import type { AttachmentStatus } from "@/lib/attachments";
import type { Attachment } from "@/lib/domain/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const props = { className: "size-4", strokeWidth: 1.75 };
  if (mimeType.startsWith("image/")) return <ImageIcon {...props} />;
  if (mimeType.includes("sheet") || mimeType.includes("csv")) return <FileSpreadsheet {...props} />;
  return <FileText {...props} />;
}

const STATUS_TEXT: Partial<Record<AttachmentStatus | "removed", string>> = {
  uploading: "Laddar upp…",
  processing: "Läser in…",
  removed: "Borttagen",
};

export function AttachmentChip({
  attachment,
  status,
  error,
  thumbnailUrl,
  onRemove,
  onOpen,
  className,
}: {
  attachment: Pick<Attachment, "name" | "mimeType" | "sizeBytes">;
  /** Upload state in the composer, or "removed" for a deleted attachment in a sent message. */
  status?: AttachmentStatus | "removed";
  error?: string;
  /** Image preview (local object URL or a short-lived signed URL). */
  thumbnailUrl?: string;
  onRemove?: () => void;
  onOpen?: () => void;
  className?: string;
}) {
  const failed = status === "failed";
  const working = status === "uploading" || status === "processing";
  const detail = failed ? (error ?? "Filen kunde inte läsas in.") : (STATUS_TEXT[status ?? "ready"] ?? formatBytes(attachment.sizeBytes));
  const Body = onOpen && status !== "removed" ? "button" : "span";

  return (
    <span
      className={cn(
        "inline-flex h-11 max-w-72 items-center gap-2.5 rounded-lg border bg-background py-1.5 pr-2 pl-1.5 shadow-xs",
        failed && "border-destructive/40 bg-destructive/5",
        status === "removed" && "opacity-60",
        className,
      )}
      title={failed ? detail : undefined}
    >
      <Body
        {...(Body === "button" ? { type: "button" as const, onClick: onOpen, "aria-label": `Öppna ${attachment.name}` } : {})}
        className="flex min-w-0 items-center gap-2.5 text-left"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {working ? (
            <Loader2 className="size-4 animate-spin" />
          ) : failed ? (
            <CircleAlert className="size-4 text-destructive" />
          ) : thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL or short-lived signed URL
            <img src={thumbnailUrl} alt="" className="size-8 object-cover" />
          ) : (
            <FileTypeIcon mimeType={attachment.mimeType} />
          )}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[0.8125rem] font-medium">{attachment.name}</span>
          <span className={cn("block truncate text-[0.6875rem]", failed ? "text-destructive" : "text-muted-foreground")}>
            {detail}
          </span>
        </span>
      </Body>
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
