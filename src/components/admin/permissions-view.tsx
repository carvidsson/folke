"use client";

import { Check, Info, Minus, Plus, User, X } from "lucide-react";
import { useMemo, useState } from "react";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Panel } from "@/components/common/panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CAPABILITY_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/domain/labels";
import { ROLE_CAPABILITIES } from "@/lib/domain/roles";
import type { Assistant, Role } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

import { addUserGrantAction, removeGrantAction, saveGroupGrantsAction } from "@/server/admin/actions";

import { useAdminAction } from "./use-admin-action";
import { RoleBadge } from "./users-view";

export interface PermissionsData {
  groups: { id: string; name: string; memberCount: number }[];
  assistants: Assistant[];
  /** groupId -> assistantIds */
  groupGrants: Record<string, string[]>;
  directGrants: { id: string; userName: string; assistantId: string }[];
  users: { id: string; name: string }[];
  collections: { id: string; name: string }[];
  /** groupId -> collectionId -> coverage */
  documentCoverage: Record<string, Record<string, { visible: number; total: number }>>;
  roleCounts: Partial<Record<Role, number>>;
}

const key = (groupId: string, assistantId: string) => `${groupId}:${assistantId}`;

function toSet(grants: Record<string, string[]>) {
  return new Set(Object.entries(grants).flatMap(([g, ids]) => ids.map((a) => key(g, a))));
}

