/**
 * Adopt a local file as one track's source — the door `fileReady` has always had and nothing
 * could knock on.
 *
 * `download` already reuses a file sitting at the work path: it re-reads the filesystem rather
 * than trusting its own row, so a track whose file is there is not fetched again. Until now
 * nothing put one there on purpose. This module is that, and it exists for three cases the
 * owner actually has:
 *
 *  - **a video that has been deleted.** The listing still names the track, MusicBrainz still
 *    knows the recording, and the only thing missing is the audio — which the owner has, from
 *    a rip or from a backup.
 *  - **a video behind an age check** that no cookie jar gets past today.
 *  - **taking over an existing library**, track by track. The files are already on the
 *    machine; the whole point is that they are not fetched again.
 *
 * ## How the bytes arrive
 *
 * Three ways, one schema, one code path (`AdoptSource`):
 *
 *  - **a path on this server** (`{ kind: "path" }`) — the honest answer to "take over my
 *    library", because the files are already here and copying two hundred of them through an
 *    HTTP body to a process running on the same disk is ceremony, not safety;
 *  - **an upload** (`{ kind: "upload" }`) — the honest answer for the Console and for anyone
 *    who does not have a shell on the machine;
 *  - **a replacement address** (`{ kind: "url" }`) — the honest answer when the owner has no
 *    file at all, which is the ordinary case for a dead video: the same song is almost always
 *    still on YouTube under another upload. The bytes are fetched from *that* address into
 *    the same work path, and the original URL stays the track's declared provenance.
 *
 * The third is a member of the union rather than a second service, on purpose. `path` and
 * `upload` already reach five surfaces — service, `/api/v1`, MCP, `mm`, the Console dialog —
 * and everything after "the bytes are at the work path" is identical for all three: the
 * container check, ffprobe, the row, the provenance record, the re-open, the queue. A second
 * pipeline would have to re-derive each of those, and would drift from this one.
 *
 * **The replacement download spends the single download slot** (`CLAUDE.md` § One
 * orchestrator), which the other two kinds never do. It is `POST /download` on the toolbox
 * like any other fetch, so a `409 LOCKED` is possible; it is surfaced as itself rather than
 * waited out, because this call is interactive — a dialog, a CLI invocation, an MCP tool —
 * and a caller told "the slot is busy, try again" is better served than a request held open
 * for minutes. See `downloadReplacement`.
 *
 * A path is validated against the library root and `adoptSourceRoots` before anything opens
 * it. **A path taken from an HTTP body and opened is a file-read primitive**: without the
 * check, `{"path": "/etc/shadow"}` copies that file into the library under a `.opus` name,
 * and `tag` then reads it back and reports its contents. `resolveSourcePath` is the check, and
 * the allow-list is empty by default, so the answer to a path outside the library is `403
 * ADOPT_PATH_REFUSED` until an operator names a folder in Settings.
 *
 * ## Where it lands
 *
 * `<library>/.mm-work/<import>/<trackId><ext>` — exactly where `download` would have put it
 * and exactly what `fileReady` probes for, so the rest of the pipeline cannot tell the
 * difference and does not have to. Inside the same bind mount, so `place` is still a rename
 * (`CLAUDE.md` § Code style). The copy goes to a `.part` sibling and is renamed into position,
 * because `fileReady` believes any non-empty file at that path and a half-written one would be
 * exactly as convincing as a whole one.
 *
 * ## What happens next
 *
 * The track resumes at the step **after** `download`: its state becomes `downloaded` and the
 * next per-track step (`fingerprint`, normally) goes on the `track.step` queue, which is
 * precisely what `download`'s `onTrackDownloaded` hook does for a file it fetched itself.
 * **No byte is downloaded for this track, ever** — `fileReady` sees the file and `download`
 * counts it as reused. An import that had already given up is a second case, handled at the
 * end of `adoptTrackFile`: it has to be re-opened first, or the per-track message would be
 * consumed and skipped by a `runTrackStep` that refuses terminal jobs.
 *
 * And the document tells the truth about it: `import_tracks.raw` gains an `mm_adoption` record
 * (`./adopt.record.ts`) which `services/documents.ts` reads on every build and rebuild, so
 * `COMMENT` says *Adopted local file "…" · not downloaded from youtu.be/…* instead of
 * *Source: youtu.be/…*. See `packages/domain/src/metadata/resolvers/youtube.ts`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { MMError } from "@mm/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, type Import, type ImportTrack } from "#/server/db/schema/index.ts";
import {
  containerPath,
  hostPath,
  suffixOf,
  TAGGABLE_SUFFIXES,
  taggable,
  toPosix,
  toRelative,
  workFolder,
  type PathMap,
} from "#/server/paths.ts";
import { cookieJar } from "#/server/services/cookies.ts";
import { emit } from "#/server/services/events.ts";
import { enqueue, enqueueTrack } from "#/server/services/queue.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { ADOPTION_KEY, type Adoption } from "#/server/services/adopt.record.ts";
import { requireImport, resolvePaths } from "#/server/services/jobs/context.ts";
import { isBefore, isTerminal } from "#/server/services/jobs/machine.ts";
import { rewindTo } from "#/server/services/jobs/index.ts";
import { nextStepOfTrack, syncLocalSteps } from "#/server/services/jobs/pipeline.ts";

/**
 * The largest upload this route accepts, before base64.
 *
 * Big enough for any single track anyone actually has — a 24-bit/96 kHz FLAC of a ten-minute
 * piece is under 300 MB but nothing in a music library looks like that; a lossless album
 * *track* is tens of megabytes. Small enough that the base64 of it is a string a JSON parser
 * can hold without the request becoming a way to exhaust the process. A bigger file is not
 * refused, it is redirected: put it on the server and adopt it by path.
 */
