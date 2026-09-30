"use client";

import { MoreHorizontal, SearchX, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { EmptyState } from "@/components/common/empty-state";
import {
  ALL,
  ClearFiltersButton,
  FilterBar,
  FilterSelect,
  ResultCount,
  SearchInput,
} from "@/components/common/filters";
import { Panel, StatTile } from "@/components/common/panel";
import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROLE_LABELS, USER_STATUS_LABELS } from "@/lib/domain/labels";
import type { Assistant, Role, User, UserStatus } from "@/lib/domain/types";
import { formatRelative } from "@/lib/format";

import { InviteUserDialog } from "./invite-user-dialog";

export interface UserRow {
  user: User;
  groupNames: string[];
  assistantIds: string[];
}

const STATUS_TONES: Record<UserStatus, StatusTone> = {
  active: "success",
  invited: "info",
  disabled: "neutral",
};

const ROLE_BADGE: Record<Role, string> = {
  system_admin: "border-navy-200 bg-navy-50 text-navy-800",
  assistant_manager: "border-sage-200 bg-sage-50 text-sage-700",
  employee: "border-border bg-background text-muted-foreground",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant="outline" className={`font-medium ${ROLE_BADGE[role]}`}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

const prototypeToast = () => toast("Prototyp: ändringen sparas inte.");

export function UsersView({
  rows,
  assistants,
  groups,
  nowIso,
}: {
  rows: UserRow[];
  assistants: Assistant[];
  groups: { id: string; name: string }[];
  nowIso: string;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [inviteOpen, setInviteOpen] = useState(false);

  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const assistantById = useMemo(() => new Map(assistants.map((a) => [a.id, a])), [assistants]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      ({ user, groupNames }) =>
        (role === ALL || user.role === role) &&
        (status === ALL || user.status === status) &&
        (!q ||
          user.name.toLowerCase().includes(q) ||
          user.email.toLowerCase().includes(q) ||
          user.title.toLowerCase().includes(q) ||
          groupNames.some((g) => g.toLowerCase().includes(q))),
    );
  }, [rows, query, role, status]);

  const count = (fn: (u: User) => boolean) => rows.filter((r) => fn(r.user)).length;
  const hasFilters = query !== "" || role !== ALL || status !== ALL;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Användare"
        description="Hantera vilka som har tillgång till Folke, deras roll och gruppmedlemskap."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus />
            Bjud in användare
          </Button>
        }
      />

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Aktiva" value={count((u) => u.status === "active")} />
        <StatTile
          label="Inbjudna"
          value={count((u) => u.status === "invited")}
          active={status === "invited"}
          onClick={() => setStatus((s) => (s === "invited" ? ALL : "invited"))}
        />
        <StatTile
          label="Aktiva utan MFA"
          value={count((u) => u.status === "active" && !u.mfaEnrolled)}
          hint={<span className="text-xs text-warning">Kräver åtgärd</span>}
        />
        <StatTile label="Inaktiverade" value={count((u) => u.status === "disabled")} />
      </div>

      <FilterBar className="mt-6">
        <SearchInput value={query} onChange={setQuery} placeholder="Sök namn, e-post eller grupp" />
        <FilterSelect
          label="Roll"
          value={role}
          onChange={setRole}
          allLabel="Alla roller"
          options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          label="Status"
          value={status}
          onChange={setStatus}
          allLabel="Alla statusar"
          options={Object.entries(USER_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ClearFiltersButton
          visible={hasFilters}
          onClick={() => {
            setQuery("");
            setRole(ALL);
            setStatus(ALL);
          }}
        />
        <ResultCount shown={filtered.length} total={rows.length} noun="användare" />
      </FilterBar>

      <Panel className="mt-4">
        {filtered.length === 0 ? (
          <EmptyState icon={SearchX} title="Inga användare matchar" description="Prova en annan sökning eller rensa filtren." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Användare</TableHead>
                <TableHead className="hidden md:table-cell">Roll</TableHead>
                <TableHead className="hidden 2xl:table-cell">Grupper</TableHead>
                <TableHead className="hidden lg:table-cell">Assistenter</TableHead>
                <TableHead className="hidden sm:table-cell">MFA</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Senast aktiv</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Åtgärder</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(({ user, groupNames, assistantIds }) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <UserAvatar name={user.name} />
                      <div className="min-w-0">
                        <p className="font-medium">{user.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <RoleBadge role={user.role} />
                  </TableCell>
                  <TableCell className="hidden 2xl:table-cell">
                    <div className="flex items-center gap-1">
                      {groupNames.slice(0, 2).map((g) => (
                        <Badge key={g} variant="secondary" className="font-normal">
                          {g}
                        </Badge>
                      ))}
                      {groupNames.length > 2 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="font-normal">
                              +{groupNames.length - 2}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>{groupNames.slice(2).join(", ")}</TooltipContent>
                        </Tooltip>
                      )}
                      {groupNames.length === 0 && <span className="text-muted-foreground">–</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex -space-x-1">
                      {assistantIds.map((id) => {
                        const a = assistantById.get(id);
                        return (
                          a && (
                            <Tooltip key={id}>
                              <TooltipTrigger asChild>
                                <span>
                                  <AssistantAvatar assistant={a} size="sm" className="ring-2 ring-card" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{a.name}</TooltipContent>
                            </Tooltip>
                          )
                        );
                      })}
                      {assistantIds.length === 0 && <span className="text-muted-foreground">–</span>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {user.mfaEnrolled ? (
                      <StatusBadge tone="success">Aktiverad</StatusBadge>
                    ) : (
                      <StatusBadge tone="warning">Saknas</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={STATUS_TONES[user.status]}>
                      {USER_STATUS_LABELS[user.status]}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {user.lastActiveAt ? formatRelative(user.lastActiveAt, now) : "Aldrig"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Åtgärder för ${user.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={prototypeToast}>Redigera användare</DropdownMenuItem>
                        <DropdownMenuItem onSelect={prototypeToast}>Ändra roll</DropdownMenuItem>
                        <DropdownMenuItem onSelect={prototypeToast}>Hantera grupper</DropdownMenuItem>
                        {user.status === "invited" && (
                          <DropdownMenuItem onSelect={prototypeToast}>Skicka inbjudan igen</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={prototypeToast}>
                          {user.status === "disabled" ? "Återaktivera" : "Inaktivera"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} groups={groups} />
    </PageContainer>
  );
}
