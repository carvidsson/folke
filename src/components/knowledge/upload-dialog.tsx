"use client";

import { FileUp, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { AssistantAvatar } from "@/components/common/assistant-avatar";
import { PrototypeNotice } from "@/components/common/prototype-notice";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Assistant, DocumentVisibility, KnowledgeCollection } from "@/lib/domain/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { GroupOption } from "./knowledge-view";

const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt";

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Upload form prototype. Captures the metadata a real upload will need
 * (collection, assistants, validity, sharing) but sends nothing.
 */
export function UploadDialog({
  open,
  onOpenChange,
  collections,
  assistants,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: KnowledgeCollection[];
  assistants: Assistant[];
  groups: GroupOption[];
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [indefinite, setIndefinite] = useState(true);
  const [visibility, setVisibility] = useState<DocumentVisibility["type"]>("organisation");
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const valid =
    file !== null &&
    title.trim() !== "" &&
    collectionId !== "" &&
    assistantIds.length > 0 &&
    validFrom !== "" &&
    (indefinite || validUntil >= validFrom) &&
    (visibility !== "groups" || groupIds.length > 0);

  function reset() {
    setFile(null);
    setTitle("");
    setCollectionId("");
    setAssistantIds([]);
    setValidFrom("");
    setValidUntil("");
    setIndefinite(true);
    setVisibility("organisation");
    setGroupIds([]);
  }

  function pickFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="text-lg">Ladda upp dokument</DialogTitle>
          <DialogDescription>
            Ange vilka assistenter som får använda dokumentet och vem som får se det.
          </DialogDescription>
        </DialogHeader>

        <form
          id={`${id}-form`}
          className="flex flex-col gap-6 px-6 pb-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            toast("Prototyp: dokumentet har inte laddats upp eller sparats.");
            onOpenChange(false);
            reset();
          }}
        >
          <PrototypeNotice>
            Filen läses inte in och skickas inte någonstans. Formuläret visar vilka uppgifter
            som kommer att krävas.
          </PrototypeNotice>

          {/* File */}
          {file ? (
            <div className="flex items-center gap-3 rounded-lg border bg-surface p-3">
              <span className="inline-flex size-9 items-center justify-center rounded-md border bg-background text-muted-foreground">
                <FileUp className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setFile(null)} aria-label="Ta bort fil">
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
              <span className="text-caption">PDF, Word, Excel, PowerPoint eller text · max 50 MB</span>
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
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} className="h-9" />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
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
                  <Checkbox
                    checked={assistantIds.includes(a.id)}
                    onCheckedChange={() => setAssistantIds((l) => toggle(l, a.id))}
                  />
                  <AssistantAvatar assistant={a} size="xs" />
                  {a.name}
                </label>
              ))}
            </div>
          </fieldset>

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

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Delning</legend>
            <RadioGroup
              value={visibility}
              onValueChange={(v) => setVisibility(v as DocumentVisibility["type"])}
              className="gap-2"
            >
              {(
                [
                  ["organisation", "Alla med assistentåtkomst", "Alla som får använda de valda assistenterna."],
                  ["groups", "Utvalda grupper", "Endast medlemmar i de grupper du väljer."],
                  ["restricted", "Begränsad", "Endast du och assistentansvariga."],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-surface",
                    visibility === value && "border-navy-300 bg-surface",
                  )}
                >
                  <RadioGroupItem value={value} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {visibility === "groups" && (
              <div className="mt-3 flex flex-wrap gap-2 pl-1">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                    <Checkbox
                      checked={groupIds.includes(g.id)}
                      onCheckedChange={() => setGroupIds((l) => toggle(l, g.id))}
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </form>

        <DialogFooter className="sticky bottom-0 m-0 border-t bg-background px-6 py-4">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
          >
            Avbryt
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={!valid}>
            Ladda upp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
