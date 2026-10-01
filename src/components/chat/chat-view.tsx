"use client";

import { ArrowDown, CircleAlert, Menu, MoreHorizontal, RotateCcw, SquarePen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { useShell } from "@/components/layout/app-shell";
import { SidebarCollapseButton } from "@/components/layout/sidebar-collapse-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { takePendingPrompt } from "@/lib/chat/pending-prompt";
import type { Assistant, Message } from "@/lib/domain/types";
import { deleteConversationAction } from "@/server/chat/actions";

import { AssistantPicker } from "./assistant-picker";
import { Composer } from "./composer";
import { AssistantMessage, UserMessage } from "./message";
import { useChat } from "./use-chat";

export function ChatView({
  assistants,
  initialAssistantId,
  conversation,
}: {
  assistants: Assistant[];
  initialAssistantId: string;
  conversation?: { id: string; title: string; messages: Message[] };
}) {
  const [assistantId, setAssistantId] = useState(initialAssistantId);
  const assistant = assistants.find((a) => a.id === assistantId) ?? assistants[0];

  const chat = useChat({
    assistantId: assistant.id,
    conversationId: conversation?.id ?? null,
    initialMessages: conversation?.messages,
  });
  const { messages, status, isBusy, send } = chat;
  const isEmpty = messages.length === 0;

  // Prompt handed over from the start page's quick-start box.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const pending = takePendingPrompt();
    if (pending) sendRef.current({ text: pending, attachments: [] });
  }, []);

  const composer = (
    <Composer
      onSubmit={send}
      onStop={chat.stop}
      isBusy={isBusy}
      // File contents are not processed in chat yet (see docs/ROADMAP.md).
      allowAttachments={false}
      autoFocus
      placeholder={`Fråga ${assistant.name}…`}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        title={conversation?.title}
        conversationId={conversation?.id}
        picker={
          <AssistantPicker
            assistants={assistants}
            value={assistant.id}
            onChange={setAssistantId}
            disabled={!isEmpty}
          />
        }
      />

      {isEmpty ? (
        <div className="scrollbar-thin flex flex-1 flex-col overflow-y-auto px-4 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center py-10">
            <div className="mb-8 flex flex-col items-center text-center">
              <AssistantAvatar assistant={assistant} size="lg" />
              <h1 className="text-display mt-5">Vad kan jag hjälpa dig med?</h1>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                {assistant.description}
              </p>
            </div>
            {composer}
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {assistant.suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send({ text: prompt, attachments: [] })}
                  className="rounded-xl border bg-background px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-navy-200 hover:bg-surface hover:text-foreground"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <MessageList stickKey={messages.at(-1)?.content.length ?? 0}>
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              return m.role === "user" ? (
                <UserMessage key={m.id} message={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  assistant={assistant}
                  pending={isLast && status === "submitted"}
                  streaming={isLast && status === "streaming"}
                />
              );
            })}
            {status === "error" && (
              <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <CircleAlert className="size-4 shrink-0" />
                <span className="flex-1">{chat.error}</span>
                <Button variant="outline" size="sm" onClick={chat.retry}>
                  <RotateCcw />
                  Försök igen
                </Button>
              </div>
            )}
          </MessageList>

          <div className="shrink-0 px-4 pb-3 sm:px-6">
            <div className="mx-auto max-w-3xl">
              {composer}
              <p className="text-caption mt-2 text-center">
                Folke kan göra fel. Kontrollera viktig information mot källorna.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ChatHeader({
  title,
  picker,
  conversationId,
}: {
  title?: string;
  picker: React.ReactNode;
  conversationId?: string;
}) {
  const { sidebarVisible, openMobileNav } = useShell();
  const router = useRouter();
  const [deleting, startDelete] = useTransition();

  function remove() {
    if (!conversationId) return;
    if (!window.confirm("Ta bort konversationen? Det går inte att ångra.")) return;
    startDelete(async () => {
      const result = await deleteConversationAction(conversationId);
      if (result.ok) {
        toast.success(result.message);
        router.push("/chat");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-3">
      <Button
        variant="ghost"
        size="icon"
        onClick={openMobileNav}
        aria-label="Öppna meny"
        className="lg:hidden"
      >
        <Menu />
      </Button>
      {!sidebarVisible && <SidebarCollapseButton label="Visa sidopanel" />}
      {picker}
      {title && (
        <>
          <span aria-hidden className="mx-1 hidden text-navy-200 md:inline">
            /
          </span>
          <h1 className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">
            {title}
          </h1>
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        {conversationId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Fler alternativ för konversationen" disabled={deleting}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={remove}>
                <Trash2 />
                Ta bort konversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button asChild variant="ghost" size="icon" className={sidebarVisible ? "lg:hidden" : undefined}>
          <Link href="/chat" aria-label="Ny chatt">
            <SquarePen />
          </Link>
        </Button>
      </div>
    </header>
  );
}

/** Scroll container that follows new content while the user is at the bottom. */
function MessageList({
  children,
  stickKey,
}: {
  children: React.ReactNode;
  stickKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [stickKey, children]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = atBottom;
          setShowJump(!atBottom);
        }}
        className="scrollbar-thin h-full overflow-y-auto px-4 sm:px-6"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-8 pt-6 pb-10">{children}</div>
      </div>
      {showJump && (
        <Button
          variant="outline"
          size="icon"
          aria-label="Till senaste meddelandet"
          onClick={() => {
            const el = ref.current;
            el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md"
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}
