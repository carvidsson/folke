import type { Metadata } from "next";

import { AIAdminView } from "@/components/admin/ai-view";
import { externalProviderConfigured } from "@/server/ai/guard";
import {
  COST_LEVEL_LABELS,
  allowedChatModels,
  defaultChatModel,
  embeddingModel,
  resolveChatModel,
  typicalAnswerCostUsd,
} from "@/server/ai/models";
import { getSyntheticStatus } from "@/server/ai/test-data";
import { requireSystemAdminPage } from "@/server/auth/session";
import { listAssistants } from "@/server/data/assistants";
import { getAISpend } from "@/server/data/operations";
import { listUsers } from "@/server/data/users";
import { serverEnv } from "@/server/env";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const metadata: Metadata = { title: "AI och modeller" };

export default async function AIAdminPage() {
  await requireSystemAdminPage();
  const env = serverEnv();
  const openAI = externalProviderConfigured();

  const supabase = await createSupabaseServerClient();
  const [assistants, spend, users, testAccess, synthetic] = await Promise.all([
    listAssistants(),
    getAISpend(),
    listUsers(),
    supabase.from("profiles").select("id").eq("ai_test_access", true).returns<{ id: string }[]>(),
    // Counts only; the page is restricted to system administrators above.
    openAI ? getSyntheticStatus() : Promise.resolve(null),
  ]);
  const testAccessIds = new Set((testAccess.data ?? []).map((p) => p.id));

  return (
    <AIAdminView
      openAI={openAI}
      status={{
        provider: env.FOLKE_AI_PROVIDER,
        keyConfigured: Boolean(env.OPENAI_API_KEY),
        project: env.OPENAI_PROJECT ? "Angivet" : "Nyckelns projekt",
        organization: env.OPENAI_ORGANIZATION ? "Angiven" : "Nyckelns standardorganisation",
        endpoint: env.OPENAI_BASE_URL ? new URL(env.OPENAI_BASE_URL).host : "api.openai.com",
        dataPolicy: env.FOLKE_AI_EXTERNAL_DATA,
        embeddingModel: `${embeddingModel().id} (${embeddingModel().dimensions} dimensioner)`,
        limits: {
          userDailyUsd: env.FOLKE_AI_USER_DAILY_LIMIT_USD,
          monthlyUsd: env.FOLKE_AI_MONTHLY_LIMIT_USD,
          concurrent: env.FOLKE_AI_MAX_CONCURRENT_PER_USER,
          perMinute: env.FOLKE_AI_MAX_REQUESTS_PER_MINUTE,
          maxOutputTokens: env.FOLKE_AI_MAX_OUTPUT_TOKENS,
        },
        spend,
      }}
      models={allowedChatModels().map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        costLevel: COST_LEVEL_LABELS[m.costLevel],
        priceLabel: `${m.inputUsdPerMTok} / ${m.outputUsdPerMTok} USD per miljon tokens in/ut`,
        typicalAnswerUsd: typicalAnswerCostUsd(m),
        isDefault: m.id === defaultChatModel().id,
      }))}
      assistants={assistants.map((a) => ({
        assistant: a,
        modelId: resolveChatModel(a.aiModel).id,
        storedModel: a.aiModel,
      }))}
      synthetic={synthetic}
      users={users
        .filter((u) => u.status === "active")
        .map((u) => ({ id: u.id, name: u.name, email: u.email, testAccess: testAccessIds.has(u.id) }))}
    />
  );
}
