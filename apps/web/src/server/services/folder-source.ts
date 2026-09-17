/**
 * Listing a folder of audio files the way `extract` lists a playlist.
 *
 * This is the whole of the folder import's novelty: **the entries stop being videos and become
 * files, and the rest of the pipeline does not change.** `resolve` gets an `ExtractResult` with
 * one entry per file; `match` scores those entries exactly as it scores videos — the same
 * problem with *better* signals, an exact duration instead of a rounded one and, later, a
 * fingerprint; `download` adopts each file rather than fetching it; `tag`, `place` and `verify`
 * never learn that anything was different.
 *
 * ## Who walks the folder, and why it is this side
 *
 * The walk is here, in the orchestrator, and not in the toolbox — even though the toolbox is
 * the one with ffprobe. Two reasons, and the first is the one that decides it:
 *
 *  1. **`adoptSourceRoots` lives here.** It is a setting, it is enforced by `realpath`-then-
 *     contain against paths this process can see (`services/adopt.ts`), and it is empty by
 *     default. A directory endpoint in the toolbox would be a way to list a disk the allow-list
 *     never opened, and the allow-list would have to be taught to a second process in a second
 *     language to stop it. One enforcement point, on the side that owns the setting.
 *  2. the app already has filesystem access to the mount, so reading the *names* costs nothing
 *     and needs nobody.
 *
 * What the toolbox does is the part it alone can do: read the files. And it does it in **one
 * request**, not one per file — `POST /probe/batch`. The number that settled it is the owner's:
 * twenty vanished playlists are 273 tracks, and 273 HTTP round trips inside a step somebody is
 * watching is about a minute of pure latency for an answer that takes seconds. One call of 273
 * paths (or two, at the 500-path cap) is the same ffprobe work with the round trips removed.
 *
 * ## What it refuses
 *
 *  - a folder outside `adoptSourceRoots` — `ADOPT_PATH_REFUSED`, by the same function that
 *    refuses a single adopted file, with `realpath` before containment. Unchanged, and
 *    deliberately not weakened for folders;
 *  - a folder with nothing the tagger can read — `FOLDER_NO_AUDIO`, naming what it did see;
 *  - a file the toolbox cannot read — **skipped, not fatal**, with a reason the caller can put
 *    in the journal. One corrupt track must not cost the listing of an album. If *every* file
 *    fails, that is `FOLDER_NO_AUDIO` again, carrying the reasons.
 *
 * ## The two ends of the same folder
 *
 * ffprobe runs inside the toolbox container, so the container has to be able to *see* the
 * folder. Inside the library mount that is free — `toToolbox` rewrites the path the way every
 * other step's paths are rewritten. Outside it, the path is passed through unchanged, and that
 * is precisely what `MM_ADOPT_PATH` is for: in production the source library is bind-mounted
 * **read-only at the same path** in `web`, `worker` and `toolbox`, so "unchanged" *is* the
 * translation and there is no second pair of roots to keep in step. `docs/deploy.md`
 * § « Monter une bibliothèque existante » is the procedure, and `FOLDER_NO_AUDIO` names the
 * mount when a folder outside the library turns out to be invisible to the toolbox.
 *
 * ## One folder, one release
 *
 * The listing is **not recursive**, and that is a decision rather than an omission. A folder of
 * album folders is a library, not a release: flattening it would hand `match` two hundred files
 * that belong to fifteen records and ask it to find one release for them. Subdirectories are
 * counted and reported so the refusal can say "you meant the folder one level down", which is
 * the actual mistake somebody makes here.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MMError } from "@mm/contracts";
import { suffixOf, TAGGABLE_SUFFIXES, taggable, toPosix, toToolbox } from "#/server/paths.ts";
import type { PathMap } from "#/server/paths.ts";
import { adoptRoots, resolveSourceFolder } from "#/server/services/adopt.ts";
import { FOLDER_FILE_KEY, type FolderFile } from "#/server/services/folder.record.ts";
import { folderUrl } from "#/server/services/import-source.ts";
import type { Settings } from "#/server/services/settings.ts";
import type { ExtractEntry, ExtractResult, ToolboxClient } from "#/server/toolbox/client.ts";

/**
 * How many paths go into one `POST /probe/batch`. Mirrors `MAX_PROBE_BATCH` in `models.py`.
 *
 * Restated rather than imported because the generated client exposes the *shape* of the
 * request and not the validator's bound; sending 501 paths would be a 422 from pydantic, which
 * is a worse way to learn a limit than splitting at it.
 */
export const PROBE_BATCH_SIZE = 500;

