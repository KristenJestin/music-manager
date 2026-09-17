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
 * Two ways, one schema, one code path (`AdoptSource`):
 *
 *  - **a path on this server** (`{ kind: "path" }`) — the honest answer to "take over my
 *    library", because the files are already here and copying two hundred of them through an
 *    HTTP body to a process running on the same disk is ceremony, not safety;
 *  - **an upload** (`{ kind: "upload" }`) — the honest answer for the Console and for anyone
 *    who does not have a shell on the machine.
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
 * precisely what `download`'s `onTrackDownloaded` hook does for a file it fetched itself. The
 * download queue is not touched, and its single slot is not spent.
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
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, type Import, type ImportTrack } from "#/server/db/schema/index.ts";
import {
  containerPath,
  hostPath,
  suffixOf,
  TAGGABLE_SUFFIXES,
  taggable,
  toPosix,
  workFolder,
  type PathMap,
} from "#/server/paths.ts";
import { emit } from "#/server/services/events.ts";
import { enqueueTrack } from "#/server/services/queue.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { ADOPTION_KEY, type Adoption } from "#/server/services/adopt.record.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { isBefore } from "#/server/services/jobs/machine.ts";
import { nextStepOfTrack, syncLocalSteps } from "#/server/services/jobs/pipeline.ts";
import { requireImport } from "#/server/services/jobs/context.ts";

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

export type AdoptSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "upload"; readonly filename: string; readonly bytes: Uint8Array };

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
  readonly via: "path" | "upload";
  readonly originalName: string;
  /** The step this track will run next, or `null` when there is nothing left for it. */
  readonly nextStep: "fingerprint" | "tag" | "place" | null;
  readonly queued: boolean;
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
  if (candidate.trim() === "" || candidate.includes("\0")) {
    throw new MMError("INVALID_INPUT", "The path is empty.", { status: 400 });
  }
  if (!isAbsolute(candidate)) {
    throw new MMError("INVALID_INPUT", `\`${candidate}\` is not an absolute path.`, {
      hint: "Give the full path as this server sees it, for example D:\\Musique\\album\\03.flac.",
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
          throw notFound(`No such file: ${candidate}`);
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
    if (!within(real, realRoot)) continue;
    const stat = statSync(real);
    if (!stat.isFile()) {
      throw new MMError("INVALID_INPUT", `\`${candidate}\` is not a file.`, { status: 400 });
    }
    if (stat.size === 0) {
      throw new MMError("INVALID_INPUT", `\`${candidate}\` is empty.`, { status: 400 });
    }
    return real;
  }
  throw refused();
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

  /* ---- where the bytes are, and whether we are allowed to read them ---- */
  const source = options.source;
  const originalName = baseNameOf(source.kind === "path" ? source.path : source.filename);
  const sourcePath =
    source.kind === "path" ? resolveSourcePath(source.path, adoptRoots(paths, settings)) : null;

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
  if (!taggable(originalName)) {
    throw new MMError(
      "ADOPT_UNSUPPORTED",
      container === ""
        ? `\`${originalName}\` has no extension, so there is no way to tell what it is.`
        : `\`${container}\` is not a container the tagger can write to.`,
      {
        hint: `Convert it to one of: ${ADOPTABLE_SUFFIXES.join(", ")}. Remuxing a .webm to .opus with ffmpeg is a stream copy and loses nothing.`,
        action: "Convert the file",
        details: { container, accepted: [...ADOPTABLE_SUFFIXES] },
        status: 415,
      },
    );
  }

  /* ---- copy it into the work directory, where `place` expects to find it ---- */
  const folder = workFolder(paths, job.id);
  mkdirSync(hostPath(paths, folder), { recursive: true });
  const relative = `${folder}/${track.id}${container}`;
  const absolute = hostPath(paths, relative);
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
      note: `adopted from a local file (${originalName})`,
      updatedAt: new Date(),
    })
    .where(eq(importTracks.id, track.id));

  await emit(
    {
      importId: job.id,
      trackId: track.id,
      step: "download",
      type: "track.adopted",
      message: `${track.sourceTitle}: adopted "${originalName}"`,
      data: {
        stage: "adopted",
        via: source.kind,
        bytes,
        container,
        codec,
        path: relative,
        adoptedBy: options.adoptedBy,
      },
    },
    db,
  );

  // The three pipelined `job_steps` rows are derived from the track states, so the Console's
  // progress and the API's `queuePosition` are wrong until this runs.
  await syncLocalSteps(db, job.id);

  const nextStep = await nextStepOfTrack(db, track.id);
  let queued = false;
  if (options.queue !== false && nextStep !== null) {
    await enqueueTrack({ importId: job.id, trackId: track.id, step: nextStep });
    queued = true;
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
    originalName,
    nextStep,
    queued,
  };
}
