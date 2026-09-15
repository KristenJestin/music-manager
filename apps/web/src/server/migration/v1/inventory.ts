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
 *    that share a **release MBID**, which is the decision v1 had already made per track;
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
import {
  reconcile,
  recordingMbidOf,
  releaseMbidOf,
  type Reconciliation,
  type ScannedFile,
} from "./reconcile.ts";
import { albumKeyOf } from "./seed.ts";
import { identifiersOf } from "./schema.ts";
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

/** How `groupAlbums` decided what an album is. */
export type AlbumGrouping = "release" | "tags";

/** One of the v1 folders an album's tracks are spread over, with how many are in it. */
export interface PlannedFolder {
  readonly folder: string;
  readonly tracks: number;
}

/** A file the folder consolidation would move, library-relative on both ends. */
export interface PlannedMove {
  readonly songId: number;
  readonly from: string;
  readonly to: string;
}

/**
 * An album is a set of v1 rows that share a **release MBID**.
 *
 * `groupedBy` says which of the two rules produced it, because the two behave differently
 * afterwards: a `release_mbid` album is looked up in `library_albums` by its release, moves
 * its files into one folder and takes its title from the release; a `tags` album is the old
 * folder-bound grouping, kept only for the rows v1 never matched at all.
 */
export interface PlannedAlbum {
  readonly key: string;
  readonly groupedBy: "release_mbid" | "tags";
  /** The folder holding the most tracks — where the album lands, and where the moves go. */
  readonly folder: string;
  /** Every v1 folder the tracks are in today, most populated first. */
  readonly folders: readonly PlannedFolder[];
  /** The consolidation the plan would perform. Empty with `keepFolders`. */
  readonly moves: readonly PlannedMove[];
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
  /** Present rows with no release MBID anywhere, which is why any `tags` album exists. */
  readonly withoutRelease: number;
  /** Present rows by the rung of `recordingMbidFor` that answered for them. */
  readonly recordings: RecordingRungs;
}

/**
 * How many present rows each rung of `recordingMbidFor` answered for.
 *
 * The counterpart of `withoutRelease`, one rung finer: a migration that loses recordings
 * loses them silently — the track is still migrated, still tagged, still filed — so the only
 * way to notice is to say, run after run, where the recordings came from. `fromTags` moving
 * is the interesting number: it is the rows whose `Songs` column was emptied after v1 tagged
 * them, and it used to be part of `none`.
 */
export interface RecordingRungs {
  /** `SongForceMetadata`, or `MusicBrainzRecordingIdForce` behind `MusicBrainzForced`. */
  readonly forced: number;
  /** `Songs.MusicBrainzRecordingId`, what v1's own lookup settled on. */
  readonly fromColumn: number;
  /** `MUSICBRAINZ_TRACKID` in the file, the copy v1 wrote at tagging time. */
  readonly fromTags: number;
  /** No recording on any rung. */
  readonly none: number;
}

