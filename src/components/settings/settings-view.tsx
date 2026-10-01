"use client";

import { KeyRound, LogOut, MonitorSmartphone, Smartphone } from "lucide-react";
import { useId, useTransition } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/common/status-badge";
import { UserAvatar } from "@/components/common/user-avatar";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatTime } from "@/lib/format";
import { sendPasswordChangeLinkAction, updateProfileAction } from "@/server/account/actions";

interface ProfileUser {
  name: string;
  email: string;
  title: string;
  department: string;
  location: string;
  roleLabel: string;
}

export interface SecurityInfo {
  mfaEnrolledAt: string | null;
  sessionStartedAt: string;
  sessionExpiresAt: string;
}

export function SettingsView({ user, security }: { user: ProfileUser; security: SecurityInfo }) {
  return (
    <PageContainer width="narrow">
      <PageHeader title="Inställningar" description="Din profil och dina säkerhetsinställningar." />

      <Tabs defaultValue="profile" className="mt-8 gap-6">
        <TabsList variant="line" className="w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0.5">
          <TabsTrigger value="profile">Profil</TabsTrigger>
          <TabsTrigger value="security">Säkerhet</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Profile user={user} />
        </TabsContent>
        <TabsContent value="security">
          <Security info={security} />
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
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await updateProfileAction({
            fullName: String(form.get("fullName") ?? ""),
            title: String(form.get("title") ?? ""),
            department: String(form.get("department") ?? ""),
            location: String(form.get("location") ?? ""),
          });
          if (result.ok) toast.success(result.message);
          else toast.error(result.error);
        });
      }}
    >
      <SettingsCard
        title="Profil"
        description="Namn och titel visas för kollegor, till exempel i grupper och dokument."
        footer={
          <Button type="submit" disabled={pending}>
            Spara
          </Button>
        }
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
            <Input id={`${id}-name`} name="fullName" defaultValue={user.name} required minLength={2} maxLength={120} className="h-9" />
          </Field>
          <Field label="E-postadress" htmlFor={`${id}-email`} hint="Ändras av en systemadministratör.">
            <Input id={`${id}-email`} defaultValue={user.email} disabled className="h-9" />
          </Field>
          <Field label="Titel" htmlFor={`${id}-title`}>
            <Input id={`${id}-title`} name="title" defaultValue={user.title} maxLength={120} className="h-9" />
          </Field>
          <Field label="Avdelning" htmlFor={`${id}-department`}>
            <Input id={`${id}-department`} name="department" defaultValue={user.department} maxLength={120} className="h-9" />
          </Field>
          <Field label="Anläggning" htmlFor={`${id}-location`}>
            <Input id={`${id}-location`} name="location" defaultValue={user.location} maxLength={120} className="h-9" />
          </Field>
        </div>
      </SettingsCard>
    </form>
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
  description: React.ReactNode;
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

function Security({ info }: { info: SecurityInfo }) {
  const [pending, startTransition] = useTransition();
  const stamp = (iso: string) => `${formatDate(iso)} ${formatTime(iso)}`;

  return (
    <SettingsCard title="Inloggning och säkerhet">
      <div className="divide-y">
        <SecurityRow
          icon={Smartphone}
          title="Tvåstegsverifiering (TOTP)"
          description={
            info.mfaEnrolledAt
              ? `Aktiverad ${formatDate(info.mfaEnrolledAt)}. Obligatorisk för alla användare. Kontakta en systemadministratör om du byter telefon.`
              : "Obligatorisk för alla användare."
          }
          action={<StatusBadge tone="success">Aktiv</StatusBadge>}
        />
        <SecurityRow
          icon={KeyRound}
          title="Lösenord"
          description="Du får en länk via e-post för att välja ett nytt lösenord."
          action={
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await sendPasswordChangeLinkAction();
                  if (result.ok) toast.success(result.message);
                  else toast.error(result.error);
                })
              }
            >
              Byt lösenord
            </Button>
          }
        />
        <SecurityRow
          icon={MonitorSmartphone}
          title="Aktuell session"
          description={`Inloggad ${stamp(info.sessionStartedAt)}. Du loggas ut automatiskt senast ${stamp(info.sessionExpiresAt)}.`}
          action={
            <form action="/auth/signout?scope=global" method="post">
              <Button type="submit" variant="outline">
                <LogOut />
                Logga ut överallt
              </Button>
            </form>
          }
        />
      </div>
    </SettingsCard>
  );
}