export const MAX_ADOPT_UPLOAD_BYTES = 64 * 1024 * 1024;

/** The containers this route accepts, sorted — for error messages and for the API document. */
export const ADOPTABLE_SUFFIXES: readonly string[] = [...TAGGABLE_SUFFIXES].sort();

/**
 * Where the bytes of an adopted track come from.
 *
 * Exported, and only ever extended additively: a caller that resolves something else — a
 * *library* track, for instance — to an import track and then delegates here must keep
 * working without knowing which member it is handing over.
 */
export type AdoptSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "upload"; readonly filename: string; readonly bytes: Uint8Array }
  | { readonly kind: "url"; readonly url: string };

/** How the bytes arrived, as the row, the API and the provenance record all spell it. */
export type AdoptVia = AdoptSource["kind"];

/**
 * The address schemes the toolbox may be asked to download from.
 *
 * `http(s)` is every real case; `fixture://` is how the offline end-to-end run and the
 * integration tests exercise this path with no network (`AGENTS.md` § Testing). Everything
 * else is refused **here**, before the string reaches `POST /download`.
 *
 * That closed list is the whole security argument for this kind, and it is a different
 * argument from the one `resolveSourcePath` makes. A path from an HTTP body is a file-read
 * primitive, and the answer to it is an operator-configured allow-list. An address is not —
 * but yt-dlp accepts far more than a web address, and `file:///etc/shadow` handed to it would
 * re-create exactly the primitive the allow-list exists to deny, through a field that merely
 * had to look like a URL. So the schemes are enumerated rather than filtered: a scheme nobody
 * listed is refused, which is the only form of this check that stays correct as yt-dlp grows
 * new protocols.
 */
const ADOPT_URL_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

/** The longest address worth entertaining. Past this it is not a URL, it is a payload. */
export const MAX_ADOPT_URL_LENGTH = 2048;

/** The sentence every surface says when it refuses an address, so all five say the same one. */
export const ADOPT_URL_MESSAGE =
  "A replacement address must be an `http://` or `https://` URL (or a `fixture://` one, in " +
  "fixtures mode). Any other scheme is refused.";

/**
 * Is this a replacement address we are willing to hand to the toolbox?
 *
 * The predicate rather than the schema, because `/api/v1` builds its own field with
 * `@hono/zod-openapi`'s `z` and the Console's dialog has no zod at all. One rule, three
 * spellings of the boundary that applies it — and `adoptTrackFile` applies it again itself,
 * because a service that trusts its callers to have validated is a service with one unchecked
 * caller away from the bug this guard exists for.
 */
export function isAdoptableUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed !== "" &&
    trimmed.length <= MAX_ADOPT_URL_LENGTH &&
    !trimmed.includes("\0") &&
    ADOPT_URL_SHAPE.test(trimmed)
  );
}

export const adoptUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ADOPT_URL_LENGTH, "That address is longer than any real one.")
  .refine(isAdoptableUrl, { message: ADOPT_URL_MESSAGE });

export interface AdoptOptions {
  readonly importId: string;
  readonly trackId: string;
  readonly source: AdoptSource;
  /** Who asked. `console`, `api`, `cli adopt`, `mcp` — the same vocabulary as `confirmedBy`. */
  readonly adoptedBy: string;
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  /**
   * Put the track back on the `track.step` queue when the file is in place.
   *
   * True everywhere except the tests, which run the steps themselves and would otherwise need
   * a worker to observe anything.
   */
  readonly queue?: boolean;
}