/** A file the listing had to leave out, and why. Journalled by the caller. */
export interface SkippedFile {
  readonly name: string;
  readonly reason: string;
  readonly code: string;
}

export interface FolderListing extends ExtractResult {
  /** The folder as this server sees it, `realpath`-resolved and inside an allowed root. */
  readonly folder: string;
  /** Files that are there but could not be listed. Never fatal on its own. */
  readonly skipped: readonly SkippedFile[];
  /**
   * The release every file already agrees it belongs to, when they carry one.
   *
   * An existing library's files were tagged by something — Picard, this application's v1, or
   * this one — and a `MUSICBRAINZ_ALBUMID` they all share is not a hint, it is the answer. It
   * is offered, never imposed: `resolve` uses it only when nobody passed `--release`, and the
   * matcher still has to find the release behind it.
   */
  readonly releaseMbidHint: string | null;
}

export interface ListFolderOptions {
  readonly paths: PathMap;
  readonly settings: Settings;
  readonly toolbox: ToolboxClient;
}

/**
 * List `folder` as an `ExtractResult`, one entry per audio file.
 *
 * `folder` is whatever a person typed; it is resolved and checked here, once, and the resolved
 * path comes back on the result so no caller has to repeat the check.
 */
export async function listFolder(
  folder: string,
  options: ListFolderOptions,
): Promise<FolderListing> {
  const root = resolveSourceFolder(folder, adoptRoots(options.paths, options.settings));

  /* ---- what is in there ---- */
  const names: string[] = [];
  let subdirectories = 0;
  let foreign = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      subdirectories += 1;
      continue;
    }
    if (!entry.isFile()) continue;
    // A dotfile is either an operating system's bookkeeping (`.DS_Store`) or something
    // deliberately hidden. Neither is a track somebody meant to import.
    if (entry.name.startsWith(".")) continue;
    if (!taggable(entry.name)) {
      foreign += 1;
      continue;
    }
    names.push(entry.name);
  }

  if (names.length === 0) throw noAudio(folder, root, { subdirectories, foreign });

  /*
   * Sorted by name, numerically, before anything else.
   *
   * `Intl.Collator` with `numeric` is what makes `2 - …` come before `10 - …`; a plain string
   * sort would file the tenth track third and `match` would be handed a tracklist in an order
   * nobody's folder is in. The track *numbers* in the tags win over this when every file has
   * one — see `order` below — but a folder whose files were never tagged still has to arrive in
   * the order a person sees on their own screen.
   */
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  names.sort(collator.compare);

  /* ---- what is in them: one request per PROBE_BATCH_SIZE files, not one per file ---- */
  const probed = new Map<string, ProbeOutcome>();
  for (let from = 0; from < names.length; from += PROBE_BATCH_SIZE) {
    const slice = names.slice(from, from + PROBE_BATCH_SIZE);
    const answer = await options.toolbox.probeBatch(
      slice.map((name) => toToolbox(options.paths, join(root, name))),
    );
    // Answers come back in the order they were asked for, which is what lets a listing be
    // lined up with its files by index instead of by re-matching a string the toolbox may
    // have normalised.
    slice.forEach((name, index) => {
      const item = answer.files[index];
      if (item === undefined || item.result === null || item.result === undefined) {
        probed.set(name, {
          ok: false,
          reason: item?.error?.message ?? "the toolbox returned no answer for this file",
          code: item?.error?.code ?? "UNKNOWN",
        });
        return;
      }
      probed.set(name, { ok: true, result: item.result });
    });
  }

  /* ---- one entry per file that survived ---- */
  const skipped: SkippedFile[] = [];
  const files: { name: string; file: FolderFile; tags: Record<string, string> }[] = [];
  for (const name of names) {
    const outcome = probed.get(name);
    if (outcome === undefined || !outcome.ok) {
      skipped.push({
        name,
        reason: outcome?.reason ?? "the toolbox did not answer for this file",
        code: outcome?.code ?? "UNKNOWN",
      });
      continue;
    }
    const probe = outcome.result;
    const hasAudio = (probe.streams ?? []).some((stream) => stream.codec_type === "audio");
    if (!hasAudio || probe.codec === null || probe.codec === undefined) {
      // The extension said it was audio and ffprobe says it is not: a cover renamed `.mp3`, a
      // video saved as `.mp4`. Skipped here rather than three steps later in `tag`.
      skipped.push({
        name,
        reason: `ffprobe read it as ${probe.format_name ?? "something it could not name"}, with no audio stream`,
        code: "ADOPT_NOT_AUDIO",
      });
      continue;
    }
    const tags = normaliseTags(probe.tags ?? {});
    files.push({
      name,
      tags,
      file: {
        path: join(root, name),
        name,
        folder: root,
        container: suffixOf(name),
        bytes: probe.size,
        codec: probe.codec,
        durationSeconds: probe.duration ?? null,
        tags,
      },
    });
  }

  if (files.length === 0) {
    throw noAudio(folder, root, {
      subdirectories,
      foreign,
      skipped,
      // Every single file unreadable, from a folder the operator was allowed to open, is one
      // failure with one cause nine times out of ten: the toolbox container has no mount for
      // it. Naming it here is the difference between a diagnosis and a mystery.
      unmounted: toToolbox(options.paths, root) === toPosix(root),
    });
  }

  /*
   * The tracklist's own order wins, when the files agree they have one.
   *
   * Only when **every** file carries a track number, and only when they are all different: a
   * folder where half the files were tagged would otherwise be re-ordered by the tagged half
   * and interleaved arbitrarily with the rest, which is worse than the filename order it
   * replaced. Disc number first, because a two-disc release has two track ones.
   */
  const ordered = orderByTracklist(files);

  const entries: ExtractEntry[] = ordered.map((held, index) =>
    entryOf(held.name, held.file, held.tags, index + 1),
  );

  return {
    kind: "playlist",
    // The folder's own name is what a person calls this record; the ALBUM tag is better still
    // when the files agree on one, and `resolve` runs it through the same title cleaning a
    // YouTube playlist title gets.
    title: majority(ordered.map((held) => held.tags["ALBUM"] ?? "")) ?? baseNameOf(root),
    uploader:
      majority(ordered.map((held) => held.tags["ALBUMARTIST"] ?? "")) ??
      majority(ordered.map((held) => held.tags["ARTIST"] ?? "")),
    id: folderUrl(root),
    entries,
    folder: root,
    skipped,
    releaseMbidHint: majority(ordered.map((held) => held.tags["MUSICBRAINZ_ALBUMID"] ?? "")),
  };
}

