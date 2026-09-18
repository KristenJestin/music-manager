/**
 * "This video will not download. Here is the file." — the Console's half of `services/adopt.ts`.
 *
 * It lives on the job detail page, on the row of a track that failed to download, because that
 * is where the need is felt: the owner is looking at `YTDLP_AGE` or `YTDLP_UNAVAILABLE` on one
 * line of a fourteen-track album and has the file on their disk.
 *
 * Three ways in, and the dialog says which one to use rather than making it a preference:
 *
 *  - **Upload a file** — the browser reads it and sends the bytes. The right answer when the
 *    file is on the machine you are sitting at, which for a Console user it almost always is.
 *  - **A path on the server** — no bytes move. The right answer when the file is already on the
 *    machine running Music Manager: an existing library being taken over, a NAS mount. The
 *    server will refuse a path outside its `adoptSourceRoots` allow-list, and the dialog says
 *    so before you try rather than after.
 *  - **Another address** — the right answer when there is no file anywhere, which is the
 *    ordinary case for a deleted or age-checked video: the same song is still on YouTube under
 *    a different upload, and the server downloads *that* one. It is the only one of the three
 *    that takes time and that can come back "a download is already running", so the button
 *    says "Download it" rather than "Adopt this file" — pressing it starts a fetch, and a
 *    label that hid that would be a lie about what the click costs.
 */
import { useState } from "react";
import { FileUp } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";

/** Mirrors `MAX_ADOPT_UPLOAD_BYTES` in `server/services/adopt.ts`. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Mirrors `TAGGABLE_SUFFIXES` in `server/paths.ts` — the containers the tagger can write to. */
const ACCEPTED = ".opus,.ogg,.oga,.flac,.mp3,.mp2,.m4a,.mp4,.m4b,.aac";

/**
 * Mirrors `isAdoptableUrl` in `server/services/adopt.ts`.
 *
 * Mirrored rather than imported, like the two constants above and for the same reason: this
 * file reaches the browser, and `client-boundary.guard.test.ts` lets it value-import
 * `#/server/**` only from a module it can prove is pure — which `adopt.ts`, with Drizzle and
 * the toolbox client behind it, emphatically is not. The copy is a *courtesy*, not the guard:
 * the server validates the same string again with the real schema, so a stale mirror here
 * costs a round trip and never a bad download.
 */
const ADOPTABLE_URL = /^(?:https?:\/\/|fixture:\/\/)/i;

/**
 * The three ways in, in the order they are offered, and what each position is called.
 *
 * A table rather than three hand-written buttons: the strip is drawn once, the state's type comes
 * from it (`Mode` below), and a fourth way in would be one line here instead of another copy of
 * the same six props. The labels are the copy and not decoration — the file's header says why
 * they name the source rather than the mechanism.
 */
const MODES = [
  { value: "upload", label: "Upload a file" },
  { value: "path", label: "A path on the server" },
  { value: "url", label: "Another address" },
] as const;

/** Which of the three is chosen. Derived, so the table above cannot drift from the state. */
type Mode = (typeof MODES)[number]["value"];

export type AdoptFileChoice =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "upload"; readonly filename: string; readonly content: string }
  | { readonly kind: "url"; readonly url: string };

export interface AdoptFileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The track's title, so the dialog names what it is about to change. */
  readonly trackTitle: string;
  /**
   * One sentence under the title, when the caller's situation is not the default one.
   *
   * The job page's track failed to download; the album page's was never published at all, so
   * there is no video behind it and nothing to retry. Those are different sentences, and rather
   * than the dialog guessing which it is in, the caller that knows says so.
   */
  readonly description?: string;
  readonly busy?: boolean;
  readonly onAdopt: (choice: AdoptFileChoice) => void;
}

