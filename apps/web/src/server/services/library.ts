/**
 * The library, read and maintained (`docs/07-ui.md`, pages `/library*`).
 *
 * `library_albums` and `library_tracks` describe **what is on disk**. Everything richer — the
 * tags, their provenance, the completeness — lives in `metadata_documents`, because a document
 * is a fact about a recording and a library row is a fact about a file. Keeping them apart is
 * what lets a file be deleted without losing the metadata that would let it be rebuilt, and
 * what lets a document be re-projected without touching a row.
 *
 * The queries here are written to be **flat**: an album list of two hundred albums is three
 * queries, not two hundred. Anything per-row that needs a document is fed from one batched
 * read and scored in memory by `quality.service`.
 *
 * The destructive operations (delete, re-download) are deliberately explicit and narrow. A
 * delete removes the files it can name and the rows that point at them, and it says how many
 * of each; it never walks a directory looking for things to remove.
 */
import { existsSync, rmSync, readdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { field, projectDocument, type ProfileId, type TrackDocument } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  artistsCache,
  decisions,
  imports,
  importTracks,
  jobEvents,
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type Import,
  type ImportTrack,
  type LibraryAlbum,
  type LibraryTrack,
} from "#/server/db/schema/index.ts";
import { containerPath, hostPath } from "#/server/paths.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { retryStep } from "#/server/services/jobs/index.ts";
import { diffProjection, formatOf, type ProjectionDiff } from "#/server/services/retag.ts";
import {
  documentsOfTracks,
  scoreAlbum,
  scoreLibrary,
  summarise,
  tagMapRows,
  type AlbumQuality,
  type LibraryQualityStats,
  type TagMapRow,
} from "#/server/services/quality.ts";
import { effectiveSchemaVersion, isSchemaOverridden } from "#/server/services/schema-version.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* the album grid                                                      */
/* ------------------------------------------------------------------ */

export const ALBUM_FILTERS = [
  "all",
  "incomplete",
  "untagged",
  "nocover",
  "ytcover",
  "schema",
] as const;
export type AlbumFilter = (typeof ALBUM_FILTERS)[number];

export const ALBUM_SORTS = ["recent", "artist", "year", "score"] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];

export interface AlbumCard {
  readonly id: string;
  readonly title: string;
  readonly albumArtist: string;
  readonly year: number | null;
  readonly folder: string;
  readonly coverPath: string | null;
  readonly releaseMbid: string | null;
  readonly trackCount: number;
  readonly presentCount: number;
  readonly addedAt: string;
  readonly quality: AlbumQuality;
}

export interface AlbumGridPayload {
  readonly albums: readonly AlbumCard[];
  readonly counts: Readonly<Record<AlbumFilter, number>>;
  readonly stats: LibraryQualityStats;
  readonly profile: ProfileId | "global";
}

function passesAlbumFilter(card: AlbumCard, filter: AlbumFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "incomplete":
      return card.presentCount < card.trackCount;
    case "untagged":
      return card.quality.untagged;
    case "nocover":
      return card.coverPath === null;
    case "ytcover":
      return card.quality.youtubeCover;
    case "schema":
      return card.quality.filesBehind > 0;
  }
}

function matchesSearch(card: AlbumCard, search: string): boolean {
  if (search === "") return true;
  const needle = search.toLowerCase();
  return (
    card.title.toLowerCase().includes(needle) ||
    card.albumArtist.toLowerCase().includes(needle) ||
    (card.releaseMbid ?? "").toLowerCase().includes(needle)
  );
}

/** `/library` — the grid, its filter counts and the library-wide numbers above it. */
export async function albumGrid(
  options: {
    search?: string;
    filter?: AlbumFilter;
    sort?: AlbumSort;
    profile?: ProfileId | "global";
  } = {},
  db: Database = defaultDb(),
): Promise<AlbumGridPayload> {
  const settings = await loadSettings(db);
  const { rows, currentSchema } = await scoreLibrary({ db, settings });
  const profile = options.profile ?? "global";

  const cards: AlbumCard[] = rows.map(({ album, quality }) => ({
    id: album.id,
    title: album.title,
    albumArtist: album.albumArtist,
    year: album.year,
    folder: album.folder,
    coverPath: album.coverPath,
    releaseMbid: album.releaseMbid,
    trackCount: album.trackCount,
    presentCount: album.presentCount,
    addedAt: album.createdAt.toISOString(),
    quality,
  }));

  const counts = Object.fromEntries(
    ALBUM_FILTERS.map((filter) => [
      filter,
      cards.filter((card) => passesAlbumFilter(card, filter)).length,
    ]),
  ) as Record<AlbumFilter, number>;

  const filter = options.filter ?? "all";
  const sort = options.sort ?? "recent";
  const search = (options.search ?? "").trim();

  const shown = cards
    .filter((card) => passesAlbumFilter(card, filter) && matchesSearch(card, search))
    .sort((a, b) => {
      switch (sort) {
        case "artist":
          return a.albumArtist.localeCompare(b.albumArtist) || a.title.localeCompare(b.title);
        case "year":
          return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
        case "score":
          return (a.quality.score ?? 1) - (b.quality.score ?? 1);
        case "recent":
          return b.addedAt.localeCompare(a.addedAt);
      }
    });

  return {
    albums: shown,
    counts,
    stats: summarise(rows, currentSchema, isSchemaOverridden(settings)),
    profile,
  };
}