export function PermissionsView({ data }: { data: PermissionsData }) {
  const initial = useMemo(() => toSet(data.groupGrants), [data.groupGrants]);
  const [grants, setGrants] = useState(initial);
  const [grantUser, setGrantUser] = useState("");
  const [grantAssistant, setGrantAssistant] = useState("");
  const { pending, run } = useAdminAction();

  const changes = useMemo(
    () => [...grants].filter((k) => !initial.has(k)).length + [...initial].filter((k) => !grants.has(k)).length,
    [grants, initial],
  );

  function toggle(k: string) {
    setGrants((current) => {
      const next = new Set(current);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const assistantById = new Map(data.assistants.map((a) => [a.id, a]));

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Behörigheter"
        description="Tilldela assistenter och dokument till grupper. Rollerna styr endast vad användaren får administrera."
      />

      <div className="mt-6 flex items-start gap-3 rounded-xl border bg-brand-subtle px-4 py-3.5 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-foreground" />
        <p className="text-foreground/85">
          <span className="font-medium text-foreground">Assistentåtkomst och dokumentåtkomst är separata.</span>{" "}
          En assistent kan bara använda ett dokument som källa om användaren har behörighet till
          både assistenten och dokumentet.
        </p>
      </div>

      <Tabs defaultValue="assistants" className="mt-8 gap-5">
        <TabsList>
          <TabsTrigger value="assistants">Assistentåtkomst</TabsTrigger>
          <TabsTrigger value="documents">Dokumentåtkomst</TabsTrigger>
          <TabsTrigger value="roles">Roller</TabsTrigger>
        </TabsList>

        <TabsContent value="assistants" className="flex flex-col gap-6">
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-48">Grupp</TableHead>
                  {data.assistants.map((a) => (
                    <TableHead key={a.id} className="text-center">
                      <span className="inline-flex flex-col items-center gap-1.5 py-2">
                        <AssistantAvatar assistant={a} size="xs" />
                        {a.name}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      <p className="font-medium">{g.name}</p>
                      <p className="text-xs text-muted-foreground">{g.memberCount} medlemmar</p>
                    </TableCell>
                    {data.assistants.map((a) => {
                      const k = key(g.id, a.id);
                      const on = grants.has(k);
                      const changed = on !== initial.has(k);
                      return (
                        <TableCell key={a.id} className="text-center">
                          <span
                            className={cn(
                              "inline-flex size-8 items-center justify-center rounded-md",
                              changed && "bg-warning-subtle",
                            )}
                          >
                            <Checkbox
                              checked={on}
                              onCheckedChange={() => toggle(k)}
                              aria-label={`${g.name} – ${a.name}`}
                            />
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          {changes > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
              <p className="flex-1 text-sm">
                <span className="font-medium">{changes} osparade ändringar.</span>{" "}
                <span className="text-muted-foreground">Ändringarna gäller direkt när du sparar.</span>
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setGrants(initial)} disabled={pending}>
                  Återställ
                </Button>
                <Button
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      saveGroupGrantsAction(
                        [...new Set([...grants, ...initial])]
                          .filter((k) => grants.has(k) !== initial.has(k))
                          .map((k) => {
                            const [groupId, assistantId] = k.split(":");
                            return { groupId, assistantId, granted: grants.has(k) };
                          }),
                      ),
                    )
                  }
                >
                  Spara ändringar
                </Button>
              </div>
            </div>
          )}

          <section>
            <h2 className="text-heading mb-3">Individuella tilldelningar</h2>
            <Panel>
              <ul className="divide-y">
                {data.directGrants.map((d) => {
                  const a = assistantById.get(d.assistantId);
                  return (
                    <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <User className="size-4 text-muted-foreground" />
                      <span className="flex-1 font-medium">{d.userName}</span>
                      {a && (
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <AssistantAvatar assistant={a} size="xs" />
                          {a.name}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={pending}
                        aria-label={`Ta bort ${a?.name ?? "assistenten"} för ${d.userName}`}
                        onClick={() => run(() => removeGrantAction(d.id))}
                      >
                        <X />
                      </Button>
                    </li>
                  );
                })}
                <li className="flex flex-col gap-2 bg-surface px-4 py-3 sm:flex-row sm:items-center">
                  <Select value={grantUser} onValueChange={setGrantUser}>
                    <SelectTrigger aria-label="Användare" className="h-9 bg-background sm:w-64 data-[size=default]:h-9">
                      <SelectValue placeholder="Välj användare" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={grantAssistant} onValueChange={setGrantAssistant}>
                    <SelectTrigger aria-label="Assistent" className="h-9 bg-background sm:w-56 data-[size=default]:h-9">
                      <SelectValue placeholder="Välj assistent" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.assistants.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    className="bg-background"
                    disabled={pending || !grantUser || !grantAssistant}
                    onClick={() =>
                      run(
                        () => addUserGrantAction(grantUser, grantAssistant),
                        () => {
                          setGrantUser("");
                          setGrantAssistant("");
                        },
                      )
                    }
                  >
                    <Plus />
                    Lägg till
                  </Button>
                </li>
              </ul>
            </Panel>
          </section>
        </TabsContent>

        <TabsContent value="documents" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Antal dokument per samling som gruppens medlemmar kan se via gruppen. Delning ställs in
            per dokument i kunskapsbanken.
          </p>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-48">Grupp</TableHead>
                  {data.collections.map((c) => (
                    <TableHead key={c.id} className="text-center">
                      {c.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.name}</TableCell>
                    {data.collections.map((c) => {
                      const { visible, total } = data.documentCoverage[g.id][c.id];
                      return (
                        <TableCell key={c.id} className="text-center">
                          <Coverage visible={visible} total={total} />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><Coverage visible={1} total={1} /> Alla dokument</span>
            <span className="flex items-center gap-1.5"><Coverage visible={1} total={2} /> Delvis</span>
            <span className="flex items-center gap-1.5"><Coverage visible={0} total={1} /> Ingen åtkomst</span>
          </div>
        </TabsContent>

        <TabsContent value="roles">
          <div className="grid gap-4 lg:grid-cols-3">
            {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
              <article key={role} className="flex flex-col rounded-xl border bg-card p-5 shadow-xs">
                <div className="flex items-center justify-between">
                  <RoleBadge role={role} />
                  <span className="text-xs text-muted-foreground">
                    {data.roleCounts[role] ?? 0} användare
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
                <ul className="mt-4 flex flex-col gap-2 border-t pt-4 text-sm">
                  {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map((cap) => {
                    const has = ROLE_CAPABILITIES[role].includes(cap);
                    return (
                      <li key={cap} className={cn("flex items-start gap-2", !has && "text-subtle-foreground")}>
                        {has ? (
                          <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        ) : (
                          <Minus className="mt-0.5 size-4 shrink-0" />
                        )}
                        <span>
                          <span className="sr-only">{has ? "Ja: " : "Nej: "}</span>
                          {CAPABILITY_LABELS[cap]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
          <p className="text-caption mt-4">
            Rollerna styr administration. Behörigheterna kontrolleras på servern och i databasen
            (Row Level Security) vid varje anrop.
          </p>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function Coverage({ visible, total }: { visible: number; total: number }) {
  if (total === 0) return <span className="text-subtle-foreground">–</span>;
  const full = visible === total;
  const none = visible === 0;
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-12 items-center justify-center rounded-md px-2 text-xs font-medium tabular-nums",
        full && "bg-success-subtle text-success",
        !full && !none && "bg-warning-subtle text-warning",
        none && "bg-muted text-subtle-foreground",
      )}
    >
      {visible}/{total}
    </span>
  );
}
