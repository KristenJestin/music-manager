/**
 * Step 1 of the migration: find out what there is (§ Étapes 1).
 *
 * Nothing here writes anything, anywhere — not to the v2 database, not to the v1 database,
 * not to disk. That is what makes `--dry-run` an honest preview rather than a code path that
 * has to remember to skip things: the dry run *is* this file, and the executor is what the
 * real run adds afterwards.
 *
 * The inventory produces one plan, and the plan is the whole decision:
 *
 *  - which v1 rows have a file, and which file (`reconcile.ts`);
 *  - which albums those files form — v1 has no album entity, so an album is the set of rows
 *    that agree on artist, title and year, which is exactly what v1's own path generator used;
 *  - which rows have no file, and which parent playlist groups them into one v2 import.
 */
import { existsSync } from "node:fs";
import { MMError } from "@mm/contracts";
import type { MigrationClass } from "#/server/db/schema/migration.ts";
import { toPosix, type PathMap } from "#/server/paths.ts";
import { walkLibrary } from "#/server/services/scan.ts";
import type { ToolboxClient } from "#/server/toolbox/client.ts";
import { containerPath, hostPath } from "#/server/paths.ts";
import { classify, needsImport } from "./classify.ts";
import { reconcile, type Reconciliation, type ScannedFile } from "./reconcile.ts";
import { albumKeyOf } from "./seed.ts";
import type { V1Dataset, V1ForceMetadata, V1Song } from "./schema.ts";

/** One v1 song with everything the executor needs to act on it. */
export interface PlannedSong {
  readonly song: V1Song;
  readonly forces: readonly V1ForceMetadata[];
  readonly classification: MigrationClass;
  /** The file this row owns, library-relative. `null` for everything that becomes an import. */
  readonly file: ScannedFile | null;
  readonly matchedBy: "path" | "recording_mbid" | "youtube_id" | "none";
}

/** An album is a set of v1 rows whose files sit in one folder. */
export interface PlannedAlbum {
  readonly key: string;
  /** Library-relative folder every track of the album is in. */
  readonly folder: string;
  readonly artist: string;
  readonly title: string;
  readonly year: number | null;
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly tracks: readonly PlannedSong[];
  /** The v1 parent URL, when the rows agree on one — the import's `url`. */
  readonly sourceUrl: string;
}

/** The rows with no file, grouped as they will be imported (§ Étapes 4). */
export interface PlannedImportGroup {
  readonly key: string;
  /** Name of the v1 parent playlist, or `null` for songs that had none. */
  readonly playlist: string | null;
  readonly url: string;
  readonly kind: "album" | "single" | "playlist";
  readonly songs: readonly PlannedSong[];
}

export interface MigrationPlan {
  readonly dataset: V1Dataset;
  readonly files: readonly ScannedFile[];
  readonly reconciliation: Reconciliation;
  readonly songs: readonly PlannedSong[];
  readonly albums: readonly PlannedAlbum[];
  readonly importGroups: readonly PlannedImportGroup[];
  /** Files under the v1 library that no v1 row claims. */
  readonly orphans: readonly ScannedFile[];
}

export interface InventoryOptions {
  readonly dataset: V1Dataset;
  readonly paths: PathMap;
  /** The v1 library, library-relative to the v2 root. `""` when they are the same directory. */
  readonly libraryPrefix: string;
  readonly toolbox: ToolboxClient;
  readonly signal?: AbortSignal;
  readonly say?: (message: string, data?: Record<string, unknown>) => Promise<void>;
  /** Cap on the number of files probed. Guards against pointing this at `/`. */
  readonly fileLimit?: number;
}

/**
 * Where the v1 library sits inside the v2 library.
 *
 * The toolbox only sees what is under `MM_LIBRARY_ROOT`, so a v1 library outside it cannot be
 * probed, tagged or ReplayGained however correct the path is on this side of the bridge. That
 * is not a limitation to work around: keeping the v1 paths (§ Étapes 3) means the v1 library
 * *becomes* the v2 library, so the two roots being the same directory is the normal case and
 * anything else is a mistake worth naming early.
 */