/* ------------------------------------------------------------------ */
/* one album                                                           */
/* ------------------------------------------------------------------ */

export interface AlbumTrackRow {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
  readonly path: string;
  readonly format: string | null;
  readonly size: number | null;
  readonly duration: number | null;
  readonly recordingMbid: string | null;
  readonly trackMbid: string | null;
  readonly tagSchemaVersion: number | null;
  readonly present: boolean;
  /** The YouTube video the file came from, when an import produced it. */
  readonly videoId: string | null;
  readonly importId: string | null;
  readonly importTrackId: string | null;
  readonly hasLyrics: boolean;
  readonly hasReplayGain: boolean;
  readonly score: number | null;
}

export interface AlbumIdentifiers {
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly artistMbid: string | null;
  readonly barcode: string | null;
  readonly catalogNumber: string | null;
  readonly label: string | null;
  readonly country: string | null;
  readonly media: string | null;
  readonly releaseType: string | null;
  readonly genres: readonly string[];
}

export interface MatchingDecision {
  readonly decidedBy: string;
  readonly at: string;
  readonly choice: Record<string, unknown>;
}

export interface AlbumDetail {
  readonly album: LibraryAlbum;
  readonly tracks: readonly AlbumTrackRow[];
  readonly quality: AlbumQuality;
  readonly identifiers: AlbumIdentifiers;
  readonly tagMap: readonly TagMapRow[];
  readonly imports: readonly { id: string; url: string; status: string; createdAt: string }[];
  readonly decision: MatchingDecision | null;
  readonly currentSchema: number;
  readonly schemaOverridden: boolean;
  readonly sizeBytes: number;
}

/** Read one string field of a document. The documents hold typed values; the UI wants text. */
function text(document: TrackDocument | null, field: string): string | null {
  if (document === null) return null;
  const value = document.fields[field]?.value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function strings(document: TrackDocument | null, field: string): string[] {
  if (document === null) return [];
  const value = document.fields[field]?.value;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export async function albumDetail(
  albumId: string,
  db: Database = defaultDb(),
): Promise<AlbumDetail | null> {
  const settings = await loadSettings(db);
  const currentSchema = effectiveSchemaVersion(settings);

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) return null;

  const tracks = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId))
    .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);

  const loaded = await documentsOfTracks(tracks, db);
  const quality = scoreAlbum(album, loaded, currentSchema);
  const documents = loaded
    .map((entry) => entry.document)
    .filter((document): document is TrackDocument => document !== null);
  const first = documents[0] ?? null;

  /* The import tracks, for the YouTube ids the file column links to. */
  const importTrackIds = tracks
    .map((track) => track.importTrackId)
    .filter((id): id is string => id !== null);
  const sources =
    importTrackIds.length === 0
      ? []
      : await db.select().from(importTracks).where(inArray(importTracks.id, importTrackIds));
  const bySource = new Map(sources.map((row) => [row.id, row]));

  const importIds = [
    ...new Set(tracks.map((track) => track.importId).filter((id): id is string => id !== null)),
  ];
  const jobs =
    importIds.length === 0
      ? []
      : await db.select().from(imports).where(inArray(imports.id, importIds));

  const scoreByTrack = new Map(quality.tracks.map((track) => [track.libraryTrackId, track]));

  const rows: AlbumTrackRow[] = tracks.map((track) => {
    const scored = scoreByTrack.get(track.id);
    const source = track.importTrackId === null ? undefined : bySource.get(track.importTrackId);
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      path: track.path,
      format: track.format,
      size: track.size,
      duration: track.duration,
      recordingMbid: track.recordingMbid,
      trackMbid: track.trackMbid,
      tagSchemaVersion: track.tagSchemaVersion,
      present: true,
      videoId: source?.videoId ?? null,
      importId: track.importId,
      importTrackId: track.importTrackId,
      hasLyrics: scored?.hasLyrics ?? false,
      hasReplayGain: scored?.hasReplayGain ?? false,
      score: scored?.score ?? null,
    };
  });

  /* The matching decision that chose this release, if one was recorded. */
  const decision =
    importIds.length === 0
      ? null
      : ((
          await db
            .select()
            .from(decisions)
            .where(and(inArray(decisions.importId, importIds), eq(decisions.kind, "release")))
            .orderBy(desc(decisions.createdAt))
            .limit(1)
        )[0] ?? null);

  return {
    album,
    tracks: rows,
    quality,
    identifiers: {
      releaseMbid: album.releaseMbid,
      releaseGroupMbid: album.releaseGroupMbid,
      artistMbid: text(first, "musicbrainz_albumartistid") ?? text(first, "musicbrainz_artistid"),
      barcode: text(first, "barcode"),
      catalogNumber: text(first, "catalognumber"),
      label: text(first, "label"),
      country: text(first, "releasecountry"),
      media: text(first, "media"),
      releaseType: text(first, "releasetype"),
      genres: strings(first, "genre"),
    },
    tagMap: tagMapRows(documents),
    imports: jobs.map((job) => ({
      id: job.id,
      url: job.url,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
    })),
    decision:
      decision === null
        ? null
        : {
            decidedBy: decision.decidedBy,
            at: decision.createdAt.toISOString(),
            choice: decision.choice,
          },
    currentSchema,
    schemaOverridden: isSchemaOverridden(settings),
    sizeBytes: tracks.reduce((total, track) => total + (track.size ?? 0), 0),
  };
}

