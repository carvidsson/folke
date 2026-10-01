"use client";

import { FileUp, ShieldAlert, X } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Assistant, KnowledgeCollection } from "@/lib/domain/types";
import { formatBytes } from "@/lib/format";
import { uploadToSignedUrl } from "@/lib/supabase/browser-storage";
import { cn } from "@/lib/utils";
import { createDocumentUploadAction, processDocumentAction } from "@/server/documents/actions";

import type { GroupOption } from "./knowledge-view";

const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv";
const MAX_BYTES = 50 * 1024 * 1024;

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

export function UploadDialog({
  open,
  onOpenChange,
  collections,
  assistants,
  ownerGroups,
  shareGroups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: KnowledgeCollection[];
  assistants: Assistant[];
  /** Groups the user may upload on behalf of (area of responsibility). */
  ownerGroups: GroupOption[];
  /** Groups the user may additionally share with. */
  shareGroups: GroupOption[];
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [ownerGroupId, setOwnerGroupId] = useState(ownerGroups.length === 1 ? ownerGroups[0].id : "");
  const [shareGroupIds, setShareGroupIds] = useState<string[]>([]);
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState(today);
  const [validUntil, setValidUntil] = useState("");
  const [indefinite, setIndefinite] = useState(true);
  const [tags, setTags] = useState("");
  const [attested, setAttested] = useState(false);
  const [step, setStep] = useState<"form" | "uploading" | "processing">("form");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const valid =
    file !== null &&
    title.trim() !== "" &&
    collectionId !== "" &&
    ownerGroupId !== "" &&
    assistantIds.length > 0 &&
    validFrom !== "" &&
    (indefinite || (validUntil !== "" && validUntil >= validFrom)) &&
    attested;

  function reset() {
    setFile(null);
    setTitle("");
    setCollectionId("");
    setOwnerGroupId(ownerGroups.length === 1 ? ownerGroups[0].id : "");
    setShareGroupIds([]);
    setAssistantIds([]);
    setValidFrom(today());
    setValidUntil("");
    setIndefinite(true);
    setTags("");
    setAttested(false);
    setStep("form");
    setError(null);
  }

  function close() {
    if (step !== "form") return; // don't abandon an upload midway
    onOpenChange(false);
    reset();
  }

  function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setError("Filen är större än 50 MB.");
      return;
    }
    setError(null);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
  }

  function submit() {
    if (!valid || !file) return;
    setError(null);
    startTransition(async () => {
      setStep("uploading");
      const created = await createDocumentUploadAction({
        fileName: file.name,
        sizeBytes: file.size,
        title: title.trim(),
        collectionId,
        ownerGroupId,
        shareGroupIds,
        assistantIds,
        validFrom,
        validUntil: indefinite ? null : validUntil,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        internalOnly: true,
      });
      if (!created.ok) {
        setError(created.error);
        setStep("form");
        return;
      }
      try {
        await uploadToSignedUrl("documents", created.path, created.token, file);
      } catch {
        setError("Filen kunde inte laddas upp. Försök igen.");
        setStep("form");
        return;
      }
      setStep("processing");
      const processed = await processDocumentAction(created.documentId);
      if (processed.ok) {
        toast.success(processed.message ?? "Dokumentet har laddats upp.");
      } else {
        toast.error(processed.error);
      }
      onOpenChange(false);
      reset();
    });
  }

  const busy = step !== "form";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="text-lg">Ladda upp dokument</DialogTitle>
          <DialogDescription>
            Dokumentet delas med den ansvariga gruppen och granskas innan assistenterna kan använda det.
          </DialogDescription>
        </DialogHeader>

        <form
          id={`${id}-form`}
          className="flex flex-col gap-6 px-6 pb-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/6 px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}

          {file ? (
            <div className="flex items-center gap-3 rounded-lg border bg-surface p-3">
              <span className="inline-flex size-9 items-center justify-center rounded-md border bg-background text-muted-foreground">
                <FileUp className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setFile(null)} disabled={busy} aria-label="Ta bort fil">
                <X />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files[0]);
              }}
              className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-navy-200 px-6 py-8 text-center transition-colors hover:border-navy-300 hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <FileUp className="size-5" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-medium">Dra hit en fil eller klicka för att välja</span>
              <span className="text-caption">PDF, Word, Excel, PowerPoint, text, Markdown eller CSV · max 50 MB</span>
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-title`}>Titel</Label>
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="h-9" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-collection`}>Samling</Label>
              <Select value={collectionId} onValueChange={setCollectionId}>
                <SelectTrigger id={`${id}-collection`} className="h-9 w-full data-[size=default]:h-9">
                  <SelectValue placeholder="Välj samling" />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-owner`}>Ansvarig grupp</Label>
              <Select value={ownerGroupId} onValueChange={setOwnerGroupId}>
                <SelectTrigger id={`${id}-owner`} className="h-9 w-full data-[size=default]:h-9">
                  <SelectValue placeholder="Välj grupp" />
                </SelectTrigger>
                <SelectContent>
                  {ownerGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption">Gruppens ansvariga granskar dokumentet.</p>
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-tags`}>Taggar</Label>
              <Input id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="t.ex. garanti, elbil" className="h-9" />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Assistenter som får använda dokumentet</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {assistants.map((a) => (
                <label
                  key={a.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-surface",
                    assistantIds.includes(a.id) && "border-navy-300 bg-surface",
                  )}
                >
                  <Checkbox checked={assistantIds.includes(a.id)} onCheckedChange={() => setAssistantIds((l) => toggle(l, a.id))} />
                  <AssistantAvatar assistant={a} size="xs" />
                  {a.name}
                </label>
              ))}
            </div>
          </fieldset>

          {shareGroups.filter((g) => g.id !== ownerGroupId).length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Dela även med</legend>
              <p className="text-caption mb-2">Dokumentet delas alltid med den ansvariga gruppen.</p>
              <div className="flex flex-wrap gap-2">
                {shareGroups
                  .filter((g) => g.id !== ownerGroupId)
                  .map((g) => (
                    <label key={g.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                      <Checkbox checked={shareGroupIds.includes(g.id)} onCheckedChange={() => setShareGroupIds((l) => toggle(l, g.id))} />
                      {g.name}
                    </label>
                  ))}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Giltighetsperiod</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-from`} className="font-normal text-muted-foreground">
                  Giltig från
                </Label>
                <Input id={`${id}-from`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="h-9" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-until`} className="font-normal text-muted-foreground">
                  Giltig till
                </Label>
                <Input
                  id={`${id}-until`}
                  type="date"
                  value={validUntil}
                  min={validFrom || undefined}
                  disabled={indefinite}
                  onChange={(e) => setValidUntil(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <Checkbox checked={indefinite} onCheckedChange={(c) => setIndefinite(c === true)} />
              Gäller tillsvidare
            </label>
          </fieldset>

          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-sm",
              attested ? "border-navy-300 bg-surface" : "border-warning/40 bg-warning-subtle/60",
            )}
          >
            <Checkbox checked={attested} onCheckedChange={(c) => setAttested(c === true)} className="mt-0.5" />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <ShieldAlert className="size-4 text-warning" />
                Internt dokument utan kunduppgifter
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                Jag intygar att dokumentet är internt och inte innehåller personuppgifter om kunder.
                Det är ett krav under piloten.
              </span>
            </span>
          </label>
        </form>

        <DialogFooter className="sticky bottom-0 m-0 items-center border-t bg-background px-6 py-4">
          {busy && (
            <p className="text-caption mr-auto" role="status">
              {step === "uploading" ? "Laddar upp…" : "Läser in texten…"}
            </p>
          )}
          <Button variant="outline" onClick={close} disabled={busy}>
            Avbryt
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={!valid || busy}>
            Ladda upp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
