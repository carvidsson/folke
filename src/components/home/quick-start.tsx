"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AssistantPicker } from "@/components/chat/assistant-picker";
import { Composer } from "@/components/chat/composer";
import { setPendingPrompt } from "@/lib/chat/pending-prompt";
import type { Assistant } from "@/lib/domain/types";

/** Start-page entry point: pick an assistant, type, and land in a new chat. */
export function QuickStart({ assistants }: { assistants: Assistant[] }) {
  const router = useRouter();
  const [assistantId, setAssistantId] = useState(assistants[0]?.id ?? "");
  const assistant = assistants.find((a) => a.id === assistantId);
  if (!assistant) return null;

  return (
    <Composer
      allowAttachments={false}
      className="mt-8"
      placeholder={`Fråga ${assistant.name}…`}
      leading={
        <AssistantPicker
          assistants={assistants}
          value={assistantId}
          onChange={setAssistantId}
          size="sm"
        />
      }
      onSubmit={({ text }) => {
        setPendingPrompt(text);
        router.push(`/chat?assistant=${assistant.slug}`);
      }}
    />
  );
}