type ProbeOutcome =
  | { readonly ok: true; readonly result: NonNullable<ProbeItem["result"]> }
  | { readonly ok: false; readonly reason: string; readonly code: string };

type ProbeItem = Awaited<ReturnType<ToolboxClient["probeBatch"]>>["files"][number];

/* ------------------------------------------------------------------ */
/* one file, as an entry                                               */
/* ------------------------------------------------------------------ */

/**
 * The `ExtractEntry` a file produces, with its provenance attached.
 *
 * Every field the *matcher* reads is filled from the file's own tags, because that is what
 * "the search uses the folder's tags" means: `track`, `artist`, `album`, `release_year` and
 * `duration` are exactly the fields `toMatchVideo` lifts off a yt-dlp entry, so the matching
 * code needs no branch at all. `duration` is the one that is simply *better* here — ffprobe
 * measures it, YouTube rounds it to the second.
 *
 * `id` is a digest of the file's name, not a video id, and that matters twice: `resolve`
 * de-duplicates on it when the step is re-run, and it must therefore be stable across runs and
 * distinct per file in the folder. `webpage_url` is the file's own `file://` URL, which is what
 * becomes `MUSICMANAGER_SOURCEURL` — the honest answer to "where did this track come from".
 */
function entryOf(
  name: string,
  file: FolderFile,
  tags: Record<string, string>,
  index: number,
): ExtractEntry {
  const stem = name.replace(/\.[^.]+$/, "");
  const title = text(tags["TITLE"]) ?? stem;
  const artist = text(tags["ARTIST"]) ?? text(tags["ALBUMARTIST"]);
  const entry: Record<string, unknown> = {
    id: fileId(name),
    title,
    duration: file.durationSeconds,
    uploader: text(tags["ALBUMARTIST"]) ?? artist,
    index,
    track: text(tags["TITLE"]),
    artist,
    album: text(tags["ALBUM"]),
    release_year: yearOf(tags),
    description: null,
    thumbnails: [],
    webpage_url: folderUrl(file.path),
    playlist_index: numberOf(tags["TRACKNUMBER"]) ?? index,
    availability: null,
    unavailable: false,
    /*
     * The provenance, carried on the entry so that it lands in `import_tracks.raw` verbatim
     * with everything else `resolve` writes. `download` reads it to adopt the file instead of
     * fetching it; a rebuild of the document a year from now reads its `tags`.
     */
    [FOLDER_FILE_KEY]: file,
  };
  return entry as unknown as ExtractEntry;
}

