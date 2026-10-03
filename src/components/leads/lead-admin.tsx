"use client";

import { Check, Link2, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useAdminAction } from "@/components/admin/use-admin-action";
import { Panel } from "@/components/common/panel";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { LeadInboxConfig, LeadRegion } from "@/lib/leads/types";
import {
  addLeadGrantAction,
  clearThreadUrlAction,
  deleteLeadRegionAction,
  removeLeadGrantAction,
  saveLeadInboxAction,
  saveLeadRegionAction,
  saveThreadUrlAction,
} from "@/server/leads/admin-actions";

interface Grant {
  id: string;
  subject: "user" | "group";
  subjectId: string;
  subjectName: string;
  regionId: string | null;
}

const NONE = "__none";
const ALL = "__all";

/**
 * Configuration of the lead analysis (ADR-048). Changes are saved per row
 * and logged; RLS only lets system administrators write.
 */
export function LeadAdmin({
  inboxes,
  loadError,
  regions,
  grants,
  groups,
  users,
  threadTemplate,
}: {
  inboxes: LeadInboxConfig[];
  loadError: boolean;
  regions: LeadRegion[];
  grants: Grant[];
  groups: { id: string; name: string; members: number }[];
  users: { id: string; name: string; email: string }[];
  threadTemplate: string | null;
}) {
  const active = inboxes.filter((i) => i.active).length;
  return (
    <Tabs defaultValue="inboxes" className="mt-8">
      <TabsList>
        <TabsTrigger value="inboxes">Inkorgar ({active})</TabsTrigger>
        <TabsTrigger value="regions">Regioner ({regions.length})</TabsTrigger>
        <TabsTrigger value="access">Åtkomst ({grants.length})</TabsTrigger>
        <TabsTrigger value="link">Länk till HubSpot</TabsTrigger>
      </TabsList>
      <TabsContent value="inboxes" className="mt-4">
        <Inboxes inboxes={inboxes} regions={regions} loadError={loadError} />
      </TabsContent>
      <TabsContent value="regions" className="mt-4">
        <Regions regions={regions} inboxes={inboxes} />
      </TabsContent>
      <TabsContent value="access" className="mt-4">
        <Access grants={grants} regions={regions} groups={groups} users={users} />
      </TabsContent>
      <TabsContent value="link" className="mt-4">
        <ThreadLink template={threadTemplate} />
      </TabsContent>
    </Tabs>
  );
}

function Inboxes({ inboxes, regions, loadError }: { inboxes: LeadInboxConfig[]; regions: LeadRegion[]; loadError: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? inboxes : inboxes.filter((i) => i.active || i.configured);
  return (
    <>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        HubSpots inkorg-id är den stabila kopplingen; namnet hämtas från HubSpot. Bara aktiva inkorgar ingår i översikten. Region styr både översikten och vem som får se inkorgen.
      </p>
      {loadError && <p className="mb-3 text-sm text-destructive">Inkorgarna kunde inte hämtas från HubSpot. Ladda om sidan om en stund.</p>}
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Inkorg i HubSpot</TableHead>
              <TableHead>Aktiv</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Anläggning</TableHead>
              <TableHead>Varumärke</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((i) => (
              <InboxRow key={i.id} inbox={i} regions={regions} />
            ))}
          </TableBody>
        </Table>
        <div className="border-t px-6 py-3 text-sm">
          <button type="button" className="font-medium underline underline-offset-4" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Visa bara valda inkorgar" : `Visa alla ${inboxes.length} inkorgar i HubSpot`}
          </button>
        </div>
      </Panel>
    </>
  );
}

