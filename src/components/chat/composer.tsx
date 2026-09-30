"use client";

import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Attachment } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

import { AttachmentChip } from "./attachment-chip";
import type { OutgoingMessage } from "./use-chat";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.csv,.png,.jpg,.jpeg";

/**
 * Message input with attachments. Attachments are only described (name,
 * type, size) – file contents are not read or uploaded in the prototype.
 */
export function Composer({
  onSubmit,
  onStop,
  isBusy = false,
  placeholder = "Skriv ett meddelande…",
  allowAttachments = true,
  autoFocus = false,
  leading,
  className,
}: {
  onSubmit: (message: OutgoingMessage) => void;
  onStop?: () => void;
  isBusy?: boolean;
  placeholder?: string;
  allowAttachments?: boolean;
  autoFocus?: boolean;
  /** Extra controls in the bottom-left toolbar (e.g. assistant picker). */
  leading?: React.ReactNode;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const canSend = text.trim().length > 0 && !isBusy;

  function submit() {
    if (!canSend) return;
    onSubmit({ text: text.trim(), attachments });
    setText("");
    setAttachments([]);
    textarea.current?.focus();
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    const accepted: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} är större än 20 MB.`);
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      });
    }
    setAttachments((current) => {
      const next = [...current, ...accepted];
      if (next.length > MAX_FILES) toast.error(`Du kan bifoga högst ${MAX_FILES} filer.`);
      return next.slice(0, MAX_FILES);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        "rounded-2xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-navy-300 focus-within:shadow-md",
        className,
      )}
      onDragOver={(e) => allowAttachments && e.preventDefault()}
      onDrop={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => setAttachments((all) => all.filter((x) => x.id !== a.id))}
            />
          ))}
        </div>
      )}

      <label htmlFor="composer-input" className="sr-only">
        Meddelande
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[0.9375rem] leading-6 outline-none placeholder:text-subtle-foreground"
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
        {allowAttachments && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => fileInput.current?.click()}
                  aria-label="Bifoga fil"
                >
                  <Paperclip />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Bifoga fil (PDF, Word, Excel, bild)</TooltipContent>
            </Tooltip>
          </>
        )}
        {leading}
        <div className="ml-auto">
          {isBusy && onStop ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              aria-label="Stoppa svaret"
              className="rounded-full"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!canSend}
              aria-label="Skicka"
              className="rounded-full disabled:bg-navy-200 disabled:opacity-100"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