/** What `planFrom` is allowed to decide differently. */
export interface PlanOptions {
  /** `release` (the default) or `tags`, the pre-P11.1 behaviour. */
  readonly groupBy?: AlbumGrouping;
  /** `--keep-folders`: plan no file move, and let the album's folder be the majority one. */
  readonly keepFolders?: boolean;
  /** Where a previous run left each row's file (`migration_v1.path`), by v1 song id. */
  readonly knownPaths?: ReadonlyMap<number, string>;
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

/** Build the plan. Pure over `(dataset, files, options)` once the probing is done. */
export function planFrom(
  dataset: V1Dataset,
  files: readonly ScannedFile[],
  options: PlanOptions = {},
): MigrationPlan {
  const reconciliation = reconcile(dataset.songs, files, {
    ...(options.knownPaths === undefined ? {} : { knownPaths: options.knownPaths }),
  });
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

  const present = songs.filter(
    (planned) => planned.file !== null && !needsImport(planned.classification),
  );

  return {
    dataset,
    files,
    reconciliation,
    songs,
    albums: groupAlbums(songs, options),
    importGroups: groupImports(songs, dataset),
    orphans: reconciliation.orphans,
    withoutRelease: present.filter((planned) => releaseMbidFor(planned) === null).length,
    recordings: countRecordings(present),
  };
}

/** Tally `recordingSourceOf` over the rows that have a file. */
export function countRecordings(songs: readonly PlannedSong[]): RecordingRungs {
  const counts = { forced: 0, fromColumn: 0, fromTags: 0, none: 0 };
  for (const planned of songs) counts[recordingSourceOf(planned)] += 1;
  return counts;
}

/**
 * Which release a v1 row is on, in the order v1 itself would have answered.
 *
 * 1. the value somebody **forced** — `MusicBrainzReleaseIdForce` behind `MusicBrainzForced`,
 *    or a `SongForceMetadata` row. `identifiersOf` applies both, in that precedence;
 * 2. `Songs.MusicBrainzReleaseId`, what v1's own lookup settled on;
 * 3. `MUSICBRAINZ_ALBUMID` in the file, which is where v1 wrote (2) at tagging time and is
 *    the only copy left when the row was cleared afterwards.
 *
 * There is no fourth rung and no guessing: a row with none of the three has no release, full
 * stop, and falls back to the tag triple.
 */
export function releaseMbidFor(planned: PlannedSong): string | null {
  const fromRow = identifiersOf(planned.song, planned.forces).releaseMbid;
  if (fromRow !== null) return fromRow;
  return planned.file === null ? null : releaseMbidOf(planned.file.tags);
}

/**
 * Which recording a v1 row is, in the order v1 itself would have answered.
 *
 * The exact ladder of `releaseMbidFor`, one identifier over:
 *
 * 1. the value somebody **forced** — a `SongForceMetadata` row, then
 *    `MusicBrainzRecordingIdForce` behind `MusicBrainzForced`. `identifiersOf` applies both,
 *    in that precedence;
 * 2. `Songs.MusicBrainzRecordingId`, what v1's own lookup settled on;
 * 3. **`MUSICBRAINZ_TRACKID` in the file**, which is where v1 wrote (2) at tagging time
 *    (`ProcessSongJob.ApplyID3TagsInternal`: `Tag.MusicBrainzTrackId = MusicBrainzRecordingId`)
 *    and is the only copy left when the row was cleared afterwards. Picard's confusing name —
 *    that key holds the *recording* id, not the release-track id — and v2's tag map follows
 *    Picard, so the same key means the same thing on both sides of the migration.
 *
 * The third rung is what `reconcile` has always read to *match* a file to a row; until it was
 * read here too, a row whose column had been emptied matched its file perfectly and then had
 * its recording thrown away — `import_tracks.recording_mbid` came out null, `documents.build`
 * had nothing to look up, and the track was rebuilt from its release alone.
 *
 * There is no fourth rung and no guessing.
 */
export function recordingMbidFor(planned: PlannedSong): string | null {
  const fromRow = identifiersOf(planned.song, planned.forces).recordingMbid;
  if (fromRow !== null) return fromRow;
  return planned.file === null ? null : recordingMbidOf(planned.file.tags);
}

/** Which rung of `recordingMbidFor` answered for this row. */
export function recordingSourceOf(planned: PlannedSong): keyof RecordingRungs {
  const ids = identifiersOf(planned.song, planned.forces);
  if (ids.recordingMbid !== null) {
    return ids.forced.includes("MusicBrainzRecordingId") ? "forced" : "fromColumn";
  }
  if (planned.file !== null && recordingMbidOf(planned.file.tags) !== null) return "fromTags";
  return "none";
}

/**
 * Group the rows that have a file into albums.
 *
 * **The album is the release MBID.** Every v1 row that was ever matched carries one - forced,
 * resolved, or written into the file as `MUSICBRAINZ_ALBUMID` - and v1 already decided which
 * release each track is on. So the grouping key *is* that MBID: one `library_albums` row per
 * release, every track keeping its own recording MBID, and no second opinion. There is no vote
 * and no "the first track's release wins", because there is nothing left to arbitrate.
 *
 * That replaces the old key, v1's (album artist, album, year) triple plus the folder, which
 * invented albums for a living: each v1 song matched MusicBrainz *independently*, so the tracks
 * of one release routinely disagreed about the album artist ("Various Artists" against the
 * composer), about the year, and therefore about the folder v1 filed them in. Two v1 playlists
 * came out as four v2 albums, each rebuilt from a different release.
 *
 * The triple survives for exactly one case: a row with **no release MBID at all**, which v1
 * never matched and about which nothing but its own tags is known.
 * `MigrationPlan.withoutRelease` counts those, so the report can say how much of the library
 * is in that state.
 *
 * The folder is then the one holding the most tracks, and the minority files are moved into it
 * unless `keepFolders` says otherwise - see `PlannedAlbum.moves`.
 */
function groupAlbums(songs: readonly PlannedSong[], options: PlanOptions): PlannedAlbum[] {
  const byRelease = (options.groupBy ?? "release") === "release";
  const buckets = new Map<string, PlannedSong[]>();

  for (const planned of songs) {
    if (planned.file === null || needsImport(planned.classification)) continue;
    const release = byRelease ? releaseMbidFor(planned) : null;
    const key =
      release === null
        ? `tags:${albumKeyOf(planned.song)} ${folderOf(planned.file.path).toLowerCase()}`
        : `release:${release}`;
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
    const groupedBy = key.startsWith("release:") ? "release_mbid" : "tags";
    const folders = foldersOf(sorted);
    const folder = folders[0]?.folder ?? folderOf(first.file.path);
    albums.push({
      key,
      groupedBy,
      folder,
      folders,
      moves: options.keepFolders === true ? [] : movesInto(sorted, folder),
      // Only a seed. `execute.ts` overwrites the three from the rebuilt documents, which is
      // where the *release's* title, album artist and year come from. Taking them from the
      // first track's v1 tags is exactly the habit this grouping exists to end.
      artist: song.albumArtists[0] ?? song.artist ?? "Unknown Artist",
      title: song.album ?? "Unknown Album",
      year: song.year,
      // The key itself when there is one - never `firstOf`, which was "take the first track's
      // release and hope" and is what rebuilt one playlist from four different releases.
      releaseMbid:
        groupedBy === "release_mbid"
          ? key.slice("release:".length)
          : firstOf(sorted, (item) => identifiersOf(item.song, item.forces).releaseMbid),
      releaseGroupMbid: firstOf(
        sorted,
        (item) => identifiersOf(item.song, item.forces).releaseGroupMbid,
      ),
      tracks: sorted,
      sourceUrl: commonParent(sorted) ?? song.sourceUrl,
    });
  }

  /*
   * Folder first, then **the fuller album**, then the key.
   *
   * The middle term is what decides who keeps the plain folder name when two releases of one
   * record render the same one: `execute.freeFolder` gives the first comer
   * `Imagine Dragons/Smoke + Mirrors (2015)` and the next one
   * `… (2015) [6ace8918]`, so processing the twenty-track release before the two-track bonus
   * edition is the difference between a suffix nobody sees and a suffix on the album everybody
   * opens. The key still breaks the tie, so the order is total and the same on every run.
   */
  return albums.sort(
    (left, right) =>
      left.folder.localeCompare(right.folder) ||
      right.tracks.length - left.tracks.length ||
      left.key.localeCompare(right.key),
  );
}

/**
 * The folders an album's tracks are in, most populated first.
 *
 * A tie is broken by the folder name so that two runs over one library always choose the same
 * majority. A consolidation that oscillated between two folders of equal size would move every
 * file on every run, and each move costs a Navidrome play count.
 */
export function foldersOf(tracks: readonly PlannedSong[]): PlannedFolder[] {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    if (track.file === null) continue;
    const folder = folderOf(track.file.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts]
    .map(([folder, count]) => ({ folder, tracks: count }))
    .sort((left, right) => right.tracks - left.tracks || left.folder.localeCompare(right.folder));
}

/** The moves that would put every track of an album in `folder`. */
export function movesInto(tracks: readonly PlannedSong[], folder: string): PlannedMove[] {
  const out: PlannedMove[] = [];
  for (const track of tracks) {
    if (track.file === null) continue;
    const from = track.file.path;
    if (folderOf(from) === folder) continue;
    out.push({ songId: track.song.id, from, to: `${folder}/${baseOf(from)}` });
  }
  return out;
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

/** `Artist/Album (2001)/01 - Title.opus` → `01 - Title.opus`. */
export function baseOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
