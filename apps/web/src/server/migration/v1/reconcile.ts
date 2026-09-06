/**
 * Tying the files on disk back to the rows in the v1 database (§ Étapes 1).
 *
 * Three keys, tried in order, because each is weaker than the one before it:
 *
 *  1. **`FinalFilePath`** — what v1 says it wrote. Right almost always, and wrong in exactly
 *     the cases that matter: somebody moved a folder, restored from a backup, or renamed an
 *     album by hand after v1 had finished with it.
 *  2. **The recording MBID in the file.** v1 wrote the *recording* id into TagLib's
 *     `MusicBrainzTrackId`, which lands in `MUSICBRAINZ_TRACKID` on Opus — which is also where
 *     v2 writes it, because that is Picard's (confusing) name for the recording id and the tag
 *     map follows Picard. So the key is the same on both sides, and `MUSICBRAINZ_RECORDINGID`
 *     is only read as a courtesy to files tagged by something else. A recording is unique per
 *     row in practice but not by construction (two v1 rows can point at one recording), so a
 *     tie is reported rather than guessed at.
 *  3. **The YouTube id in the comment.** v1 overwrote `COMMENT` wholesale with
 *     `Source: <url>`, which makes it the only provenance a v1 file carries. It survives a
 *     rename, a move and a metadata refresh, and it is the key that rescues a file whose MBID
 *     lookup failed in v1 — which is most of the interesting ones.
 *
 * Everything here is pure: files in, matches out. The probing that produces the input is in
 * `run.ts`, so this whole decision is testable without a filesystem or a toolbox.
 */
import type { MigrationMatch } from "#/server/db/schema/migration.ts";
import { pathKey, predictV1Path, type V1Platform } from "./paths.ts";
import { sourceVideoId, videoIdFromUrl, type V1Song } from "./schema.ts";

/** One audio file found under the v1 library, with every tag `/probe` reported. */
export interface ScannedFile {
  /** Library-relative, forward slashes. */
  readonly path: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly sizeBytes?: number;
  readonly durationSeconds?: number;
  readonly hasPicture?: boolean;
}

export interface SongFileMatch {
  readonly songId: number;
  readonly file: ScannedFile;
  readonly matchedBy: MigrationMatch;
}

/** Something that does not add up, and that the report must show rather than swallow. */
export interface Discrepancy {
  readonly kind:
    "path_moved" | "missing_file" | "orphan_file" | "duplicate_claim" | "recording_conflict";
  readonly songId: number | null;
  readonly path: string | null;
  readonly detail: string;
}

export interface Reconciliation {
  readonly matches: readonly SongFileMatch[];
  /** Files under the v1 library that no v1 row claims. */
  readonly orphans: readonly ScannedFile[];
  /** v1 row ids with no file at all. */
  readonly withoutFile: readonly number[];
  readonly discrepancies: readonly Discrepancy[];
}

/**
 * The recording MBID a v1 file carries.
 *
 * `MUSICBRAINZ_RECORDINGID` first, then `MUSICBRAINZ_TRACKID` — which is where both v1 and
 * v2 put the recording id, following Picard. The first key only ever appears on files tagged
 * by something outside this lineage, and preferring it costs nothing.
 */
export function recordingMbidOf(tags: Readonly<Record<string, string>>): string | null {
  const upper = upperKeys(tags);
  for (const key of ["MUSICBRAINZ_RECORDINGID", "MUSICBRAINZ_TRACKID"]) {
    const value = upper.get(key);
    if (value !== undefined && value.trim() !== "") return value.trim().toLowerCase();
  }
  return null;
}

/** The video id hiding in v1's `COMMENT`, which is always `Source: <url>`. */
export function commentVideoId(tags: Readonly<Record<string, string>>): string | null {
  const upper = upperKeys(tags);
  for (const key of ["COMMENT", "DESCRIPTION", "MUSICMANAGER_SOURCEURL"]) {
    const value = upper.get(key);
    if (value === undefined) continue;
    const url = /^\s*Source:\s*(\S+)/i.exec(value)?.[1] ?? value;
    const id = videoIdFromUrl(url);
    if (id !== null) return id;
  }
  return null;
}

function upperKeys(tags: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string") out.set(key.toUpperCase(), value);
  }
  return out;
}

export interface ReconcileOptions {
  /** Which `Path.GetInvalidFileNameChars()` the v1 worker ran with. Linux in practice. */
  readonly platform?: V1Platform;
  readonly extension?: string;
}

/**
 * Reconcile a set of v1 rows against a set of files.
 *
 * A file is claimed at most once and a row matches at most one file: the first key that hits
 * wins, and every later claim on an already-taken file becomes a `duplicate_claim` rather
 * than silently overwriting the first. That asymmetry is on purpose — two rows pointing at
 * one file is a real thing in a v1 database (the same video added to two playlists), and the
 * migration must adopt the file once and turn the other row into a report line, not into a
 * second library track over the same path.
 */