/**
 * A stable, folder-local id for a file — what `import_tracks.video_id` holds for a folder
 * import.
 *
 * The file's *name* and not its path, because the column's job is to answer "have I already
 * got a row for this entry?" when `resolve` runs twice, and a folder that has been moved is
 * still the same folder. Hashed rather than used raw so that the value is a fixed, harmless
 * shape wherever it is printed — a name with a slash, a quote or four hundred characters in it
 * would otherwise travel into URLs, logs and filenames.
 */
export function fileId(name: string): string {
  return `file-${createHash("sha1").update(name, "utf8").digest("hex").slice(0, 16)}`;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** ffprobe upper-cases nothing on MP4; the batch does, but a defensive pass costs nothing. */
function normaliseTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value !== "string") continue;
    out[key.toUpperCase()] = value;
  }
  return out;
}

function text(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `3`, `3/12`, `03` — a tag that means a position. `null` when it means nothing. */
function numberOf(value: string | undefined): number | null {
  const held = text(value);
  if (held === null) return null;
  const digits = /^(\d+)/.exec(held);
  if (digits?.[1] === undefined) return null;
  const parsed = Number.parseInt(digits[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** `DATE`, `ORIGINALDATE`, `YEAR` — whichever is there, reduced to a year. */
function yearOf(tags: Record<string, string>): number | null {
  for (const key of ["DATE", "ORIGINALDATE", "ORIGINALYEAR", "YEAR", "RELEASEDATE"]) {
    const found = /(\d{4})/.exec(text(tags[key]) ?? "");
    if (found?.[1] !== undefined) return Number.parseInt(found[1], 10);
  }
  return null;
}

/**
 * The value more than half of them carry, or `null`.
 *
 * A strict majority rather than a plurality: this answers "do these files agree?", and two
 * files out of seven agreeing is not agreement. It is what turns a folder's `ALBUM` tags into
 * the import's title and its `MUSICBRAINZ_ALBUMID`s into a release hint — both of which must be
 * silent rather than wrong when the folder is a mixture.
 */
function majority(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    total += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (total === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return bestCount * 2 > values.length ? best : null;
}

interface Held {
  readonly name: string;
  readonly file: FolderFile;
  readonly tags: Record<string, string>;
}

function orderByTracklist(files: readonly Held[]): readonly Held[] {
  const positions = files.map((held) => ({
    disc: numberOf(held.tags["DISCNUMBER"]) ?? 1,
    track: numberOf(held.tags["TRACKNUMBER"]),
    held,
  }));
  if (positions.some((position) => position.track === null)) return files;
  const seen = new Set(
    positions.map((position) => `${String(position.disc)}/${String(position.track)}`),
  );
  if (seen.size !== positions.length) return files;
  return [...positions]
    .sort((one, other) => one.disc - other.disc || (one.track ?? 0) - (other.track ?? 0))
    .map((position) => position.held);
}

function baseNameOf(path: string): string {
  const cleaned = toPosix(path).replace(/\/+$/, "");
  return cleaned.split("/").pop() ?? cleaned;
}

function noAudio(
  asked: string,
  root: string,
  seen: {
    subdirectories: number;
    foreign: number;
    skipped?: readonly SkippedFile[];
    unmounted?: boolean;
  },
): MMError {
  const refused = seen.skipped ?? [];
  const parts: string[] = [];
  if (seen.subdirectories > 0) parts.push(`${String(seen.subdirectories)} subfolder(s)`);
  if (seen.foreign > 0) parts.push(`${String(seen.foreign)} file(s) in another format`);
  if (refused.length > 0) parts.push(`${String(refused.length)} file(s) it could not read`);
  const hint =
    (parts.length === 0 ? "The folder is empty. " : `It holds ${parts.join(", ")}. `) +
    (seen.subdirectories > 0
      ? "A folder of album folders is a library, not a release — import each album folder. "
      : "") +
    (refused.length > 0 && seen.unmounted === true
      ? "Every file was unreadable and this folder is outside the library mount, so the " +
        "toolbox container almost certainly cannot see it: set `MM_ADOPT_PATH` and mount it " +
        "read-only at the same path in `web`, `worker` and `toolbox` (docs/deploy.md). "
      : "") +
    `The containers the tagger can write to are: ${[...TAGGABLE_SUFFIXES].sort().join(", ")}.`;
  return new MMError("FOLDER_NO_AUDIO", `There is nothing importable in \`${asked}\`.`, {
    hint,
    action: "Check the folder",
    details: {
      folder: root,
      subdirectories: seen.subdirectories,
      otherFormats: seen.foreign,
      unreadable: refused.map((file) => ({ name: file.name, reason: file.reason })),
    },
    status: 400,
  });
}