function InboxRow({ inbox, regions }: { inbox: LeadInboxConfig; regions: LeadRegion[] }) {
  const [state, setState] = useState({ active: inbox.active, regionId: inbox.regionId ?? NONE, facility: inbox.facility ?? "", brand: inbox.brand ?? "" });
  const { pending, run } = useAdminAction();
  const dirty =
    state.active !== inbox.active || state.regionId !== (inbox.regionId ?? NONE) || state.facility !== (inbox.facility ?? "") || state.brand !== (inbox.brand ?? "");
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{inbox.name}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">id {inbox.id}</span>
      </TableCell>
      <TableCell>
        <Switch checked={state.active} onCheckedChange={(v) => setState({ ...state, active: v })} aria-label={`Ta med ${inbox.name}`} />
      </TableCell>
      <TableCell>
        <Select value={state.regionId} onValueChange={(v) => setState({ ...state, regionId: v })}>
          <SelectTrigger className="h-8 w-36" aria-label={`Region för ${inbox.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Ingen region</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input className="h-8 w-32" value={state.facility} maxLength={80} onChange={(e) => setState({ ...state, facility: e.target.value })} aria-label={`Anläggning för ${inbox.name}`} placeholder="t.ex. Alingsås" />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-32" value={state.brand} maxLength={80} onChange={(e) => setState({ ...state, brand: e.target.value })} aria-label={`Varumärke för ${inbox.name}`} placeholder="t.ex. Volkswagen" />
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant={dirty ? "default" : "ghost"}
          disabled={!dirty || pending}
          onClick={() =>
            run(() =>
              saveLeadInboxAction({
                id: inbox.id,
                active: state.active,
                regionId: state.regionId === NONE ? null : state.regionId,
                facility: state.facility,
                brand: state.brand,
              }),
            )
          }
        >
          {dirty ? "Spara" : <Check className="size-4" aria-label="Sparad" />}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function Regions({ regions, inboxes }: { regions: LeadRegion[]; inboxes: LeadInboxConfig[] }) {
  const [name, setName] = useState("");
  const { pending, run } = useAdminAction();
  return (
    <>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Regioner är en organisatorisk dimension över inkorgarna. De går att döpa om och lägga till; en region med inkorgar kan inte tas bort.
      </p>
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Region</TableHead>
              <TableHead className="text-right">Aktiva inkorgar</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {regions.map((r) => (
              <RegionRow key={r.id} region={r} count={inboxes.filter((i) => i.regionId === r.id && i.active).length} />
            ))}
          </TableBody>
        </Table>
        <form
          className="flex items-end gap-2 border-t px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => saveLeadRegionAction({ name, sortOrder: regions.length + 1 }), () => setName(""));
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-region">Ny region</Label>
            <Input id="new-region" className="h-8 w-56" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={!name.trim() || pending}>
            <Plus />
            Lägg till
          </Button>
        </form>
      </Panel>
    </>
  );
}

function RegionRow({ region, count }: { region: LeadRegion; count: number }) {
  const [name, setName] = useState(region.name);
  const { pending, run } = useAdminAction();
  return (
    <TableRow>
      <TableCell>
        <Input className="h-8 w-56" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Regionens namn" />
      </TableCell>
      <TableCell className="text-right tabular-nums">{count}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant={name !== region.name ? "default" : "ghost"} disabled={name === region.name || !name.trim() || pending} onClick={() => run(() => saveLeadRegionAction({ id: region.id, name, sortOrder: region.sortOrder }))}>
            Spara
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || count > 0}
            aria-label={`Ta bort ${region.name}`}
            onClick={() => window.confirm(`Ta bort regionen ${region.name}? Åtkomst som gäller bara regionen tas också bort.`) && run(() => deleteLeadRegionAction(region.id))}
          >
            <Trash2 />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function Access({ grants, regions, groups, users }: { grants: Grant[]; regions: LeadRegion[]; groups: { id: string; name: string; members: number }[]; users: { id: string; name: string; email: string }[] }) {
  const [subject, setSubject] = useState<"group" | "user">("group");
  const [subjectId, setSubjectId] = useState("");
  const [regionId, setRegionId] = useState(ALL);
  const { pending, run } = useAdminAction();
  const regionName = useMemo(() => new Map(regions.map((r) => [r.id, r.name])), [regions]);
  const options = subject === "group" ? groups.map((g) => ({ id: g.id, label: `${g.name} (${g.members})` })) : users.map((u) => ({ id: u.id, label: u.name || u.email }));
  return (
    <>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Ge befintliga Folke-grupper eller enskilda användare tillgång till leadanalysen, för alla regioner eller en region i taget. Systemadministratörer har alltid full åtkomst. Åtkomsten kontrolleras i databasen – inte bara i menyn.
      </p>
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Grupp eller användare</TableHead>
              <TableHead>Får se</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-sm text-muted-foreground">
                  Ingen utöver systemadministratörer har åtkomst ännu.
                </TableCell>
              </TableRow>
            )}
            {grants.map((g) => (
              <TableRow key={g.id}>
                <TableCell>
                  <span className="font-medium">{g.subjectName}</span>
                  <StatusBadge tone="neutral" className="ml-2">
                    {g.subject === "group" ? "Grupp" : "Användare"}
                  </StatusBadge>
                </TableCell>
                <TableCell>{g.regionId ? (regionName.get(g.regionId) ?? "Okänd region") : "Alla regioner"}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="ghost" disabled={pending} aria-label={`Ta bort åtkomst för ${g.subjectName}`} onClick={() => run(() => removeLeadGrantAction(g.id))}>
                    <X />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <form
          className="flex flex-wrap items-end gap-2 border-t px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => addLeadGrantAction({ subject, subjectId, regionId: regionId === ALL ? null : regionId }), () => setSubjectId(""));
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label>Typ</Label>
            <Select
              value={subject}
              onValueChange={(v) => {
                setSubject(v as "group" | "user");
                setSubjectId("");
              }}
            >
              <SelectTrigger className="h-8 w-32" aria-label="Typ">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="group">Grupp</SelectItem>
                <SelectItem value="user">Användare</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{subject === "group" ? "Grupp" : "Användare"}</Label>
            <Select value={subjectId} onValueChange={setSubjectId}>
              <SelectTrigger className="h-8 w-60" aria-label={subject === "group" ? "Grupp" : "Användare"}>
                <SelectValue placeholder="Välj" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Får se</Label>
            <Select value={regionId} onValueChange={setRegionId}>
              <SelectTrigger className="h-8 w-40" aria-label="Region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Alla regioner</SelectItem>
                {regions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={!subjectId || pending}>
            <Plus />
            Ge åtkomst
          </Button>
        </form>
      </Panel>
      <p className="mt-2 text-xs text-muted-foreground">
        Med en region ser användaren bara regionens aktiva inkorgar, leads och analyser. Sammanvägningen för alla regioner kräver åtkomst till alla regioner.
      </p>
    </>
  );
}

function ThreadLink({ template }: { template: string | null }) {
  const [url, setUrl] = useState("");
  const { pending, run } = useAdminAction();
  return (
    <Panel className="px-6 py-5">
      <p className="max-w-2xl text-sm">
        HubSpot dokumenterar inte adressen till en enskild konversation, så Folke gissar den inte. Öppna en konversation i HubSpots inkorg, kopiera adressen och klistra in den här. Folke kontrollerar att adressen hör till Börjessons HubSpot-konto och att den pekar på en konversation som finns, och bygger sedan länkarna utifrån den.
      </p>
      {template ? (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone="success">Verifierad</StatusBadge>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">{template}</code>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => clearThreadUrlAction())}>
            Ta bort
          </Button>
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Ingen länk är verifierad. Leadanalysen visas utan länkar till HubSpot tills dess.</p>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveThreadUrlAction(url), () => setUrl(""));
        }}
      >
        <div className="flex min-w-72 flex-1 flex-col gap-1.5">
          <Label htmlFor="thread-url">Adress till en konversation i HubSpot</Label>
          <Input id="thread-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.hubspot.com/…" />
        </div>
        <Button type="submit" size="sm" disabled={!url.trim() || pending}>
          <Link2 />
          Verifiera och spara
        </Button>
      </form>
    </Panel>
  );
}
