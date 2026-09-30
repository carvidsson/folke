import { Bot } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";

export function NoAssistants() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={Bot}
        title="Du har inga assistenter ännu"
        description="Kontakta din systemadministratör för att få tillgång till en assistent."
      />
    </div>
  );
}