export interface AdoptResult {
  readonly importId: string;
  readonly trackId: string;
  /** Library-relative, forward slashes — the value written to `import_tracks.download_path`. */
  readonly path: string;
  readonly bytes: number;
  readonly container: string;
  readonly codec: string | null;
  readonly durationSeconds: number | null;
  readonly via: AdoptVia;
  /**
   * The address the bytes were downloaded from, for `via: "url"`. `null` for the other two.
   *
   * Reported separately from `originalName` because they answer different questions: the name
   * is what the file is called, this is where it came from, and on a replacement download the
   * second is the only one a person has any use for.
   */
  readonly downloadedFrom: string | null;
  readonly originalName: string;
  /** The step this track will run next, or `null` when there is nothing left for it. */
  readonly nextStep: "fingerprint" | "tag" | "place" | null;
  readonly queued: boolean;
  /**
   * True when the import had already given up — `failed`, `done` or `paused` — and was put
   * back on the line. See the comment at the end of `adoptTrackFile`. (`cancelled` never
   * reaches here: it is refused as `ADOPT_NOT_READY`.)
   */
  readonly reopened: boolean;
}

/* ------------------------------------------------------------------ */
/* refusals                                                            */
/* ------------------------------------------------------------------ */

function notFound(what: string): MMError {
  return new MMError("NOT_FOUND", what, { status: 404 });
}

/** Compare two absolute paths for containment, the way the host filesystem would. */
function within(child: string, root: string): boolean {
  const fold = (value: string): string => {
    const posix = toPosix(value).replace(/\/+$/, "");
    return process.platform === "win32" ? posix.toLowerCase() : posix;
  };
  const one = fold(child);
  const other = fold(root);
  return one === other || one.startsWith(`${other}/`);
}

/**
 * The roots a server path may be read from: the library, plus whatever Settings allows.
 *
 * The library is always in the list because the application already owns every byte under it —
 * refusing it would only mean that a file the operator had dropped into `.mm-work` by hand
 * could not be adopted, which is the one case where the path is obviously safe.
 */
export function adoptRoots(paths: PathMap, settings: Settings): readonly string[] {
  return [paths.host, ...settings.adoptSourceRoots].filter((root) => root.trim() !== "");
}

/**
 * Turn a path from a request body into an absolute path we are willing to open, or refuse.
 *
 * Three things happen here and all three matter:
 *
 *  1. **`resolve`**, so `..` is collapsed before anything is compared. Comparing the string as
 *     it arrived would let `<allowed>/../../etc/passwd` pass a prefix test.
 *  2. **`realpath`**, so a symlink inside an allowed folder cannot point out of it. This is
 *     the check a prefix test on the *given* path misses entirely, and it is the one an
 *     attacker with write access to an allowed folder would reach for.
 *  3. the containment test runs on the **real** path, against the **real** roots, so a root
 *     that is itself a symlink still works.
 *
 * A path that does not exist is a 404 and not a 403: the difference is already observable
 * (the allow-list is the operator's own configuration), and telling them "no such file" when
 * they mistyped a name they are allowed to read is the whole value of the distinction.
 */
export function resolveSourcePath(candidate: string, roots: readonly string[]): string {
  const real = resolveAllowed(candidate, roots, "file");
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new MMError("INVALID_INPUT", `\`${candidate}\` is not a file.`, { status: 400 });
  }
  if (stat.size === 0) {
    throw new MMError("INVALID_INPUT", `\`${candidate}\` is empty.`, { status: 400 });
  }
  return real;
}

/**
 * The same door, for a **folder** — `mm import <folder>` and the API and MCP equivalents.
 *
 * `adoptSourceRoots` applies to a folder exactly as it applies to a single adopted file, and
 * on purpose: a folder outside the allow-list is refused with the same `ADOPT_PATH_REFUSED`,
 * by the same `realpath`-then-contain test, in the same function. The validation is not
 * weakened because a folder is bigger than a file — it is *more* important there, since one
 * accepted path then licenses everything the listing finds under it.
 *
 * Two things a caller must know. `resolveAllowed` returns the **real** path, so every file
 * listed under it is already inside an allowed root by construction and no per-file check can
 * disagree with the folder-level one. And the listing is deliberately non-recursive
 * (`listFolder`), so an allowed root does not become a licence to walk a whole disk.
 */