/**
 * `Uint8Array` → base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a forty-megabyte array is a forty-million-argument call
 * and throws `RangeError: Maximum call stack size exceeded`, which would read as "the Console
 * is broken" for exactly the large file somebody most wants to adopt.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function AdoptFileDialog({
  open,
  onOpenChange,
  trackTitle,
  description,
  busy = false,
  onAdopt,
}: AdoptFileDialogProps) {
  const [mode, setMode] = useState<Mode>("upload");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    setProblem(null);
    if (mode === "path") {
      if (path.trim() === "") {
        setProblem("Give the full path to the file, as the server sees it.");
        return;
      }
      onAdopt({ kind: "path", path: path.trim() });
      return;
    }
    if (mode === "url") {
      const address = url.trim();
      if (address === "") {
        setProblem("Paste the address of another upload of the same song.");
        return;
      }
      if (!ADOPTABLE_URL.test(address)) {
        setProblem("That is not a web address. It has to start with http:// or https://.");
        return;
      }
      onAdopt({ kind: "url", url: address });
      return;
    }
    if (file === null) {
      setProblem("Choose a file first.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem(
        `That file is ${String(Math.round(file.size / 1024 / 1024))} MB; the limit is 64 MB. ` +
          "Put it on the server and use “A path on the server”.",
      );
      return;
    }
    void file.arrayBuffer().then(
      (buffer) => {
        onAdopt({
          kind: "upload",
          filename: file.name,
          content: toBase64(new Uint8Array(buffer)),
        });
      },
      () => {
        setProblem("That file could not be read.");
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="adopt-file-dialog" className="max-w-form">
        <DialogHeader>
          <DialogTitle>Adopt a file for this track</DialogTitle>
          <DialogDescription>
            {description ?? (
              <>
                Give <b className="text-fg-1">{trackTitle}</b> audio from somewhere other than its
                own video — a file you already have, or another address to download from. The track
                carries on from fingerprinting, and its tags will say where the audio really came
                from.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/*
          One line, three positions: a segmented control, the shape the Console already uses for
          "one of N" (`library/filter-chips.tsx`) — a single border, hairline dividers, and the
          position you are in lit in amber.

          It replaces a row of three `Button`s, and the reason is measured rather than aesthetic.
          A `Button` is `whitespace-nowrap shrink-0`, and with an icon each the three needed
          114 + 163 + 140px plus two gaps: about 430px in the 348px a `max-w-form` dialog gives its
          content. `DialogContent` is a grid whose single column is sized to its widest child's
          minimum, so that row widened the column and the description, the field and the footer
          were painted up to 65px outside the panel. Letting the row wrap cured the overflow but
          put "Another address" on a line of its own, which is what this replaces.
          Without the icons, at `text-xs` and at 6px of side padding — `filter-chips` uses 8px, but
          a preset's name is shorter than "A path on the server" — those same three labels come to
          ~284px in the browser that reported the bug (their widths were read off that screenshot).
          With the padding and the dividers the strip is ~322px of a 348px content box: one line,
          inside the dialog, 26px to spare. `min-w-0` and `overflow-x-auto` are the belt to those
          braces, exactly as in `filter-chips`: if a label ever grows again, the strip scrolls
          rather than pushing the dialog open.
        */}
        <div
          role="radiogroup"
          aria-label="Where the file is"
          className="flex min-w-0 shrink items-stretch overflow-x-auto rounded-lg border border-line-strong bg-surface-2"
        >
          {MODES.map((position) => (
            <button
              key={position.value}
              type="button"
              role="radio"
              aria-checked={mode === position.value}
              data-testid={`adopt-mode-${position.value}`}
              onClick={() => {
                setMode(position.value);
                setProblem(null);
              }}
              className={cn(
                "inline-flex h-7 grow shrink-0 items-center justify-center border-r border-line px-1.5 text-xs whitespace-nowrap last:border-r-0 focus-visible:z-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                mode === position.value
                  ? "bg-primary-soft text-primary"
                  : "text-fg-2 hover:bg-surface-3 hover:text-fg-1",
              )}
            >
              {position.label}
            </button>
          ))}
        </div>

        {mode === "upload" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="adopt-file-input">The audio file</Label>
            <input
              id="adopt-file-input"
              type="file"
              accept={ACCEPTED}
              data-testid="adopt-file-input"
              className="block w-full text-xs text-fg-2 file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-2.5 file:py-1 file:text-xs file:text-fg-1"
              onChange={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                setProblem(null);
              }}
            />
            <p className="text-2xs text-fg-2">
              Opus, Ogg, FLAC, MP3, M4A or AAC, 64 MB at most. A container the tagger cannot write
              to is refused before anything is copied.
            </p>
          </div>
        ) : mode === "path" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="adopt-path-input">Absolute path, on the server</Label>
            <Input
              id="adopt-path-input"
              data-testid="adopt-path-input"
              placeholder="D:\Musique\Daft Punk\Discovery\03 Digital Love.flac"
              value={path}
              onChange={(event) => {
                setPath(event.currentTarget.value);
                setProblem(null);
              }}
            />
            <p className="text-2xs text-fg-2">
              Only the library and the folders listed in <code>adoptSourceRoots</code> may be read
              from. Add yours in Settings first, or upload the file instead.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="adopt-url-input">Address to download from</Label>
            <Input
              id="adopt-url-input"
              data-testid="adopt-url-input"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(event) => {
                setUrl(event.currentTarget.value);
                setProblem(null);
              }}
            />
            <p className="text-2xs text-fg-2">
              Another upload of the same song. The audio comes from this address; the track keeps
              its own video as its source, and the tags will say so. There is one download slot, so
              this waits its turn if something else is downloading.
            </p>
          </div>
        )}

        {problem === null ? null : (
          <div
            data-testid="adopt-file-problem"
            className="rounded-md border border-line bg-danger-soft px-3 py-2 text-xs text-danger"
          >
            {problem}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            nativeButton={false}
            render={<DialogClose />}
            data-testid="adopt-file-cancel"
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit} data-testid="adopt-file-confirm">
            <FileUp className="size-3.5" aria-hidden="true" />
            {mode === "url"
              ? busy
                ? "Downloading…"
                : "Download it"
              : busy
                ? "Adopting…"
                : "Adopt this file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
