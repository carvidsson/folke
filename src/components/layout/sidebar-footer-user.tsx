import { FlaskConical } from "lucide-react";

import { ROLE_LABELS } from "@/lib/domain/labels";
import { canSeeAdministration } from "@/lib/domain/roles";
import type { User } from "@/lib/domain/types";
import { serverEnv } from "@/server/env";

import { SidebarFooter } from "./sidebar";
import { UserMenu } from "./user-menu";

export function SidebarFooterUser({ user }: { user: User }) {
  return (
    <SidebarFooter>
      <p className="mb-2 flex items-center gap-1.5 px-1.5 text-[0.6875rem] text-subtle-foreground">
        <FlaskConical className="size-3.5" strokeWidth={1.75} />
        {serverEnv().FOLKE_AI_PROVIDER === "mock" ? "Pilot · AI i mockläge" : "Pilot"}
      </p>
      <UserMenu
        user={{
          name: user.name,
          email: user.email,
          roleLabel: ROLE_LABELS[user.role],
          canAdminister: canSeeAdministration(user.role),
        }}
      />
    </SidebarFooter>
  );
}