export function resolveSourceFolder(candidate: string, roots: readonly string[]): string {
  const real = resolveAllowed(candidate, roots, "folder");
  if (!statSync(real).isDirectory()) {
    throw new MMError("INVALID_INPUT", `\`${candidate}\` is not a folder.`, {
      hint: "Import a folder of audio files; a single file is adopted onto a track instead.",
      status: 400,
    });
  }
  return real;
}

/**
 * The allow-list itself: resolve, realpath, contain — or refuse. Nothing else.
 *
 * Three things happen here and all three matter:
 *
 *  1. **`resolve`**, so `..` is collapsed before anything is compared. Comparing the string as
 *     it arrived would let `<allowed>/../../etc/passwd` pass a prefix test.
 *  2. **`realpath`**, so a symlink inside an allowed folder cannot point out of it. This is
 *     the check a prefix test on the *given* path misses entirely, and it is the one an
 *     attacker with write access to an allowed folder would reach for.
 *  3. the containment test runs on the **real** path, against the **real** roots, so a root
 *     that is itself a symlink still works.
 *
 * A path that does not exist is a 404 and not a 403: the difference is already observable
 * (the allow-list is the operator's own configuration), and telling them "no such file" when
 * they mistyped a name they are allowed to read is the whole value of the distinction.
 */
function resolveAllowed(
  candidate: string,
  roots: readonly string[],
  what: "file" | "folder",
): string {
  if (candidate.trim() === "" || candidate.includes("\0")) {
    throw new MMError("INVALID_INPUT", "The path is empty.", { status: 400 });
  }
  if (!isAbsolute(candidate)) {
    throw new MMError("INVALID_INPUT", `\`${candidate}\` is not an absolute path.`, {
      hint:
        what === "folder"
          ? "Give the full path as this server sees it, for example D:\\Musique\\album."
          : "Give the full path as this server sees it, for example D:\\Musique\\album\\03.flac.",
      status: 400,
    });
  }

  const refused = (): MMError =>
    new MMError("ADOPT_PATH_REFUSED", `Reading \`${candidate}\` is not allowed.`, {
      hint:
        roots.length <= 1
          ? "Only the library may be read from. Add the folder to `adoptSourceRoots` in " +
            "Settings, or upload the file instead."
          : `Allowed roots: ${roots.join(", ")}. Add another with \`adoptSourceRoots\`.`,
      action: "Allow the folder",
      details: { path: candidate, roots: [...roots] },
      status: 403,
    });

  let real: string;
  try {
    real = realpathSync.native(resolvePath(candidate));
  } catch {
    // Deliberately *before* the allow-list answer for a path that does exist, and deliberately
    // vague: "no such file" for something outside the allow-list would make this route a
    // filesystem oracle, which is the thing the allow-list is there to prevent.
    for (const root of roots) {
      try {
        if (within(resolvePath(candidate), realpathSync.native(root))) {
          throw notFound(`No such ${what}: ${candidate}`);
        }
      } catch (error) {
        if (error instanceof MMError) throw error;
      }
    }
    throw refused();
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      // A configured root that does not exist is a misconfiguration, not a reason to fail the
      // request: the other roots may well be right.
      continue;
    }
    if (within(real, realRoot)) return real;
  }
  throw refused();
}

/**
 * A file name for a replacement download, derived from the address it came from.
 *
 * Nobody supplies one: a replacement is an address, not a file, and the name it is given here
 * is what ends up in `ORIGINALFILENAME` and in the provenance record. `<videoId>.<ext>` is
 * the answer, because that is exactly what the *ordinary* download path writes for a track it
 * fetched itself (`resolvers/youtube.ts`, the non-adopted branch: `${entry.id}.${entry.ext}`),
 * and a replacement is an ordinary download of a different video.
 *
 * `v=` first — `youtube.com/watch?v=ID` is the long form and the one a person pastes — then
 * the last path segment, which covers `youtu.be/ID` and `fixture://name`. Anything unusable
 * degrades to `download`, never to an empty name: this string reaches `suffixOf`, and a name
 * with no stem would be refused for a file that is perfectly fine.
 */
export function nameFromUrl(url: string, container: string): string {
  const stem = ((): string => {
    try {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("v");
      if (query !== null && query.trim() !== "") return query;
      const segments = parsed.pathname.split("/").filter((part) => part !== "");
      const last = segments.at(-1) ?? parsed.hostname;
      return last === "" ? parsed.hostname : last;
    } catch {
      return "";
    }
  })()
    // The result becomes a filename, so it may not carry a separator, a drive letter or a NUL
    // whatever the address held. The stem is decoration; the destination name is the track id.
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return `${stem === "" ? "download" : stem}${container}`;
}