/** One track's document, for the Metadata tab and the track page. */
export async function documentOfLibraryTrack(
  libraryTrackId: string,
  db: Database = defaultDb(),
): Promise<TrackDocument | null> {
  const [row] = await db
    .select({ document: metadataDocuments.document })
    .from(metadataDocuments)
    .where(eq(metadataDocuments.libraryTrackId, libraryTrackId))
    .limit(1);
  return row === undefined ? null : (row.document as unknown as TrackDocument);
}

/* ------------------------------------------------------------------ */
/* DB vs files                                                         */
/* ------------------------------------------------------------------ */

export interface FileComparison {
  readonly libraryTrackId: string;
  readonly path: string;
  readonly exists: boolean;
  readonly diff: ProjectionDiff | null;
  readonly error: string | null;
}

/**
 * Read the files back and say where they disagree with the database.
 *
 * This is the honest version of "drift": everything else in the app compares hashes, which
 * tells you that *we* changed our mind. Only `/probe` tells you that something changed the
 * file — Picard, a phone, a well-meaning script.
 *
 * It costs one toolbox round trip per file, so it is a tab you open, never something a list
 * page does on your behalf.
 */
export async function compareWithFiles(
  albumId: string,
  options: { db?: Database; toolbox?: ToolboxClient; limit?: number } = {},
): Promise<FileComparison[]> {
  const db = options.db ?? defaultDb();
  const toolbox = options.toolbox ?? defaultToolbox();
  const settings = await loadSettings(db);
  const paths = resolvePaths(settings);

  const tracks = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId))
    .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber)
    .limit(options.limit ?? 100);

  const loaded = await documentsOfTracks(tracks, db);
  const out: FileComparison[] = [];

  for (const entry of loaded) {
    const track = entry.track;
    const absolute = hostPath(paths, track.path);
    if (!existsSync(absolute)) {
      out.push({
        libraryTrackId: track.id,
        path: track.path,
        exists: false,
        diff: null,
        error: "The file is not on disk.",
      });
      continue;
    }
    if (entry.document === null) {
      out.push({
        libraryTrackId: track.id,
        path: track.path,
        exists: true,
        diff: null,
        error: "No document: nothing to compare the file with.",
      });
      continue;
    }
    try {
      const probe = await toolbox.probe(containerPath(paths, track.path));
      const projected = projectDocument(entry.document, formatOf(track.path));
      out.push({
        libraryTrackId: track.id,
        path: track.path,
        exists: true,
        diff: diffProjection(projected, probe.tags ?? {}),
        error: null,
      });
    } catch (error) {
      out.push({
        libraryTrackId: track.id,
        path: track.path,
        exists: true,
        diff: null,
        error: MMError.from(error).message,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

/** Every journal line of every import that put a file in this album, newest last. */
export async function albumHistory(
  albumId: string,
  options: { limit?: number } = {},
  db: Database = defaultDb(),
): Promise<(typeof jobEvents.$inferSelect)[]> {
  const rows = await db
    .select({ importId: libraryTracks.importId })
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId));
  const importIds = [
    ...new Set(rows.map((row) => row.importId).filter((id): id is string => id !== null)),
  ];
  if (importIds.length === 0) return [];
  return await db
    .select()
    .from(jobEvents)
    .where(inArray(jobEvents.importId, importIds))
    .orderBy(jobEvents.id)
    .limit(options.limit ?? 400);
}

/* ------------------------------------------------------------------ */
/* the tracks page                                                     */
/* ------------------------------------------------------------------ */

export const TRACK_FILTERS = ["all", "nolyrics", "noreplaygain", "schema", "untagged"] as const;
export type TrackFilter = (typeof TRACK_FILTERS)[number];

export interface TrackRow {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly albumId: string | null;
  readonly albumTitle: string | null;
  readonly trackNumber: number | null;
  readonly duration: number | null;
  readonly format: string | null;
  readonly size: number | null;
  readonly path: string;
  readonly recordingMbid: string | null;
  readonly tagSchemaVersion: number | null;
  readonly behind: boolean;
  readonly hasLyrics: boolean;
  readonly hasReplayGain: boolean;
  readonly score: number | null;
  readonly addedAt: string;
}

export interface TrackListPayload {
  readonly tracks: readonly TrackRow[];
  readonly total: number;
  readonly counts: Readonly<Record<TrackFilter, number>>;
  readonly currentSchema: number;
}

/**
 * `/library/tracks`.
 *
 * Scored in memory like the album grid, for the same reason: the score of a track is a pure
 * function of its document, and asking the database to compute it would mean teaching the
 * database the tag map.
 */
export async function trackList(
  options: { search?: string; filter?: TrackFilter; limit?: number; offset?: number } = {},
  db: Database = defaultDb(),
): Promise<TrackListPayload> {
  const settings = await loadSettings(db);
  const currentSchema = effectiveSchemaVersion(settings);

  const tracks = await db.select().from(libraryTracks).orderBy(desc(libraryTracks.createdAt));
  const albums = await db.select().from(libraryAlbums);
  const albumById = new Map(albums.map((album) => [album.id, album]));
  const loaded = await documentsOfTracks(tracks, db);

  const scored = new Map<string, { score: number | null; lyrics: boolean; rg: boolean }>();
  for (const album of albums) {
    const own = loaded.filter((entry) => entry.track.albumId === album.id);
    if (own.length === 0) continue;
    for (const track of scoreAlbum(album, own, currentSchema).tracks) {
      scored.set(track.libraryTrackId, {
        score: track.score,
        lyrics: track.hasLyrics,
        rg: track.hasReplayGain,
      });
    }
  }

  const rows: TrackRow[] = tracks.map((track) => {
    const album = track.albumId === null ? undefined : albumById.get(track.albumId);
    const detail = scored.get(track.id);
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      albumId: track.albumId,
      albumTitle: album?.title ?? null,
      trackNumber: track.trackNumber,
      duration: track.duration,
      format: track.format,
      size: track.size,
      path: track.path,
      recordingMbid: track.recordingMbid,
      tagSchemaVersion: track.tagSchemaVersion,
      behind: track.tagSchemaVersion === null || track.tagSchemaVersion < currentSchema,
      hasLyrics: detail?.lyrics ?? false,
      hasReplayGain: detail?.rg ?? false,
      score: detail?.score ?? null,
      addedAt: track.createdAt.toISOString(),
    };
  });

  const passes = (row: TrackRow, filter: TrackFilter): boolean => {
    switch (filter) {
      case "all":
        return true;
      case "nolyrics":
        return !row.hasLyrics;
      case "noreplaygain":
        return !row.hasReplayGain;
      case "schema":
        return row.behind;
      case "untagged":
        return row.recordingMbid === null;
    }
  };

  const search = (options.search ?? "").trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      passes(row, options.filter ?? "all") &&
      (search === "" ||
        row.title.toLowerCase().includes(search) ||
        (row.artist ?? "").toLowerCase().includes(search) ||
        (row.albumTitle ?? "").toLowerCase().includes(search) ||
        (row.recordingMbid ?? "").toLowerCase().includes(search) ||
        row.path.toLowerCase().includes(search)),
  );

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 60;

  return {
    tracks: filtered.slice(offset, offset + limit),
    total: filtered.length,
    counts: Object.fromEntries(
      TRACK_FILTERS.map((filter) => [filter, rows.filter((row) => passes(row, filter)).length]),
    ) as Record<TrackFilter, number>,
    currentSchema,
  };
}

