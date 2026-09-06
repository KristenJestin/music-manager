/**
 * The cover picker (`docs/03-metadonnees.md` §4, cover order).
 *
 * Candidates come from the three places §4 names, in the order it prefers them: the Cover Art
 * Archive's front, its back, then the YouTube thumbnail cropped square. They are listed, not
 * fetched — nothing leaves the machine until a choice is made, and then exactly one image is
 * prepared through the toolbox's `/artwork/prepare`.
 *
 * Choosing writes the choice into the **document**, locked, and `cover.jpg` next to the audio.
 * The embedded picture follows on the next re-tag, which the album page offers immediately
 * afterwards; it is a separate step because embedding rewrites every file of the album and
 * that is not something a cover click should do behind your back.
 */
import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import type { CoverOption } from "#/server/services/library.ts";

export interface CoverPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly options: readonly CoverOption[];
  readonly busy?: boolean;
  readonly onChoose: (url: string) => void;
}

const SOURCE_LABEL: Record<CoverOption["source"], string> = {
  coverartarchive: "Cover Art Archive",
  youtube: "YouTube",
  current: "In use",
};

export function CoverPicker({
  open,
  onOpenChange,
  options,
  busy = false,
  onChoose,
}: CoverPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = selected ?? options.find((option) => option.source !== "current")?.url ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cover-picker" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a cover</DialogTitle>
          <DialogDescription>
            The Cover Art Archive first, the YouTube thumbnail as the fallback, the order of docs
            §4. Choosing writes <code className="font-mono">cover.jpg</code> and records the choice
            in the document; the embedded picture follows on the next re-tag.
          </DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-2">
            No candidate cover. The Cover Art Archive has nothing cached for this release and the
            source kept no thumbnail.
          </p>
        ) : (
          <div className="grid max-h-96 grid-cols-3 gap-3 overflow-y-auto py-1">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`cover-option-${option.source}`}
                aria-pressed={option.url === chosen}
                onClick={() => {
                  setSelected(option.url);
                }}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border p-1.5 text-left",
                  option.url === chosen
                    ? "border-primary bg-primary-soft"
                    : "border-line bg-surface-1 hover:border-line-strong",
                )}
              >
                <img
                  src={option.url}
                  alt={option.label}
                  loading="lazy"
                  className="aspect-square w-full rounded-sm bg-surface-3 object-cover"
                />
                <span className="flex items-center justify-between gap-1">
                  <ToneBadge tone={option.source === "current" ? "primary" : "muted"}>
                    {SOURCE_LABEL[option.source]}
                  </ToneBadge>
                  <span className="text-3xs text-fg-3">{option.kind}</span>
                </span>
                <span className="truncate text-3xs text-fg-3" title={option.label}>
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || chosen === null}
            data-testid="cover-picker-confirm"
            onClick={() => {
              if (chosen !== null) onChoose(chosen);
            }}
          >
            <ImageIcon className="size-4" aria-hidden="true" />
            {busy ? "Preparing…" : "Use this cover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