/** The basename of a path or of an uploaded filename, with any directory part discarded. */
export function baseNameOf(value: string): string {
  const cleaned = toPosix(value).replace(/\/+$/, "");
  return cleaned.split("/").pop() ?? cleaned;
}

/**
 * Why this import and this track cannot take a file right now, or `null`.
 *
 * Exported because the Console asks the same question in order to decide whether to offer the
 * button, and two answers to "may I?" is how a button appears that always fails.
 */
export function refuseAdoption(job: Import, track: ImportTrack, paths: PathMap): MMError | null {
  if (job.status === "cancelled") {
    return new MMError("ADOPT_NOT_READY", "This import was cancelled.", {
      hint: "Create it again, or retry the step, before adopting a file for one of its tracks.",
      status: 409,
    });
  }
  // Before `download` there is no mapping to hang a file on: `fingerprint` compares the file
  // with a recording, `tag` builds a document from one, and `place` needs the path template's
  // fields. Adopting a file into an import that has not been confirmed would produce a track
  // that is `downloaded` and going nowhere.
  if (isBefore(job.step, "download")) {
    return new MMError("ADOPT_NOT_READY", `This import is still at \`${job.step}\`.`, {
      hint: "Confirm the release and the mapping first; a file can only be adopted for a track that is bound to a MusicBrainz recording.",
      action: "Confirm the mapping",
      status: 409,
    });
  }
  if (track.role !== "mapped") {
    return new MMError("ADOPT_NOT_READY", "This video is not bound to a track.", {
      hint: `Its role is \`${track.role}\`. Only a mapped video can be given a file.`,
      status: 409,
    });
  }

  const filed = fileAt(paths, track.libraryPath);
  if (filed !== null) {
    return new MMError("ADOPT_CONFLICT", "This track is already filed in the library.", {
      hint: `\`${filed}\` exists. Use Retry track to start it again, which removes the file first.`,
      action: "Retry the track",
      details: { path: filed },
      status: 409,
    });
  }
  const held = fileAt(paths, track.downloadPath) ?? fileAt(paths, workPathOf(paths, track));
  if (held !== null) {
    return new MMError("ADOPT_CONFLICT", "This track already has a file.", {
      hint: `\`${held}\` is waiting to be tagged and filed. Use Retry track to discard it first.`,
      action: "Retry the track",
      details: { path: held },
      status: 409,
    });
  }
  return null;
}

/** `relative` when it names a non-empty regular file inside the library, else `null`. */
function fileAt(paths: PathMap, relative: string | null): string | null {
  if (relative === null || relative === "") return null;
  const absolute = hostPath(paths, relative);
  if (!existsSync(absolute)) return null;
  const stat = statSync(absolute);
  return stat.isFile() && stat.size > 0 ? relative : null;
}

