"use client";

import { ArrowDown, CircleAlert, Menu, MoreHorizontal, Paperclip, Pencil, RotateCcw, SquarePen, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { StatusBadge } from "@/components/common/status-badge";
import { useShell } from "@/components/layout/app-shell";
import { SidebarCollapseButton } from "@/components/layout/sidebar-collapse-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { takePendingPrompt } from "@/lib/chat/pending-prompt";
import { listConversationAttachmentsAction } from "@/server/attachments/actions";
import type { Assistant, ConversationDataClass, Message } from "@/lib/domain/types";

import { AssistantPicker } from "./assistant-picker";
import { Composer } from "./composer";
import { ConversationAttachmentsDialog } from "./conversation-attachments-dialog";
import { DeleteConversationsDialog, RenameConversationDialog } from "./conversation-dialogs";
import { AssistantMessage, UserMessage } from "./message";
import { ChatActionsContext } from "./chat-actions";
import { useChat } from "./use-chat";

export function ChatView({
  assistants,
  initialAssistantId,
  conversation,
  syntheticModeAvailable: syntheticSetting = false,
  attachmentsEnabled: attachmentsSetting = false,
}: {
  assistants: Assistant[];
  initialAssistantId: string;
  conversation?: { id: string; title: string; dataClass: ConversationDataClass; messages: Message[] };
  /** The user may start synthetic test conversations with OpenAI. */
  syntheticModeAvailable?: boolean;
  /** Conversation attachments are switched on (FOLKE_AI_ATTACHMENTS, ADR-045). */
  attachmentsEnabled?: boolean;
}) {
  const [assistantId, setAssistantId] = useState(initialAssistantId);
  const assistant = assistants.find((a) => a.id === assistantId) ?? assistants[0];
  const [syntheticRequested, setSyntheticRequested] = useState(false);
  // Leadanalys (ADR-050) has its own material: no attachments and no synthetic test mode.
  const isLead = assistant.kind === "lead_analysis";
  const attachmentsEnabled = attachmentsSetting && !isLead;
  const syntheticModeAvailable = syntheticSetting && !isLead;
  const synthetic = conversation ? conversation.dataClass === "synthetic" : syntheticModeAvailable && syntheticRequested;

  const chat = useChat({
    assistantId: assistant.id,
    conversationId: conversation?.id ?? null,
    initialMessages: conversation?.messages,
    mode: synthetic ? "synthetic" : "standard",
  });
  const { messages, status, isBusy, send } = chat;
  // "Ställ frågan igen" after a Leadanalys step (ADR-050): same conversation, same composer state.
  const chatActions = useMemo(() => ({ ask: (text: string) => send({ text, attachments: [] }), busy: isBusy }), [send, isBusy]);
  const isEmpty = messages.length === 0;

  // Prompt handed over from the start page's quick-start box.
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const pending = takePendingPrompt();
    if (pending) sendRef.current(pending);
  }, []);

  // Attachments of earlier messages that have since been removed.
  const [removedAttachments, setRemovedAttachments] = useState<Set<string>>(new Set());
  const refreshAttachments = useRef(() => {});
  useLayoutEffect(() => {
    refreshAttachments.current = () => {
      if (!conversation || !attachmentsEnabled) return;
      const referenced = messages.flatMap((m) => (m.attachments ?? []).flatMap((a) => (a.attachmentId ? [a.attachmentId] : [])));
      if (!referenced.length) return;
      void listConversationAttachmentsAction(conversation.id).then((list) => {
        const existing = new Set(list.map((a) => a.id));
        setRemovedAttachments(new Set(referenced.filter((id) => !existing.has(id))));
      });
    };
  });
  useEffect(() => refreshAttachments.current(), []);

  const composer = (
    <Composer
      onSubmit={send}
      onStop={chat.stop}
      isBusy={isBusy}
      attachments={attachmentsEnabled ? { conversationId: conversation?.id ?? null } : undefined}
      autoFocus
      placeholder={synthetic ? "Ställ en testfråga om de syntetiska dokumenten…" : `Fråga ${assistant.name}…`}
    />
  );

  const syntheticNotice = synthetic && (
    <p className="text-caption mt-2 text-center text-warning">
      Syntetiskt testläge: endast syntetiska testdokument används
      {chat.engine?.provider === "mock" ? "." : " och frågan skickas till OpenAI."} Skriv inte in verklig information.
    </p>
  );

  return (
    // overflow-hidden: nothing in the chat may add height to the page's own
    // scroll area (<main> in AppShell); only the message list scrolls.
    <ChatActionsContext.Provider value={chatActions}>
    <div className="flex h-full flex-col overflow-hidden">
      <ChatHeader
        title={conversation?.title}
        conversationId={conversation?.id}
        attachmentsEnabled={attachmentsEnabled}
        onAttachmentsChanged={() => refreshAttachments.current()}
        badge={
          synthetic && (
            <StatusBadge tone="warning" className="ml-1">
              Syntetiskt test
              {chat.engine ? ` · ${chat.engine.provider === "openai" ? (chat.engine.model ?? "OpenAI") : "mockläge"}` : ""}
            </StatusBadge>
          )
        }
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
            {syntheticModeAvailable && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <Switch id="synthetic-mode" checked={syntheticRequested} onCheckedChange={setSyntheticRequested} />
                <Label htmlFor="synthetic-mode" className="text-sm font-normal text-muted-foreground">
                  Syntetiskt testläge med OpenAI
                </Label>
              </div>
            )}
            {syntheticNotice}
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
                <UserMessage key={m.id} message={m} removedAttachments={removedAttachments} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  assistant={assistant}
                  pending={isLast && status === "submitted"}
                  waitingPhase={chat.waitingPhase}
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
              {syntheticNotice || (
                <p className="text-caption mt-2 text-center">
                  Folke kan göra fel. Kontrollera viktig information mot källorna.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
    </ChatActionsContext.Provider>
  );
}

function ChatHeader({
  title,
  picker,
  badge,
  conversationId,
  attachmentsEnabled = false,
  onAttachmentsChanged,
}: {
  title?: string;
  picker: React.ReactNode;
  badge?: React.ReactNode;
  conversationId?: string;
  attachmentsEnabled?: boolean;
  onAttachmentsChanged?: () => void;
}) {
  const { sidebarVisible, openMobileNav } = useShell();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);

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
      {badge}
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
              <Button variant="ghost" size="icon" aria-label="Fler alternativ för konversationen">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil />
                Byt namn
              </DropdownMenuItem>
              {attachmentsEnabled && (
                <DropdownMenuItem onSelect={() => setShowAttachments(true)}>
                  <Paperclip />
                  Bilagor
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                <Trash2 />
                Ta bort konversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {conversationId && (
          <>
            {attachmentsEnabled && (
              <ConversationAttachmentsDialog
                conversationId={conversationId}
                open={showAttachments}
                onOpenChange={setShowAttachments}
                onChanged={() => onAttachmentsChanged?.()}
              />
            )}
            <RenameConversationDialog
              conversation={renaming ? { id: conversationId, title: title ?? "" } : null}
              onOpenChange={setRenaming}
              onRenamed={() => router.refresh()}
            />
            <DeleteConversationsDialog
              conversationIds={deleting ? [conversationId] : null}
              onOpenChange={setDeleting}
              onDeleted={() => router.push("/chat")}
            />
          </>
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
        // relative: absolutely positioned content in messages (e.g. sr-only
        // labels) stays inside this scroll area instead of stretching the page.
        className="scrollbar-thin relative h-full overflow-y-auto px-4 sm:px-6"
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