/* ------------------------------------------------------------------ */
/* one track                                                           */
/* ------------------------------------------------------------------ */

export interface TrackDetail {
  readonly track: LibraryTrack;
  readonly album: LibraryAlbum | null;
  readonly document: TrackDocument | null;
  readonly source: ImportTrack | null;
  readonly job: Import | null;
  readonly score: number | null;
  readonly byProfile: Readonly<Record<ProfileId, number | null>>;
  readonly missing: readonly string[];
  readonly behind: boolean;
  readonly currentSchema: number;
  readonly lyrics: string | null;
}

export async function trackDetail(
  trackId: string,
  db: Database = defaultDb(),
): Promise<TrackDetail | null> {
  const settings = await loadSettings(db);
  const currentSchema = effectiveSchemaVersion(settings);

  const [track] = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.id, trackId))
    .limit(1);
  if (track === undefined) return null;

  const [album] =
    track.albumId === null
      ? []
      : await db.select().from(libraryAlbums).where(eq(libraryAlbums.id, track.albumId)).limit(1);

  const document = await documentOfLibraryTrack(track.id, db);

  const [source] =
    track.importTrackId === null
      ? []
      : await db
          .select()
          .from(importTracks)
          .where(eq(importTracks.id, track.importTrackId))
          .limit(1);

  const [job] =
    track.importId === null
      ? []
      : await db.select().from(imports).where(eq(imports.id, track.importId)).limit(1);

  const scored =
    album === undefined || document === null
      ? null
      : scoreAlbum(album, [{ track, document, storedHash: track.projectionHash }], currentSchema)
          .tracks[0];

  const held = document?.fields["lyrics"]?.value;
  const lyrics =
    typeof held === "object" && held !== null && !Array.isArray(held)
      ? ((held as { synced?: string | null; plain?: string | null }).synced ??
        (held as { plain?: string | null }).plain ??
        null)
      : null;

  return {
    track,
    album: album ?? null,
    document,
    source: source ?? null,
    job: job ?? null,
    score: scored?.score ?? null,
    byProfile:
      scored?.byProfile ??
      (Object.fromEntries(
        (["navidrome", "jellyfin", "plex", "kodi", "lms", "players"] as const).map((id) => [
          id,
          null,
        ]),
      ) as Record<ProfileId, null>),
    missing: scored?.missing ?? [],
    behind: track.tagSchemaVersion === null || track.tagSchemaVersion < currentSchema,
    currentSchema,
    lyrics,
  };
}