export function reconcile(
  songs: readonly V1Song[],
  files: readonly ScannedFile[],
  options: ReconcileOptions = {},
): Reconciliation {
  const byPath = new Map<string, ScannedFile>();
  const byRecording = new Map<string, ScannedFile[]>();
  const byVideo = new Map<string, ScannedFile[]>();

  for (const file of files) {
    const key = pathKey(file.path);
    if (key !== null) byPath.set(key, file);
    const recording = recordingMbidOf(file.tags);
    if (recording !== null) push(byRecording, recording, file);
    const video = commentVideoId(file.tags);
    if (video !== null) push(byVideo, video, file);
  }

  const claimed = new Map<string, number>();
  const matches: SongFileMatch[] = [];
  const discrepancies: Discrepancy[] = [];
  const withoutFile: number[] = [];

  for (const song of songs) {
    const found = locate(song, { byPath, byRecording, byVideo }, options);

    if (found === null) {
      withoutFile.push(song.id);
      if (song.downloadStatus === "Present") {
        discrepancies.push({
          kind: "missing_file",
          songId: song.id,
          path: song.finalFilePath,
          detail: `v1 says Present but no file matches ${song.finalFilePath ?? "(no path)"}.`,
        });
      }
      continue;
    }

    const owner = claimed.get(found.file.path);
    if (owner !== undefined) {
      discrepancies.push({
        kind: "duplicate_claim",
        songId: song.id,
        path: found.file.path,
        detail: `v1 song ${String(song.id)} claims the same file as song ${String(owner)}; it becomes an import instead.`,
      });
      withoutFile.push(song.id);
      continue;
    }

    claimed.set(found.file.path, song.id);
    matches.push({ songId: song.id, file: found.file, matchedBy: found.matchedBy });

    if (found.matchedBy !== "path" && song.finalFilePath !== null) {
      discrepancies.push({
        kind: "path_moved",
        songId: song.id,
        path: found.file.path,
        detail: `v1 recorded ${song.finalFilePath}; the file was found at ${found.file.path} (matched by ${found.matchedBy}).`,
      });
    }

    const fileRecording = recordingMbidOf(found.file.tags);
    const rowRecording = song.musicBrainzRecordingId;
    if (fileRecording !== null && rowRecording !== null && fileRecording !== rowRecording) {
      discrepancies.push({
        kind: "recording_conflict",
        songId: song.id,
        path: found.file.path,
        detail: `the file says recording ${fileRecording}, the row says ${rowRecording}; the row wins.`,
      });
    }
  }

  const orphans = files.filter((file) => !claimed.has(file.path));
  for (const orphan of orphans) {
    discrepancies.push({
      kind: "orphan_file",
      songId: null,
      path: orphan.path,
      detail: "no v1 row claims this file.",
    });
  }

  return { matches, orphans, withoutFile, discrepancies };
}

interface Indexes {
  readonly byPath: ReadonlyMap<string, ScannedFile>;
  readonly byRecording: ReadonlyMap<string, readonly ScannedFile[]>;
  readonly byVideo: ReadonlyMap<string, readonly ScannedFile[]>;
}

function locate(
  song: V1Song,
  indexes: Indexes,
  options: ReconcileOptions,
): { file: ScannedFile; matchedBy: MigrationMatch } | null {
  /* 1 · the path v1 recorded, then the path v1's own algorithm would produce. */
  for (const candidate of [song.finalFilePath, predicted(song, options)]) {
    const key = pathKey(candidate);
    if (key === null) continue;
    const file = indexes.byPath.get(key);
    if (file !== undefined) return { file, matchedBy: "path" };
  }

  /* 2 · the recording MBID the file carries. Ambiguity is not a match. */
  const recording = song.musicBrainzRecordingId ?? song.musicBrainzRecordingIdForce;
  if (recording !== null) {
    const candidates = indexes.byRecording.get(recording) ?? [];
    if (candidates.length === 1 && candidates[0] !== undefined) {
      return { file: candidates[0], matchedBy: "recording_mbid" };
    }
  }

  /* 3 · the YouTube id in the comment — the only provenance a v1 file carries. */
  const video = sourceVideoId(song);
  if (video !== null) {
    const candidates = indexes.byVideo.get(video) ?? [];
    if (candidates.length === 1 && candidates[0] !== undefined) {
      return { file: candidates[0], matchedBy: "youtube_id" };
    }
  }

  return null;
}

function predicted(song: V1Song, options: ReconcileOptions): string | null {
  const parts = predictV1Path(song, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.extension === undefined ? {} : { extension: options.extension }),
  });
  return parts === null ? null : parts.path;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}
