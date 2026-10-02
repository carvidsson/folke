"use client";

import { ArrowUp, CircleAlert, Paperclip, Square, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ATTACHMENT_ACCEPT, ATTACHMENT_NOTICE } from "@/lib/attachments";
import { cn } from "@/lib/utils";

import { AttachmentChip } from "./attachment-chip";
import { useAttachmentUploads } from "./use-attachment-uploads";
import type { OutgoingMessage } from "./use-chat";

/**
 * Message input. With `attachments` set, files can be attached with the
 * paperclip, by drag-and-drop or by pasting (e.g. a screenshot). Each file is
 * uploaded and read right away (ADR-045); the message can be sent when all
 * files are ready.
 */
export function Composer({
  onSubmit,
  onStop,
  isBusy = false,
  placeholder = "Skriv ett meddelande…",
  attachments: attachmentOptions,
  autoFocus = false,
  leading,
  className,
}: {
  onSubmit: (message: OutgoingMessage) => void;
  onStop?: () => void;
  isBusy?: boolean;
  placeholder?: string;
  /** Enables attachments; the conversation (if it exists) is used for its limits. */
  attachments?: { conversationId: string | null };
  autoFocus?: boolean;
  /** Extra controls in the bottom-left toolbar (e.g. assistant picker). */
  leading?: React.ReactNode;
  className?: string;
}) {
  const allowAttachments = Boolean(attachmentOptions);
  const [text, setText] = useState("");
  const uploads = useAttachmentUploads(attachmentOptions?.conversationId ?? null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const blockedByFiles = uploads.busy || uploads.hasFailed;
  const canSend = text.trim().length > 0 && !isBusy && !blockedByFiles;
  const sendHint = uploads.busy
    ? "Vänta tills filerna har lästs in"
    : uploads.hasFailed
      ? "Ta bort filer som inte kunde läsas in"
      : null;

  function submit() {
    if (!canSend) return;
    onSubmit({ text: text.trim(), attachments: uploads.ready });
    setText("");
    uploads.clear();
    textarea.current?.focus();
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
        uploads.add(e.dataTransfer.files);
      }}
    >
      {uploads.rejected.length > 0 && (
        <div role="alert" className="mx-3 mt-3 flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-[0.8125rem] text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            {uploads.rejected.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
          <button type="button" onClick={uploads.dismissRejected} aria-label="Stäng felmeddelandet" className="rounded p-0.5 hover:bg-destructive/10">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {uploads.items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {uploads.items.map((a) => (
            <AttachmentChip
              key={a.localId}
              attachment={a}
              status={a.status}
              error={a.error}
              thumbnailUrl={a.previewUrl}
              onRemove={() => uploads.remove(a.localId)}
            />
          ))}
          <p className="text-caption w-full">{ATTACHMENT_NOTICE}</p>
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
        onPaste={(e) => {
          // Pasted files, e.g. a screenshot from the clipboard.
          if (!allowAttachments || e.clipboardData.files.length === 0) return;
          e.preventDefault();
          uploads.add(e.clipboardData.files);
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
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                uploads.add(e.target.files);
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
              <TooltipContent className="max-w-72">
                Bifoga fil eller bild (PDF, Word, Excel, PowerPoint, text, PNG, JPEG). {ATTACHMENT_NOTICE}
              </TooltipContent>
            </Tooltip>
          </>
        )}
        {leading}
        <div className="ml-auto flex items-center gap-2">
          {sendHint && text.trim() && <span className="text-caption hidden sm:inline">{sendHint}</span>}
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
