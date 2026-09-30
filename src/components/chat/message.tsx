"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Assistant, Message } from "@/lib/domain/types";

import { AttachmentChip } from "./attachment-chip";
import { Markdown } from "./markdown";
import { Sources } from "./sources";

export function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-col items-end gap-2">
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {message.attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[0.9375rem] leading-6 whitespace-pre-wrap sm:max-w-[75%]">
        {message.content}
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  assistant,
  pending = false,
  streaming = false,
}: {
  message: Message;
  assistant: Assistant;
  /** Waiting for the first token. */
  pending?: boolean;
  /** Tokens are still arriving. */
  streaming?: boolean;
}) {
  return (
    <div className="flex gap-4">
      <AssistantAvatar assistant={assistant} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="sr-only">{assistant.name} svarar:</p>
        {pending ? (
          <TypingIndicator label="Söker i kunskapsbanken…" />
        ) : (
          <>
            <Markdown idPrefix={message.id}>{message.content}</Markdown>
            {!streaming && message.sources && <Sources sources={message.sources} idPrefix={message.id} />}
            {!streaming && <MessageActions content={message.content} />}
          </>
        )}
      </div>
    </div>
  );
}

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex h-7 items-center gap-3 text-sm text-muted-foreground" role="status">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-navy-400"
            style={{ animation: `folke-typing 1.2s ${i * 0.15}s infinite ease-in-out` }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}

/** Removes citation markers so copied text reads cleanly. */
function toPlainCopy(markdown: string) {
  return markdown.replace(/\s?\[\d{1,2}\](?!\()/g, "");
}

function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(toPlainCopy(content));
      setCopied(true);
      toast.success("Svaret har kopierats");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Det gick inte att kopiera texten");
    }
  }

  return (
    <div className="mt-3 -ml-2 flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={copy}
            aria-label="Kopiera svar"
            className="text-muted-foreground"
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Kopierat" : "Kopiera"}</TooltipContent>
      </Tooltip>
    </div>
  );
}
