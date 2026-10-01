import type { Metadata } from "next";

import { InstructionsView, type AssistantInstructionsRow } from "@/components/admin/instructions-view";
import { formatDate } from "@/lib/format";
import { approvedDocumentsEnabled } from "@/server/ai/guard";
import { FIXED_RULES } from "@/server/ai/prompt";
import { requireAdministrationAccess } from "@/server/auth/session";
import { getInstructionsForAdmin, listAssistants } from "@/server/data/assistants";
import { getInstructionDraft, getOrganizationInstructions, listInstructionRevisions } from "@/server/data/instructions";

export const metadata: Metadata = { title: "AI-instruktioner" };

export default async function InstructionsPage() {
  const { user } = await requireAdministrationAccess();
  const isAdmin = user.role === "system_admin";
  const [organization, organizationDraft, organizationRevisions, assistants] = await Promise.all([
    getOrganizationInstructions(),
    getInstructionDraft("organization"),
    listInstructionRevisions("organization"),
    listAssistants(),
  ]);

  // Only assistants the viewer may configure (instructions readable).
  const rows = (
    await Promise.all(
      assistants.map(async (assistant): Promise<AssistantInstructionsRow | null> => {
        const instructions = await getInstructionsForAdmin(assistant.id);
        if (instructions === null) return null;
        const [draft, revisions] = await Promise.all([
          getInstructionDraft("assistant", assistant.id),
          listInstructionRevisions("assistant", assistant.id),
        ]);
        return {
          assistant,
          target: {
            scope: "assistant",
            assistantId: assistant.id,
            published: instructions,
            draft,
            revisions,
            canEdit: true,
            minLength: 20,
          },
        };
      }),
    )
  ).filter((r) => r !== null);

  // Remount editors when published texts or drafts change (after publish/discard).
  const key = [organization?.updatedAt, organizationDraft?.updatedAt, ...rows.map((r) => r.target.draft?.updatedAt ?? r.target.revisions[0]?.id)].join("|");

  return (
    <InstructionsView
      key={key}
      organization={
        organization
          ? {
              scope: "organization",
              assistantId: null,
              published: organization.content,
              draft: organizationDraft,
              revisions: organizationRevisions,
              canEdit: isAdmin,
              minLength: 0,
            }
          : null
      }
      organizationMeta={
        organization
          ? `Publicerad ${formatDate(organization.updatedAt)}${organization.updatedByName ? ` av ${organization.updatedByName}` : ""}`
          : null
      }
      assistants={rows}
      fixedRules={[...FIXED_RULES]}
      aiEnabled={approvedDocumentsEnabled()}
    />
  );
}