/* ------------------------------------------------------------------ */
/* artists                                                             */
/* ------------------------------------------------------------------ */

export interface ArtistRow {
  readonly name: string;
  readonly mbid: string | null;
  readonly country: string | null;
  readonly imageUrl: string | null;
  readonly albums: number;
  readonly tracks: number;
  readonly sortName: string | null;
}

/**
 * The artists of the library.
 *
 * Grouped by `library_albums.album_artist` rather than by MBID, because that string is what
 * the *folders* are named after — an artist page that disagreed with the directory tree would
 * be describing a different library. The MBID and the image come from `artists_cache` when a
 * document knew one.
 */
export async function artistList(
  options: { search?: string } = {},
  db: Database = defaultDb(),
): Promise<ArtistRow[]> {
  const grouped = await db
    .select({
      name: libraryAlbums.albumArtist,
      albums: sql<number>`count(distinct ${libraryAlbums.id})::int`,
    })
    .from(libraryAlbums)
    .groupBy(libraryAlbums.albumArtist)
    .orderBy(libraryAlbums.albumArtist);

  const trackCounts = await db
    .select({
      name: libraryAlbums.albumArtist,
      tracks: sql<number>`count(${libraryTracks.id})::int`,
    })
    .from(libraryAlbums)
    .leftJoin(libraryTracks, eq(libraryTracks.albumId, libraryAlbums.id))
    .groupBy(libraryAlbums.albumArtist);
  const byName = new Map(trackCounts.map((row) => [row.name, row.tracks]));

  const cached = await db.select().from(artistsCache);
  const cacheByName = new Map(cached.map((row) => [row.name.toLowerCase(), row]));

  const search = (options.search ?? "").trim().toLowerCase();
  return grouped
    .filter((row) => search === "" || row.name.toLowerCase().includes(search))
    .map((row) => {
      const entry = cacheByName.get(row.name.toLowerCase());
      return {
        name: row.name,
        mbid: entry?.artistMbid ?? null,
        country: entry?.country ?? null,
        imageUrl: entry?.imageUrl ?? null,
        sortName: entry?.sortName ?? null,
        albums: row.albums,
        tracks: byName.get(row.name) ?? 0,
      };
    });
}