/** The work path this track's file would already be at, whatever its extension. */
function workPathOf(paths: PathMap, track: ImportTrack): string | null {
  const folder = workFolder(paths, track.importId);
  for (const suffix of TAGGABLE_SUFFIXES) {
    const candidate = `${folder}/${track.id}${suffix}`;
    if (existsSync(hostPath(paths, candidate))) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* getting the bytes to the work path                                  */
/* ------------------------------------------------------------------ */

/** The file is at the work path, whole, and this is what it turned out to be. */
interface Placed {
  /** Library-relative, forward slashes: `.mm-work/imp_…/itr_….opus`. */
  readonly relative: string;
  readonly container: string;
  readonly originalName: string;
  /** The address the bytes came from, for `via: "url"`. `null` for a file. */
  readonly downloadedFrom: string | null;
}

interface PlaceContext {
  readonly paths: PathMap;
  readonly settings: Settings;
  readonly folder: string;
  readonly trackId: string;
}

/** `\`.flac\` is not a container the tagger can write to.` — the same refusal for all three kinds. */
function refuseContainer(name: string, container: string): MMError {
  return new MMError(
    "ADOPT_UNSUPPORTED",
    container === ""
      ? `\`${name}\` has no extension, so there is no way to tell what it is.`
      : `\`${container}\` is not a container the tagger can write to.`,
    {
      hint: `Convert it to one of: ${ADOPTABLE_SUFFIXES.join(", ")}. Remuxing a .webm to .opus with ffmpeg is a stream copy and loses nothing.`,
      action: "Convert the file",
      details: { container, accepted: [...ADOPTABLE_SUFFIXES] },
      status: 415,
    },
  );
}

/**
 * A path on this server or an upload, copied into the work directory.
 *
 * Unchanged from the day this module was written, only lifted out of `adoptTrackFile` so that
 * the third kind is a sibling of it rather than a branch inside it.
 */
function copyIntoWork(
  source: Extract<AdoptSource, { kind: "path" | "upload" }>,
  ctx: PlaceContext,
): Placed {
  const originalName = baseNameOf(source.kind === "path" ? source.path : source.filename);
  const sourcePath =
    source.kind === "path"
      ? resolveSourcePath(source.path, adoptRoots(ctx.paths, ctx.settings))
      : null;

  if (source.kind === "upload") {
    if (source.bytes.byteLength === 0) {
      throw new MMError("INVALID_INPUT", "The uploaded file is empty.", { status: 400 });
    }
    if (source.bytes.byteLength > MAX_ADOPT_UPLOAD_BYTES) {
      throw new MMError(
        "INVALID_INPUT",
        `The upload is ${String(Math.round(source.bytes.byteLength / 1024 / 1024))} MB; the limit is ${String(MAX_ADOPT_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        {
          hint: "Put the file on the server and adopt it by path instead.",
          status: 413,
        },
      );
    }
  }

  /* ---- a container the toolbox can write tags to, decided before a byte is copied ---- */
  const container = suffixOf(originalName);
  if (!taggable(originalName)) throw refuseContainer(originalName, container);

  const relative = `${ctx.folder}/${ctx.trackId}${container}`;
  const absolute = hostPath(ctx.paths, relative);
  // `fileReady` believes any non-empty file at this path, so nothing half-written may ever
  // *be* at this path: write beside it and rename, which is atomic on one filesystem.
  const pending = `${absolute}.part`;
  rmSync(pending, { force: true });
  try {
    if (sourcePath !== null) copyFileSync(sourcePath, pending);
    else if (source.kind === "upload") writeFileSync(pending, source.bytes);
    renameSync(pending, absolute);
  } catch (error) {
    rmSync(pending, { force: true });
    throw new MMError("UNKNOWN", `The file could not be copied into the work directory.`, {
      hint: MMError.from(error).message,
      details: { path: relative },
      status: 500,
    });
  }

  return { relative, container, originalName, downloadedFrom: null };
}

/**
 * A replacement address, fetched into the work directory by the toolbox.
 *
 * The one kind that spends the single download slot, and the one whose container is not known
 * before the bytes arrive: yt-dlp picks the format, so the extension is an *outcome*. That
 * inverts the order the other two kinds use — they refuse an unsupported container before
 * copying anything, this one has to fetch first and refuse after — and it is why the file is
 * fetched under a **staging stem** (`<trackId>.adopting`) and renamed into place afterwards.
 *
 * The staging stem is not decoration. `fileReady` and `refuseAdoption`'s `workPathOf` both
 * look for `<trackId><suffix>` exactly, so nothing under `<trackId>.adopting.opus` is visible
 * to them: a download that dies halfway, a container the tagger cannot write, or a file that
 * turns out not to be audio all leave the track exactly as adoptable as it was, instead of
 * leaving a corpse that the *next* attempt would refuse with `ADOPT_CONFLICT` naming a file
 * the owner never accepted. The rename at the end is the same atomic hand-off the `.part`
 * sibling gives the other two kinds.
 *
 * A `409 LOCKED` is re-thrown as itself. `download.ts` waits one out, deliberately, because it
 * is a worker with nobody watching; this is a person or an agent holding a request open, and
 * telling them the slot is busy is both faster and truer than a request that hangs for minutes
 * and may still fail (`CLAUDE.md` § One orchestrator).
 */
async function downloadReplacement(
  url: string,
  ctx: PlaceContext & { readonly toolbox: ToolboxClient },
): Promise<Placed> {
  const parsed = adoptUrlSchema.safeParse(url);
  if (!parsed.success) {
    throw new MMError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Unusable address.", {
      hint: "Paste the address of another upload of the same song — the page URL, not a file path.",
      details: { url },
      status: 400,
    });
  }
  const address = parsed.data;

  const stem = `${ctx.trackId}.adopting`;
  const staged = (suffix: string): string => `${ctx.folder}/${stem}${suffix}`;
  const sweep = (): void => {
    for (const suffix of TAGGABLE_SUFFIXES) {
      rmSync(hostPath(ctx.paths, staged(suffix)), { force: true });
      rmSync(`${hostPath(ctx.paths, staged(suffix))}.part`, { force: true });
    }
  };
  sweep();

  let donePath: string | null = null;
  try {
    for await (const event of ctx.toolbox.download({
      url: address,
      destDir: containerPath(ctx.paths, ctx.folder),
      id: stem,
      format: ctx.settings.downloadFormat,
      // The configured session, exactly as `download.ts` sends it: a replacement upload is as
      // likely to want a cookie jar as the original was.
      cookies: cookieJar(ctx.settings),
    })) {
      if (event.event === "done") donePath = event.path;
      else if (event.event === "error") {
        throw MMError.fromBody(event, "The replacement download failed.");
      }
    }
  } catch (error) {
    sweep();
    const failure = MMError.from(error);
    if (failure.code === "LOCKED") {
      throw new MMError("LOCKED", "A download is already running.", {
        hint: "There is one download slot. Wait for the current one to finish and adopt this address again.",
        action: "Try again shortly",
        status: 409,
      });
    }
    throw failure;
  }

  if (donePath === null) {
    sweep();
    throw new MMError("UNKNOWN", "The toolbox never reported the downloaded file.", {
      hint: `Nothing was fetched from ${address}.`,
      details: { url: address },
      status: 502,
    });
  }

  const from = toRelative(ctx.paths, donePath) ?? staged(".opus");
  const container = suffixOf(from);
  const originalName = nameFromUrl(address, container);
  if (!taggable(from)) {
    sweep();
    throw refuseContainer(originalName, container);
  }

  const relative = `${ctx.folder}/${ctx.trackId}${container}`;
  try {
    rmSync(hostPath(ctx.paths, relative), { force: true });
    renameSync(hostPath(ctx.paths, from), hostPath(ctx.paths, relative));
  } catch (error) {
    sweep();
    throw new MMError("UNKNOWN", "The downloaded file could not be moved into position.", {
      hint: MMError.from(error).message,
      details: { path: relative },
      status: 500,
    });
  }
  sweep();

  return { relative, container, originalName, downloadedFrom: address };
}

/* ------------------------------------------------------------------ */
/* the service                                                         */
/* ------------------------------------------------------------------ */

export async function adoptTrackFile(options: AdoptOptions): Promise<AdoptResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const paths = resolvePaths(settings);
  const toolboxClient = options.toolbox ?? defaultToolbox();

  const job = await requireImport(options.importId, db);
  const [track] = await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.id, options.trackId), eq(importTracks.importId, options.importId)))
    .limit(1);
  if (track === undefined) {
    throw notFound(`No track ${options.trackId} on import ${options.importId}.`);
  }

  const refusal = refuseAdoption(job, track, paths);
  if (refusal !== null) throw refusal;

  /* ---- get the bytes to the work path, however they were offered ---- */
  const source = options.source;
  const folder = workFolder(paths, job.id);
  mkdirSync(hostPath(paths, folder), { recursive: true });

  const placed =
    source.kind === "url"
      ? await downloadReplacement(source.url, {
          paths,
          settings,
          toolbox: toolboxClient,
          folder,
          trackId: track.id,
        })
      : copyIntoWork(source, { paths, settings, folder, trackId: track.id });

  const { relative, container, originalName } = placed;
  const downloadedFrom = placed.downloadedFrom;
  const absolute = hostPath(paths, relative);

  /* ---- and is it audio at all? ---- */
  //
  // The extension said what it is; ffprobe says what it *contains*. A JPEG renamed `.mp3`, a
  // zip renamed `.m4a`, a video someone saved as `.mp4` — all three pass the check above and
  // none of them is a track. Asking here, before the row is written, means the refusal costs
  // the owner one message instead of a track that fails three steps later with
  // `TAG_WRITE_FAILED` and a sentence about mutagen.
  let codec: string | null = null;
  let durationSeconds: number | null = null;
  try {
    const probe = await toolboxClient.probe(containerPath(paths, relative));
    const audio = (probe.streams ?? []).some((stream) => stream.codec_type === "audio");
    if (!audio || probe.codec === null || probe.codec === undefined) {
      throw new MMError("ADOPT_NOT_AUDIO", `\`${originalName}\` contains no audio.`, {
        hint: `ffprobe read it as ${probe.format_name ?? "something it could not name"}. Check the file.`,
        details: { formatName: probe.format_name ?? null },
        status: 415,
      });
    }
    codec = probe.codec;
    durationSeconds = probe.duration ?? null;
  } catch (error) {
    // Whatever went wrong, the file we just copied is not staying: leaving it would make the
    // *next* attempt fail with `ADOPT_CONFLICT` naming a file the owner never accepted.
    rmSync(absolute, { force: true });
    const failure = MMError.from(error);
    if (failure.code === "ADOPT_NOT_AUDIO") throw failure;
    throw new MMError("ADOPT_NOT_AUDIO", `\`${originalName}\` could not be read as audio.`, {
      hint: failure.message,
      details: { path: relative },
      status: 415,
    });
  }

  const bytes = statSync(absolute).size;

  /* ---- the row, and the provenance that outlives it ---- */
  const adoption: Adoption = {
    adoptedAt: new Date().toISOString(),
    originalName,
    via: source.kind,
    bytes,
    container,
    codec,
    adoptedBy: options.adoptedBy,
    ...(downloadedFrom === null ? {} : { url: downloadedFrom }),
  };
  const raw: Record<string, unknown> = {
    ...(typeof track.raw === "object" && track.raw !== null ? track.raw : {}),
    [ADOPTION_KEY]: adoption,
  };

  await db
    .update(importTracks)
    .set({
      raw,
      downloadPath: relative,
      downloadedBytes: bytes,
      // Exactly where `download` leaves a file it fetched itself, which is what lets the rest
      // of the pipeline carry on without knowing anything happened.
      state: "downloaded",
      // The attempts and the error belong to the download that failed. The file is here now;
      // leaving them would make the Console show a red line under a track that is fine.
      attempts: 0,
      error: null,
      note:
        downloadedFrom === null
          ? `adopted from a local file (${originalName})`
          : `downloaded from a replacement address (${downloadedFrom})`,
      updatedAt: new Date(),
    })
    .where(eq(importTracks.id, track.id));

  await emit(
    {
      importId: job.id,
      trackId: track.id,
      step: "download",
      type: "track.adopted",
      message:
        downloadedFrom === null
          ? `${track.sourceTitle}: adopted "${originalName}"`
          : `${track.sourceTitle}: downloaded from ${downloadedFrom}`,
      data: {
        stage: "adopted",
        via: source.kind,
        bytes,
        container,
        codec,
        path: relative,
        downloadedFrom,
        adoptedBy: options.adoptedBy,
      },
    },
    db,
  );

  /*
   * Re-open the import, when it had already given up.
   *
   * This is the case the whole feature exists for, and it is the one that quietly does nothing
   * without these lines. One video of fourteen comes back `YTDLP_AGE`; `settleImport` concludes
   * the album `failed` and writes `failed` on the `download` step row. Handing that import a
   * file and putting a `track.step` message on the queue would achieve exactly nothing:
   * `runTrackStep` refuses on a terminal or paused job — deliberately, because a queue message
   * is a statement about the past — and the message would be consumed and skipped.
   *
   * So a finished import is rewound to `download` and put back on the download queue, which is
   * precisely what "Retry track" does, and for the same reason: `download` is the step that
   * decides what each track needs. **It will not download this one.** It re-reads the
   * filesystem rather than trusting the row (`fileReady`), finds the file that has just been
   * adopted, counts it as reused and announces it on the per-track queue — the same hand-off a
   * file it fetched itself gets. What it *will* do is try the album's other dead videos again,
   * which after a person has intervened is the right default and is how the `download` step row
   * comes to say something true again.
   *
   * An import that is still running is left alone: the per-track message is enough, `download`
   * is still walking the tracklist, and rewinding it underneath itself would be a second
   * downloader (owner review C3).
   */
  const reopen = isTerminal(job.status) || job.status === "paused";
  // Before `syncLocalSteps`, because `rewindTo` blanks the step rows from `download` onwards
  // and the projection of the track states has to be the last word on the three it owns.
  // `queue` does not gate it: re-opening is a change to the rows, not a message, and a caller
  // driving the steps itself still needs the import to have stopped being `failed`.
  if (reopen) await rewindTo(job.id, "download", db);

  // The three pipelined `job_steps` rows are derived from the track states, so the Console's
  // progress and the API's `queuePosition` are wrong until this runs.
  await syncLocalSteps(db, job.id);

  const nextStep = await nextStepOfTrack(db, track.id);

  let queued = false;
  if (options.queue !== false) {
    if (reopen) {
      await enqueue(job.id, `adopted a local file for ${track.sourceTitle}`, "download");
      queued = true;
    } else if (nextStep !== null) {
      await enqueueTrack({ importId: job.id, trackId: track.id, step: nextStep });
      queued = true;
    }
  }

  return {
    importId: job.id,
    trackId: track.id,
    path: relative,
    bytes,
    container,
    codec,
    durationSeconds,
    via: source.kind,
    downloadedFrom,
    originalName,
    nextStep,
    queued,
    reopened: reopen,
  };
}
