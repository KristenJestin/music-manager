/**
 * "This video will not download. Here is the file." — the Console's half of `services/adopt.ts`.
 *
 * It lives on the job detail page, on the row of a track that failed to download, because that
 * is where the need is felt: the owner is looking at `YTDLP_AGE` or `YTDLP_UNAVAILABLE` on one
 * line of a fourteen-track album and has the file on their disk.
 *
 * Two ways in, and the dialog says which one to use rather than making it a preference:
 *
 *  - **Upload a file** — the browser reads it and sends the bytes. The right answer when the
 *    file is on the machine you are sitting at, which for a Console user it almost always is.
 *  - **A path on the server** — no bytes move. The right answer when the file is already on the
 *    machine running Music Manager: an existing library being taken over, a NAS mount. The
 *    server will refuse a path outside its `adoptSourceRoots` allow-list, and the dialog says
 *    so before you try rather than after.
 */
import { useState } from "react";
import { FileUp, FolderOpen, Upload } from "lucide-react";
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

export type AdoptFileChoice =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "upload"; readonly filename: string; readonly content: string };

export interface AdoptFileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The track's title, so the dialog names what it is about to change. */
  readonly trackTitle: string;
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
  busy = false,
  onAdopt,
}: AdoptFileDialogProps) {
  const [mode, setMode] = useState<"upload" | "path">("upload");
  const [path, setPath] = useState("");
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
            Give <b className="text-fg-1">{trackTitle}</b> a file you already have, instead of
            downloading it. The track carries on from fingerprinting, and its tags will say the file
            was adopted rather than downloaded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5" role="radiogroup" aria-label="Where the file is">
          <Button
            size="sm"
            variant={mode === "upload" ? "default" : "outline"}
            role="radio"
            aria-checked={mode === "upload"}
            data-testid="adopt-mode-upload"
            onClick={() => {
              setMode("upload");
              setProblem(null);
            }}
          >
            <Upload className="size-3.5" aria-hidden="true" /> Upload a file
          </Button>
          <Button
            size="sm"
            variant={mode === "path" ? "default" : "outline"}
            role="radio"
            aria-checked={mode === "path"}
            data-testid="adopt-mode-path"
            onClick={() => {
              setMode("path");
              setProblem(null);
            }}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" /> A path on the server
          </Button>
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
        ) : (
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
            {busy ? "Adopting…" : "Adopt this file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
