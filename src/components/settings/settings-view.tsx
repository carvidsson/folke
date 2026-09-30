"use client";

import { KeyRound, MonitorSmartphone, Smartphone } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { PrototypeNotice } from "@/components/common/prototype-notice";
import { StatusBadge } from "@/components/common/status-badge";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Assistant } from "@/lib/domain/types";

interface ProfileUser {
  name: string;
  email: string;
  title: string;
  department: string;
  location: string;
  roleLabel: string;
}

const savePrototype = () => toast("Prototyp: inställningarna sparas inte.");

export function SettingsView({ user, assistants }: { user: ProfileUser; assistants: Assistant[] }) {
  return (
    <PageContainer width="narrow">
      <PageHeader title="Inställningar" description="Din profil, säkerhet och personliga preferenser." />

      <Tabs defaultValue="profile" className="mt-8 gap-6">
        <TabsList variant="line" className="w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0.5">
          <TabsTrigger value="profile">Profil</TabsTrigger>
          <TabsTrigger value="security">Säkerhet</TabsTrigger>
          <TabsTrigger value="preferences">Preferenser</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Profile user={user} />
        </TabsContent>
        <TabsContent value="security">
          <Security />
        </TabsContent>
        <TabsContent value="preferences">
          <Preferences assistants={assistants} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card shadow-xs">
      <div className="p-6">
        <h2 className="text-heading">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-5">{children}</div>
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-2 border-t bg-surface px-6 py-3 [border-bottom-left-radius:inherit] [border-bottom-right-radius:inherit]">
          {footer}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-caption">{hint}</p>}
    </div>
  );
}

function Profile({ user }: { user: ProfileUser }) {
  const id = useId();
  return (
    <SettingsCard
      title="Profil"
      description="Uppgifterna används för att anpassa assistenternas svar, t.ex. i signaturer."
      footer={<Button onClick={savePrototype}>Spara</Button>}
    >
      <div className="mb-6 flex items-center gap-4">
        <UserAvatar name={user.name} size="lg" />
        <div>
          <p className="font-medium">{user.name}</p>
          <p className="text-sm text-muted-foreground">{user.roleLabel}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Namn" htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} defaultValue={user.name} className="h-9" />
        </Field>
        <Field label="E-postadress" htmlFor={`${id}-email`} hint="Ändras av en systemadministratör.">
          <Input id={`${id}-email`} defaultValue={user.email} disabled className="h-9" />
        </Field>
        <Field label="Titel" htmlFor={`${id}-title`}>
          <Input id={`${id}-title`} defaultValue={user.title} className="h-9" />
        </Field>
        <Field label="Avdelning" htmlFor={`${id}-department`}>
          <Input id={`${id}-department`} defaultValue={user.department} className="h-9" />
        </Field>
        <Field label="Anläggning" htmlFor={`${id}-location`}>
          <Input id={`${id}-location`} defaultValue={user.location} className="h-9" />
        </Field>
      </div>
    </SettingsCard>
  );
}

function SecurityRow({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof KeyRound;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function Security() {
  const planned = <StatusBadge tone="neutral">Planerad</StatusBadge>;
  return (
    <div className="flex flex-col gap-4">
      <PrototypeNotice>
        Inloggning och säkerhetsinställningar är inte införda ännu. Nedan visas hur de kommer att
        fungera – ingenting här är aktivt.
      </PrototypeNotice>
      <SettingsCard title="Inloggning och säkerhet">
        <div className="divide-y">
          <SecurityRow
            icon={KeyRound}
            title="Lösenord"
            description="Byt lösenord. Minst 12 tecken krävs."
            action={planned}
          />
          <SecurityRow
            icon={Smartphone}
            title="Tvåstegsverifiering (TOTP)"
            description="Obligatorisk för alla användare. Konfigureras med en autentiseringsapp vid första inloggningen."
            action={planned}
          />
          <SecurityRow
            icon={MonitorSmartphone}
            title="Aktiva sessioner"
            description="Se var du är inloggad och logga ut andra enheter."
            action={planned}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

function Preferences({ assistants }: { assistants: Assistant[] }) {
  const id = useId();
  const [defaultAssistant, setDefaultAssistant] = useState(assistants[0]?.id ?? "");
  const [enterToSend, setEnterToSend] = useState(true);
  const [showSources, setShowSources] = useState(true);

  return (
    <SettingsCard
      title="Preferenser"
      description="Anpassa hur Folke fungerar för dig."
      footer={<Button onClick={savePrototype}>Spara</Button>}
    >
      <div className="flex flex-col gap-6">
        <Field label="Standardassistent" htmlFor={`${id}-assistant`} hint="Förvald när du startar en ny chatt.">
          <Select value={defaultAssistant} onValueChange={setDefaultAssistant}>
            <SelectTrigger id={`${id}-assistant`} className="h-9 w-full sm:w-72 data-[size=default]:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <AssistantAvatar assistant={a} size="xs" />
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <ToggleRow
          id={`${id}-enter`}
          label="Skicka med Enter"
          description="Använd Skift + Enter för ny rad."
          checked={enterToSend}
          onCheckedChange={setEnterToSend}
        />
        <ToggleRow
          id={`${id}-sources`}
          label="Visa källhänvisningar"
          description="Visa vilka dokument ett svar bygger på."
          checked={showSources}
          onCheckedChange={setShowSources}
        />
      </div>
    </SettingsCard>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