export function libraryPrefixOf(paths: PathMap, v1Library: string): string {
  const host = toPosix(paths.host).replace(/\/+$/, "");
  const target = toPosix(v1Library).replace(/\/+$/, "");
  if (target.toLowerCase() === host.toLowerCase()) return "";
  if (target.toLowerCase().startsWith(`${host.toLowerCase()}/`)) {
    return `${target.slice(host.length + 1)}/`;
  }
  throw new MMError(
    "INVALID_INPUT",
    "The v1 library must be the v2 library root, or a directory inside it.",
    {
      hint:
        `v1 library: ${target}\n` +
        `v2 library root (MM_LIBRARY_ROOT): ${host}\n` +
        "Migration keeps the v1 paths, so the two are the same directory in a real migration; " +
        "the toolbox can only read files under the v2 root.",
      action: "Set MM_LIBRARY_ROOT to the v1 library",
    },
  );
}

/**
 * Walk the v1 library and read every file's tags.
 *
 * `/probe` already returns every tag present and whether the file carries a picture (P07b),
 * so no toolbox change is needed here — the endpoint the phase asks to extend was extended by
 * the phase before it.
 */
export async function probeLibrary(options: InventoryOptions): Promise<ScannedFile[]> {
  const root = hostPath(options.paths, options.libraryPrefix);
  if (!existsSync(root)) {
    throw new MMError("NOT_FOUND", `The v1 library ${root} does not exist.`, {
      action: "Check --library",
    });
  }

  const walked = walkLibrary(root, options.fileLimit ?? 200_000);
  const out: ScannedFile[] = [];

  for (const [index, entry] of walked.entries()) {
    options.signal?.throwIfAborted();
    const relative = `${options.libraryPrefix}${entry.path}`;
    try {
      const probe = await options.toolbox.probe(containerPath(options.paths, relative));
      out.push({
        path: relative,
        tags: probe.tags ?? {},
        sizeBytes: probe.size,
        ...(probe.duration === null || probe.duration === undefined
          ? {}
          : { durationSeconds: probe.duration }),
        hasPicture: probe.has_picture,
      });
    } catch (error) {
      // An unreadable file is a finding, not a stop: it comes out as an orphan with no tags.
      out.push({ path: relative, tags: {}, sizeBytes: entry.size });
      await options.say?.(
        `could not probe ${relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ((index + 1) % 25 === 0) {
      await options.say?.(`probed ${String(index + 1)}/${String(walked.length)} file(s)`, {
        probed: index + 1,
        total: walked.length,
      });
    }
  }

  return out;
}

/** Build the plan. Pure over `(dataset, files)` once the probing is done. */
export function planFrom(dataset: V1Dataset, files: readonly ScannedFile[]): MigrationPlan {
  const reconciliation = reconcile(dataset.songs, files);
  const matchBySong = new Map(reconciliation.matches.map((match) => [match.songId, match]));

  const songs: PlannedSong[] = dataset.songs.map((song) => {
    const match = matchBySong.get(song.id) ?? null;
    return {
      song,
      forces: dataset.forces.get(song.id) ?? [],
      classification: classify({ song, hasFile: match !== null }),
      file: match?.file ?? null,
      matchedBy: match?.matchedBy ?? "none",
    };
  });

  return {
    dataset,
    files,
    reconciliation,
    songs,
    albums: groupAlbums(songs),
    importGroups: groupImports(songs, dataset),
    orphans: reconciliation.orphans,
  };
}

/**
 * Group the rows that have a file into albums.
 *
 * The grouping key is v1's own (album artist, album, year) triple, and the folder is the
 * directory the files are actually in. When the two disagree — two folders for one triple,
 * because somebody moved half an album — the folder wins and the album is split, because the
 * folder is what Navidrome groups by and a `library_albums` row whose tracks live in two
 * directories would be a lie in the one place it matters.
 */
function groupAlbums(songs: readonly PlannedSong[]): PlannedAlbum[] {
  const buckets = new Map<string, PlannedSong[]>();

  for (const planned of songs) {
    if (planned.file === null || needsImport(planned.classification)) continue;
    const folder = folderOf(planned.file.path);
    const key = `${albumKeyOf(planned.song)} ${folder.toLowerCase()}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [planned]);
    else bucket.push(planned);
  }

  const albums: PlannedAlbum[] = [];
  for (const [key, tracks] of buckets) {
    const sorted = [...tracks].sort(byPosition);
    const first = sorted[0];
    if (first === undefined || first.file === null) continue;
    const song = first.song;
    albums.push({
      key,
      folder: folderOf(first.file.path),
      artist: song.albumArtists[0] ?? song.artist ?? "Unknown Artist",
      title: song.album ?? "Unknown Album",
      year: song.year,
      releaseMbid: firstOf(sorted, (item) => item.song.musicBrainzReleaseId),
      releaseGroupMbid: firstOf(sorted, (item) => item.song.musicBrainzReleaseGroupId),
      tracks: sorted,
      sourceUrl: commonParent(sorted) ?? song.sourceUrl,
    });
  }

  return albums.sort((left, right) => left.folder.localeCompare(right.folder));
}

/**
 * Group the rows that have no file into imports, by parent playlist (§ Étapes 4).
 *
 * v1 records the playlist a song came from twice: `SourceUrlParent` (the YouTube playlist it
 * was discovered in) and `UserPlaylists` (the lists its owner made). The first is what an
 * import *is* in v2 — a URL that resolves to several videos — so it is the grouping key, and
 * the second only supplies the display name.
 */
function groupImports(songs: readonly PlannedSong[], dataset: V1Dataset): PlannedImportGroup[] {
  const playlistNames = playlistNamesBySong(dataset);
  const buckets = new Map<string, PlannedSong[]>();

  for (const planned of songs) {
    if (!needsImport(planned.classification)) continue;
    const parent = planned.song.sourceUrlParent;
    const key = parent ?? `single:${String(planned.song.id)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [planned]);
    else bucket.push(planned);
  }

  const groups: PlannedImportGroup[] = [];
  for (const [key, members] of buckets) {
    const sorted = [...members].sort(byPosition);
    const first = sorted[0];
    if (first === undefined) continue;
    const parent = first.song.sourceUrlParent;
    groups.push({
      key,
      playlist: playlistNames.get(first.song.id) ?? null,
      url: parent ?? first.song.sourceUrl,
      kind: parent === null ? "single" : sorted.length > 1 ? "playlist" : "album",
      songs: sorted,
    });
  }

  return groups.sort((left, right) => left.key.localeCompare(right.key));
}

function playlistNamesBySong(dataset: V1Dataset): Map<number, string> {
  const byId = new Map(dataset.playlists.map((playlist) => [playlist.id, playlist.name]));
  const out = new Map<number, string>();
  for (const link of dataset.playlistSongs) {
    if (out.has(link.songId)) continue;
    const name = byId.get(link.playlistId);
    if (name !== undefined) out.set(link.songId, name);
  }
  return out;
}

function byPosition(left: PlannedSong, right: PlannedSong): number {
  const disc = (left.song.discNumber ?? 1) - (right.song.discNumber ?? 1);
  if (disc !== 0) return disc;
  const track = (left.song.trackNumber ?? 0) - (right.song.trackNumber ?? 0);
  if (track !== 0) return track;
  return left.song.id - right.song.id;
}

function firstOf(
  songs: readonly PlannedSong[],
  pick: (song: PlannedSong) => string | null,
): string | null {
  for (const song of songs) {
    const value = pick(song);
    if (value !== null) return value;
  }
  return null;
}

/** The parent URL every row of an album agrees on, or `null` when they do not. */
function commonParent(songs: readonly PlannedSong[]): string | null {
  const parents = new Set(songs.map((item) => item.song.sourceUrlParent ?? ""));
  if (parents.size !== 1) return null;
  const only = [...parents][0] ?? "";
  return only === "" ? null : only;
}

export function folderOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