/* ------------------------------------------------------------------ */
/* destructive operations                                              */
/* ------------------------------------------------------------------ */

export interface DeleteResult {
  readonly files: number;
  readonly sidecars: number;
  readonly rows: number;
  readonly folder: string | null;
}

/** Remove one file, its `.lrc`, and the row that pointed at them. */
function unlinkTrackFiles(host: string, relative: string): { files: number; sidecars: number } {
  let files = 0;
  let sidecars = 0;
  const audio = `${host}/${relative}`;
  if (existsSync(audio)) {
    rmSync(audio, { force: true });
    files += 1;
  }
  const lrc = `${host}/${relative.replace(/\.[^./]+$/, ".lrc")}`;
  if (existsSync(lrc)) {
    rmSync(lrc, { force: true });
    sidecars += 1;
  }
  return { files, sidecars };
}

/**
 * Delete an album: its files, its sidecars, its rows.
 *
 * The album *folder* is removed only if it is empty afterwards. Anything else in there —
 * a booklet, a `.nfo` somebody wrote, a stray file — belongs to whoever put it there, and a
 * delete that takes it with them is a delete nobody trusts twice.
 *
 * The documents go with the tracks (`metadata_documents.library_track_id` cascades), but the
 * **raw cache stays**: §1 never purges it, which is exactly what makes re-importing this album
 * later free of network traffic.
 */
export async function deleteAlbum(
  albumId: string,
  db: Database = defaultDb(),
): Promise<DeleteResult> {
  const settings = await loadSettings(db);
  const paths = resolvePaths(settings);

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) throw new MMError("NOT_FOUND", `No album with id ${albumId}.`);

  const tracks = await db.select().from(libraryTracks).where(eq(libraryTracks.albumId, albumId));

  let files = 0;
  let sidecars = 0;
  for (const track of tracks) {
    const removed = unlinkTrackFiles(paths.host, track.path);
    files += removed.files;
    sidecars += removed.sidecars;
  }

  const cover = hostPath(paths, `${album.folder}/cover.jpg`);
  if (existsSync(cover)) {
    rmSync(cover, { force: true });
    sidecars += 1;
  }

  await db.delete(libraryAlbums).where(eq(libraryAlbums.id, albumId));

  const folder = hostPath(paths, album.folder);
  let removedFolder: string | null = null;
  if (existsSync(folder) && readdirSync(folder).length === 0) {
    rmdirSync(folder);
    removedFolder = album.folder;
    // The artist folder too, if this was their last album.
    const parent = dirname(folder);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  }

  return { files, sidecars, rows: tracks.length + 1, folder: removedFolder };
}

/** Delete one track. Same rules, one file. */
export async function deleteTrack(
  trackId: string,
  db: Database = defaultDb(),
): Promise<DeleteResult> {
  const settings = await loadSettings(db);
  const paths = resolvePaths(settings);

  const [track] = await db
    .select()
    .from(libraryTracks)
    .where(eq(libraryTracks.id, trackId))
    .limit(1);
  if (track === undefined) throw new MMError("NOT_FOUND", `No library track with id ${trackId}.`);

  const removed = unlinkTrackFiles(paths.host, track.path);
  await db.delete(libraryTracks).where(eq(libraryTracks.id, trackId));

  if (track.albumId !== null) await refreshAlbumCounts(track.albumId, db);
  return { ...removed, rows: 1, folder: null };
}

/** Keep `present_count` honest after a delete. */
export async function refreshAlbumCounts(albumId: string, db: Database = defaultDb()) {
  const [row] = await db
    .select({ present: sql<number>`count(*)::int` })
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId));
  await db
    .update(libraryAlbums)
    .set({ presentCount: row?.present ?? 0, updatedAt: new Date() })
    .where(eq(libraryAlbums.id, albumId));
}

/* ------------------------------------------------------------------ */
/* re-download                                                         */
/* ------------------------------------------------------------------ */

export interface RedownloadPlan {
  readonly importId: string;
  readonly tracks: number;
}

/**
 * Ask for these files to be fetched again, **keeping the mapping**.
 *
 * That is the whole requirement: the video, the recording it was bound to and the position it
 * sits at are already decided and must not be decided again. So the import track goes back to
 * `pending` with its `role`, `recording_mbid` and `track_position` untouched, the library file
 * is removed, and the job is rewound to `download` — which is the one step that will notice
 * there is nothing on disk.
 */
