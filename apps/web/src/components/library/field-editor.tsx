/**
 * Editing one document field by hand — the Console side of `services/overrides.ts`.
 *
 * Shared because it is used twice: the track page's document table and the album page's
 * album-scope block. They are the same gesture on two scopes, and they must stay the same
 * gesture — an editor that behaved differently on an album would be a second set of rules for
 * somebody to learn.
 *
 * What it is, deliberately: a cell, not a form. Click the value (or the pencil) and it becomes
 * an input; `Enter` saves, `Escape` abandons, blur abandons too. A multi-valued field gets a
 * textarea, one value per line, because that is exactly what a Vorbis comment is — a repeated
 * key, not a string with semicolons in it, and offering a single line would teach people to
 * type a separator we then have to guess at.
 *
 * The lock is a *separate* button from the value on purpose. Typing a value implies locking it
 * — nobody types a value in order to have it overwritten — but pinning what MusicBrainz already
 * says is a different intention with a different button, and releasing a field is a third.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Lock, LockOpen, Pencil, X } from "lucide-react";
import { cn } from "cn";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import type { RelocatePlan } from "#/server/services/relocate.ts";

/** The two sources a person is behind. `user` is what P11 migrated out of v1. */
const BY_HAND = new Set(["console", "user"]);

export function isByHand(source: string | null | undefined): boolean {
  return source !== null && source !== undefined && BY_HAND.has(source);
}

/**
 * The provenance of one field, in one badge plus the source name.
 *
 * The source alone stopped being the whole answer the day a value could be typed here: `album:
 * musicbrainz` and `album: console` are the difference between "this is what the archive says"
 * and "somebody decided this", and the second is the one you go looking for when an album is
 * wrong.
 */
export function FieldSource({
  source,
  locked,
  note,
}: {
  readonly source: string;
  readonly locked: boolean;
  readonly note?: string | undefined;
}) {
  return (
    <span className="inline-flex items-center gap-1" title={note}>
      {isByHand(source) ? (
        <ToneBadge tone="primary" data-testid="field-source-badge">
          {source}
        </ToneBadge>
      ) : (
        <span className="text-2xs text-fg-2">{source}</span>
      )}
      {locked ? (
        <span className="inline-flex items-center gap-0.5 text-2xs text-primary">
          <Lock className="size-3" aria-hidden="true" />
          locked
        </span>
      ) : null}
    </span>
  );
}

export interface FieldEditorProps {
  /** The document field name — `album`, `tracknumber`. The tag map's key, not the Vorbis one. */
  readonly field: string;
  /** `ALBUM`, `TRACKNUMBER` — what the row is labelled with, used in the accessible names. */
  readonly vorbis: string;
  /** The current value, already rendered as text. `null` when the field has none. */
  readonly value: string | null;
  /** One value per line in the editor, and a textarea rather than an input. */
  readonly multi?: boolean;
  readonly locked: boolean;
  /** `false` greys the whole cell: a picture or a lyrics blob has no text form. */
  readonly editable?: boolean;
  readonly busy?: boolean;
  /** Save the typed text. The service coerces it; this component never parses a value. */
  readonly onSave: (value: string) => void;
  /** Pin what the resolvers currently say, without changing it. */
  readonly onLock: () => void;
  /** Remove the field and let the resolvers own it again. */
  readonly onRelease: () => void;
}

export function FieldEditor({
  field,
  vorbis,
  value,
  multi = false,
  locked,
  editable = true,
  busy = false,
  onSave,
  onLock,
  onRelease,
}: FieldEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const open = (): void => {
    setDraft(multi ? (value ?? "").split(" · ").join("\n") : (value ?? ""));
    setEditing(true);
  };

  const commit = (): void => {
    setEditing(false);
    if (draft.trim() !== "") onSave(draft);
  };

  const keys = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      return;
    }
    // `Enter` saves on a single line; in a textarea it is a newline, so `Ctrl`/`Cmd` saves.
    if (event.key === "Enter" && (!multi || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };

  if (editing) {
    return (
      <div className="flex items-start gap-1" data-testid={`field-editing-${field}`}>
        {multi ? (
          <Textarea
            ref={inputRef as React.Ref<HTMLTextAreaElement>}
            aria-label={`${vorbis} — one value per line`}
            data-testid={`field-input-${field}`}
            className="min-h-16 font-mono text-xs"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={keys}
          />
        ) : (
          <Input
            ref={inputRef as React.Ref<HTMLInputElement>}
            aria-label={vorbis}
            data-testid={`field-input-${field}`}
            className="h-7 font-mono text-xs"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={keys}
          />
        )}
        <IconButton
          label={`Save ${vorbis}`}
          testId={`field-save-${field}`}
          disabled={busy}
          onClick={commit}
        >
          <Check className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Cancel editing ${vorbis}`}
          onClick={() => {
            setEditing(false);
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1" data-testid={`field-cell-${field}`}>
      <button
        type="button"
        disabled={!editable || busy}
        aria-label={`Edit ${vorbis}`}
        data-testid={`field-edit-${field}`}
        onClick={open}
        className={cn(
          "min-w-0 grow truncate rounded-sm px-1 py-0.5 text-left",
          editable ? "hover:bg-surface-3" : "cursor-default",
          locked ? "text-primary" : "text-fg-1",
        )}
        title={value ?? "not set"}
      >
        {value ?? <span className="text-fg-3">not set</span>}
      </button>
      {editable ? (
        <>
          <IconButton
            label={`Edit ${vorbis}`}
            onClick={open}
            disabled={busy}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </IconButton>
          {locked ? (
            <IconButton
              label={`Unlock ${vorbis} and let the sources own it again`}
              testId={`field-unlock-${field}`}
              disabled={busy}
              onClick={onRelease}
            >
              <LockOpen className="size-3.5 text-primary" aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton
              label={`Lock ${vorbis} at its current value`}
              testId={`field-lock-${field}`}
              disabled={busy || value === null}
              onClick={onLock}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Lock className="size-3.5" aria-hidden="true" />
            </IconButton>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * "You changed a name the path template uses. Move the files too?"
 *
 * An override never moves a file by itself, and this dialog is why: **Navidrome identifies a
 * file by its path**, so renaming one loses that track's play count and its favourites. The
 * plan is shown first — the same `planRelocate` the Quality page uses — and the move is a
 * second, deliberate press. Closing it is a perfectly good answer: the tags are already right,
 * only the filename is stale.
 */
export function RelocateOffer({
  plan,
  busy,
  onConfirm,
  onOpenChange,
}: {
  readonly plan: RelocatePlan | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const moves = plan?.moves ?? [];
  return (
    <ConfirmDialog
      open={plan !== null && moves.length > 0}
      onOpenChange={onOpenChange}
      testId="relocate-offer"
      destructive={false}
      title={`Move ${String(moves.length)} file(s) to match the new value?`}
      description={
        <>
          The tags are already queued for a re-tag; that never renames anything. The path template
          says these files now belong elsewhere. <strong>Navidrome keys on the path</strong>, so
          moving them loses those tracks&apos; play counts and favourites.
        </>
      }
      consequence={
        <ul className="space-y-0.5 font-mono text-2xs">
          {moves.slice(0, 8).map((move) => (
            <li key={move.from} className="truncate">
              {move.from} → {move.to}
            </li>
          ))}
          {moves.length > 8 ? <li className="text-fg-3">…and {moves.length - 8} more</li> : null}
        </ul>
      }
      confirmLabel="Move the files"
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}

function IconButton({
  label,
  testId,
  onClick,
  disabled = false,
  className,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-2",
        "hover:bg-surface-3 hover:text-fg-1 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}
