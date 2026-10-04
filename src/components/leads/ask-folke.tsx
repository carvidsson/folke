"use client";

import { MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { setPendingPrompt } from "@/lib/chat/pending-prompt";
import type { LeadChatContext } from "@/lib/leads/chat";

/**
 * "Fråga Folke" (ADR-050): opens a new chat with the Leadanalys assistant, starting from the page's
 * selection. The selection is help only – the server re-resolves it against the user's lead access.
 */
export function useAskFolke(assistantSlug: string | null) {
  const router = useRouter();
  if (!assistantSlug) return null;
  return (text: string, context: LeadChatContext) => {
    setPendingPrompt({ text, attachments: [], leadContext: context });
    router.push(`/chat?assistant=${encodeURIComponent(assistantSlug)}`);
  };
}

export function AskFolkeMenu({ assistantSlug, scopeName, context }: { assistantSlug: string | null; scopeName: string; context: LeadChatContext }) {
  const ask = useAskFolke(assistantSlug);
  if (!ask) return null;
  const questions = [
    `Vad sticker ut för ${scopeName} under perioden?`,
    "Hur ser svarstiderna ut, och vad påverkar dem?",
    "Vad fungerar bra och vad kan vi utveckla?",
    "Vad bör vi ta upp på nästa säljmöte?",
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <MessageSquareText className="size-4" />
          Fråga Folke
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Frågar om urvalet och perioden du tittar på</DropdownMenuLabel>
        {questions.map((q) => (
          <DropdownMenuItem key={q} onSelect={() => ask(q, context)}>
            {q}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