export async function planRedownload(
  target: { albumId?: string; trackId?: string },
  db: Database = defaultDb(),
): Promise<RedownloadPlan[]> {
  const settings = await loadSettings(db);
  const paths = resolvePaths(settings);

  const rows = await db
    .select()
    .from(libraryTracks)
    .where(
      target.trackId !== undefined
        ? eq(libraryTracks.id, target.trackId)
        : eq(libraryTracks.albumId, target.albumId ?? ""),
    );

  const byImport = new Map<string, number>();
  for (const track of rows) {
    if (track.importId === null || track.importTrackId === null) continue;
    const absolute = hostPath(paths, track.path);
    if (existsSync(absolute)) rmSync(absolute, { force: true });
    await db
      .update(importTracks)
      .set({
        state: "pending",
        downloadPath: null,
        libraryPath: null,
        downloadedBytes: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(importTracks.id, track.importTrackId));
    byImport.set(track.importId, (byImport.get(track.importId) ?? 0) + 1);
  }

  for (const importId of byImport.keys()) {
    await retryStep(importId, "download", { db, only: false });
  }

  return [...byImport.entries()].map(([importId, tracks]) => ({ importId, tracks }));
}

/* ------------------------------------------------------------------ */
/* which import a "change release" would re-run                        */
/* ------------------------------------------------------------------ */

/**
 * The import behind an album, if there is exactly one.
 *
 * "Change release" is not a new mechanism: it is the import wizard's step 2, pointed at an
 * import that already exists. Re-picking a release there re-runs `match` against the new
 * tracklist, and the rest of the pipeline follows — which is precisely what changing a release
 * means, and precisely what P06 already built and tested. So this returns the id the Console
 * links to rather than reimplementing the wizard behind a button.
 */
export async function importBehindAlbum(
  albumId: string,
  db: Database = defaultDb(),
): Promise<string | null> {
  const rows = await db
    .select({ importId: libraryTracks.importId })
    .from(libraryTracks)
    .where(and(eq(libraryTracks.albumId, albumId), isNotNull(libraryTracks.importId)));
  // The newest import wins when an album was filled by more than one: that is the job whose
  // release the wizard would be re-picking, and the one whose mapping the rest describes.
  const ids = [...new Set(rows.map((row) => row.importId))].filter(
    (id): id is string => id !== null,
  );
  return ids.sort().at(-1) ?? null;
}

/* ------------------------------------------------------------------ */
/* the cover picker                                                    */
/* ------------------------------------------------------------------ */

export interface CoverOption {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly source: "coverartarchive" | "youtube" | "current";
  readonly kind: string;
}

/**
 * Where a front cover could come from, in the order §4 prefers them.
 *
 * Only the *candidates* are listed here; nothing is fetched until one is chosen. The Cover Art
 * Archive index is already in the raw cache for any album that was imported, so this is
 * usually offline; the YouTube thumbnails come from the verbatim `import_tracks.raw` that
 * `resolve` kept, which always is.
 */
export async function coverOptions(
  albumId: string,
  options: { db?: Database } = {},
): Promise<CoverOption[]> {
  const db = options.db ?? defaultDb();
  const detail = await albumDetail(albumId, db);
  if (detail === null) throw new MMError("NOT_FOUND", `No album with id ${albumId}.`);

  const out: CoverOption[] = [];

  const document = await (async (): Promise<TrackDocument | null> => {
    const first = detail.tracks[0];
    return first === undefined ? null : await documentOfLibraryTrack(first.id, db);
  })();

  const front = document?.fields["front_cover"]?.value;
  if (Array.isArray(front)) {
    for (const picture of front) {
      if (typeof picture !== "object" || picture === null) continue;
      const url = (picture as { url?: unknown }).url;
      const kind = (picture as { kind?: unknown }).kind;
      if (typeof url !== "string") continue;
      out.push({
        id: `current:${url}`,
        url,
        label: `Current (${document?.fields["front_cover"]?.source ?? "unknown"})`,
        source: "current",
        kind: typeof kind === "string" ? kind : "front",
      });
    }
  }

  /* Cover Art Archive: front and back of the release, from the cached index. */
  if (detail.album.releaseMbid !== null && detail.album.releaseMbid !== "") {
    const { index: caaIndex, imagesOfType, urlOf } = await import(
      "#/server/integrations/coverartarchive.ts"
    );
    const { sourcesConfig } = await import("#/server/integrations/config.ts");
    const settings = await loadSettings(db);
    try {
      const answer = await caaIndex(
        { db, config: sourcesConfig(settings), offline: true, refresh: false },
        detail.album.releaseMbid,
      );
      for (const type of ["Front", "Back"] as const) {
        for (const image of imagesOfType(answer.data, type)) {
          const url = urlOf(image, 1200) ?? urlOf(image, "original");
          if (url === null) continue;
          out.push({
            id: `caa:${type}:${url}`,
            url,
            label: `Cover Art Archive · ${type.toLowerCase()}`,
            source: "coverartarchive",
            kind: type.toLowerCase(),
          });
        }
      }
    } catch {
      // Offline and not cached: the archive simply offers nothing. Not an error worth a page.
    }
  }

  /* YouTube thumbnails, from what `resolve` kept verbatim. */
  const sourceIds = detail.tracks
    .map((track) => track.importTrackId)
    .filter((id): id is string => id !== null)
    .slice(0, 4);
  if (sourceIds.length > 0) {
    const rows = await db
      .select()
      .from(importTracks)
      .where(inArray(importTracks.id, sourceIds));
    const { youtubeThumbnail } = await import("#/server/services/documents.ts");
    for (const row of rows) {
      const url = youtubeThumbnail(row.raw as never);
      if (url === null) continue;
      out.push({
        id: `youtube:${row.videoId}`,
        url,
        label: `YouTube · ${row.sourceTitle}`,
        source: "youtube",
        kind: "front",
      });
    }
  }

  /* One entry per URL: the same image offered twice is not two choices. */
  const seen = new Set<string>();
  return out.filter((option) => (seen.has(option.url) ? false : (seen.add(option.url), true)));
}

/**
 * Choose a cover: prepare it, write `cover.jpg`, and record the choice in every document.
 *
 * The document is the source of truth, so the *choice* is written there — `front_cover` with
 * the chosen URL — and the file on disk is a projection of it, produced by `/artwork/prepare`
 * (square crop, resize, JPEG). The embedded picture follows on the next re-tag, which is
 * offered right after.
 */
export async function setCover(
  albumId: string,
  url: string,
  options: { db?: Database; toolbox?: ToolboxClient } = {},
): Promise<{ path: string; bytes: number; tracks: number }> {
  const db = options.db ?? defaultDb();
  const toolbox = options.toolbox ?? defaultToolbox();
  const settings = await loadSettings(db);
  const paths = resolvePaths(settings);

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) throw new MMError("NOT_FOUND", `No album with id ${albumId}.`);

  const prepared = await toolbox.prepareArtwork({ url, size: settings.artworkSize });
  const relative = `${album.folder}/cover.jpg`;
  const target = hostPath(paths, relative);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dirname(target), { recursive: true });
  const buffer = Buffer.from(prepared.data_base64, "base64");
  writeFileSync(target, buffer);

  const tracks = await db.select().from(libraryTracks).where(eq(libraryTracks.albumId, albumId));
  const loaded = await documentsOfTracks(tracks, db);
  const chosenAt = new Date().toISOString();
  let patched = 0;
  for (const entry of loaded) {
    if (entry.document === null) continue;
    const next: TrackDocument = {
      ...entry.document,
      fields: {
        ...entry.document.fields,
        // `app` and `locked`: this is a person's choice, and §1 says a person's choice is
        // never overwritten by a later resolver run. That is what `lock` means here.
        front_cover: field(
          [{ kind: "front" as const, url, mimeType: prepared.mime }],
          "app",
          chosenAt,
          { locked: true },
        ),
      },
    };
    await db
      .update(metadataDocuments)
      .set({
        document: next as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(metadataDocuments.libraryTrackId, entry.track.id));
    patched += 1;
  }

  await db
    .update(libraryAlbums)
    .set({ coverPath: relative, updatedAt: new Date() })
    .where(eq(libraryAlbums.id, albumId));

  return { path: relative, bytes: buffer.byteLength, tracks: patched };
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

/** Albums that have at least one file behind the current schema. */
export async function albumsBehindSchema(
  db: Database = defaultDb(),
  settings?: Settings,
): Promise<string[]> {
  const resolved = settings ?? (await loadSettings(db));
  const current = effectiveSchemaVersion(resolved);
  const rows = await db
    .selectDistinct({ albumId: libraryTracks.albumId })
    .from(libraryTracks)
    .where(
      or(
        sql`${libraryTracks.tagSchemaVersion} is null`,
        sql`${libraryTracks.tagSchemaVersion} < ${current}`,
      ),
    );
  return rows.map((row) => row.albumId).filter((id): id is string => id !== null);
}
