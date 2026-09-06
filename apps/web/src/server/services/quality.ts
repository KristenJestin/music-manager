/**
 * Metadata quality, per album and over the whole library (`docs/03-metadonnees.md` §6, §8).
 *
 * One rule governs everything below: **a profile never changes what is written.** We always
 * write the superset. Scoring "as Navidrome reads it" is a *view* over the same documents —
 * it exists so that "97 % complete" can be followed by "…and 91 % of that is visible in the
 * server you actually run", which is a different and more useful sentence.
 *
 * Three numbers are worth distinguishing, because the Console shows all three and they are
 * routinely confused:
 *
 *  - **completeness** — of the fields that apply to this release, how many did the sources
 *    actually give us. A field the release says does not exist (no work relations, one disc,
 *    no explicit flag) is *n/a* and leaves the denominator rather than counting against it.
 *  - **behind schema** — the file on disk was written by an older projection. Nothing is
 *    missing from the *database*; the file simply has not caught up. `retag.service` fixes it
 *    offline, from the raw cache, without re-downloading a byte.
 *  - **drift** — the projection of the document we hold no longer hashes to what we last
 *    wrote into the file. That is as much as can be known without opening the file; the
 *    album's "DB vs files" tab opens it (through the toolbox's `/probe`) and says exactly
 *    which keys differ.
 *
 * Everything here is read-only and takes at most three queries whatever the size of the
 * library: albums, tracks, documents. Scoring is pure and happens in memory, because
 * `albumCompleteness` is a `packages/domain` function and the database has no business
 * knowing what a tag map is.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  albumCompleteness,
  LEVEL_WEIGHT,
  PROFILE_IDS,
  profileById,
  projectDocument,
  tagByField,
  TAGS,
  trackCompleteness,
  type ProfileId,
  type TagLevel,
  type TrackDocument,
} from "@mm/domain";
import { type QualityFilter } from "#/lib/library-filters.ts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type LibraryAlbum,
  type LibraryTrack,
} from "#/server/db/schema/index.ts";
import { projectionHash } from "#/server/services/jobs/steps/tag.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  effectiveSchemaVersion,
  isBehindSchema,
  isSchemaOverridden,
} from "#/server/services/schema-version.ts";

/* ------------------------------------------------------------------ */
/* shapes                                                              */
/* ------------------------------------------------------------------ */

/** One missing field, aggregated over the tracks of an album. */
export interface MissingField {
  readonly field: string;
  readonly vorbis: string;
  readonly level: TagLevel;
  /** How many of the album's tracks lack it. */
  readonly tracks: number;
  /** Where the value would come from — the tag map's own answer, so the UI can offer it. */
  readonly source: string;
  /** The button's label: what fetching this field actually means. */
  readonly action: string;
}

/** One track, scored. */
export interface TrackQuality {
  readonly libraryTrackId: string;
  readonly path: string;
  readonly title: string;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
  readonly score: number | null;
  readonly byProfile: Readonly<Record<ProfileId, number | null>>;
  readonly missing: readonly string[];
  readonly na: readonly string[];
  readonly schemaVersion: number | null;
  readonly behind: boolean;
  /** The stored projection no longer hashes to what was last written into the file. */
  readonly drift: boolean;
  readonly hasLyrics: boolean;
  readonly hasReplayGain: boolean;
  readonly hasDocument: boolean;
}

/** One album, scored — the row of `/library/quality` and the badge of `/library`. */
export interface AlbumQuality {
  readonly albumId: string;
  readonly score: number | null;
  readonly byProfile: Readonly<Record<ProfileId, number | null>>;
  readonly divergentFields: readonly string[];
  readonly missing: readonly MissingField[];
  readonly naCount: number;
  readonly trackCount: number;
  readonly presentCount: number;
  readonly documentCount: number;
  /** Lowest schema version any of its files carries — the album is only as fresh as that. */
  readonly schemaVersion: number | null;
  readonly filesBehind: number;
  readonly driftCount: number;
  readonly lyricsCount: number;
  readonly replayGainCount: number;
  /** No MusicBrainz release: imported from the YouTube tags alone (§ "import without MB"). */
  readonly untagged: boolean;
  /** The front cover came from a YouTube thumbnail rather than the Cover Art Archive. */
  readonly youtubeCover: boolean;
  readonly tracks: readonly TrackQuality[];
}

/* ------------------------------------------------------------------ */
/* reading the documents                                               */
/* ------------------------------------------------------------------ */

export interface LoadedTrack {
  readonly track: LibraryTrack;
  readonly document: TrackDocument | null;
  readonly storedHash: string | null;
}

/**
 * The documents of a set of library tracks, in one query.
 *
 * `metadata_documents.library_track_id` is filled by `place`; a track whose document is
 * attached only to its *import* track (a job that never reached `place`) is not in the
 * library, so it is not our problem here.
 */
export async function documentsOfTracks(
  tracks: readonly LibraryTrack[],
  db: Database = defaultDb(),
): Promise<LoadedTrack[]> {
  if (tracks.length === 0) return [];
  const ids = tracks.map((track) => track.id);
  const rows = await db
    .select({
      libraryTrackId: metadataDocuments.libraryTrackId,
      document: metadataDocuments.document,
      projectionHash: metadataDocuments.projectionHash,
    })
    .from(metadataDocuments)
    .where(inArray(metadataDocuments.libraryTrackId, ids));

  const byTrack = new Map(rows.map((row) => [row.libraryTrackId, row]));
  return tracks.map((track) => {
    const row = byTrack.get(track.id);
    return {
      track,
      document: row === undefined ? null : (row.document as unknown as TrackDocument),
      storedHash: row?.projectionHash ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

const EMPTY_PROFILES: Readonly<Record<ProfileId, null>> = Object.freeze(
  Object.fromEntries(PROFILE_IDS.map((id) => [id, null])) as Record<ProfileId, null>,
);

/** A field's value comes from somewhere; that somewhere is what the "Fetch" button does. */
function actionFor(field: string): string {
  const tag = tagByField(field);
  const source = tag?.source ?? "";
  if (source.includes("lrclib")) return "Retry LRCLIB";
  if (source.includes("acoustid")) return "Fingerprint";
  if (source.includes("rsgain") || source.includes("replaygain")) return "Run ReplayGain";
  if (source.includes("last.fm") || source.includes("lastfm")) return "Fetch from Last.fm";
  if (source.includes("cover") || source.includes("artwork")) return "Fetch artwork";
  if (source.includes("relation")) return "Fetch MB relations";
  return "Fetch from MusicBrainz";
}

/** True when the document carries usable lyrics — synced or plain. */
function hasLyrics(document: TrackDocument): boolean {
  const held = document.fields["lyrics"]?.value;
  if (typeof held !== "object" || held === null || Array.isArray(held)) return false;
  const value = held as { synced?: string | null; plain?: string | null };
  return (value.synced ?? value.plain ?? null) !== null;
}

function hasReplayGain(document: TrackDocument): boolean {
  return document.fields["replaygain_track_gain"] !== undefined;
}

/** Whether the front cover we hold is a YouTube thumbnail rather than a real release cover. */
function isYouTubeCover(document: TrackDocument): boolean {
  const held = document.fields["front_cover"];
  if (held === undefined) return false;
  return held.source === "youtube";
}

/**
 * Score one album from its tracks' documents.
 *
 * Pure: everything it needs has already been read. That is what lets `/library` score twenty
 * albums without twenty round trips, and what lets the unit tests check the arithmetic of §6
 * against hand-written documents.
 */
export function scoreAlbum(
  album: LibraryAlbum,
  loaded: readonly LoadedTrack[],
  currentSchema: number,
): AlbumQuality {
  const documents = loaded
    .map((entry) => entry.document)
    .filter((document): document is TrackDocument => document !== null);

  const tracks: TrackQuality[] = loaded.map((entry) => {
    const document = entry.document;
    if (document === null) {
      return {
        libraryTrackId: entry.track.id,
        path: entry.track.path,
        title: entry.track.title,
        trackNumber: entry.track.trackNumber,
        discNumber: entry.track.discNumber,
        score: null,
        byProfile: EMPTY_PROFILES,
        missing: [],
        na: [],
        schemaVersion: entry.track.tagSchemaVersion,
        behind: isBehindSchema(entry.track.tagSchemaVersion, currentSchema),
        drift: false,
        hasLyrics: false,
        hasReplayGain: false,
        hasDocument: false,
      };
    }
    const report = trackCompleteness(document);
    const byProfile = Object.fromEntries(
      PROFILE_IDS.map((id) => [id, report.byProfile[id].score]),
    ) as Record<ProfileId, number | null>;
    // What the document projects to *now*, against what was last written into the file.
    const current = projectionHash(projectDocument(document, "vorbis"));
    return {
      libraryTrackId: entry.track.id,
      path: entry.track.path,
      title: entry.track.title,
      trackNumber: entry.track.trackNumber,
      discNumber: entry.track.discNumber,
      score: report.score,
      byProfile,
      missing: report.missing,
      na: report.na,
      schemaVersion: entry.track.tagSchemaVersion,
      behind: isBehindSchema(entry.track.tagSchemaVersion, currentSchema),
      drift: entry.storedHash !== null && entry.storedHash !== current,
      hasLyrics: hasLyrics(document),
      hasReplayGain: hasReplayGain(document),
      hasDocument: true,
    };
  });

  const overall = albumCompleteness(documents);

  /* Missing fields, counted over the tracks that lack them, worst level first. */
  const counter = new Map<string, number>();
  for (const track of tracks) {
    for (const field of track.missing) counter.set(field, (counter.get(field) ?? 0) + 1);
  }
  const missing: MissingField[] = [...counter.entries()]
    .map(([field, count]) => {
      const tag = tagByField(field);
      return {
        field,
        vorbis: tag?.vorbis ?? field.toUpperCase(),
        level: tag?.level ?? "optional",
        tracks: count,
        source: tag?.source ?? "",
        action: actionFor(field),
      };
    })
    .sort(
      (a, b) =>
        LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] ||
        b.tracks - a.tracks ||
        a.field.localeCompare(b.field),
    );

  const schemaVersions = tracks
    .map((track) => track.schemaVersion)
    .filter((version): version is number => version !== null);

  return {
    albumId: album.id,
    score: overall.score,
    byProfile: documents.length === 0 ? EMPTY_PROFILES : overall.byProfile,
    divergentFields: overall.divergentFields,
    missing,
    naCount: overall.na.length,
    trackCount: album.trackCount,
    presentCount: tracks.length,
    documentCount: documents.length,
    schemaVersion: schemaVersions.length === 0 ? null : Math.min(...schemaVersions),
    filesBehind: tracks.filter((track) => track.behind).length,
    driftCount: tracks.filter((track) => track.drift).length,
    lyricsCount: tracks.filter((track) => track.hasLyrics).length,
    replayGainCount: tracks.filter((track) => track.hasReplayGain).length,
    untagged: album.releaseMbid === null || album.releaseMbid === "",
    youtubeCover: documents.some(isYouTubeCover),
    tracks,
  };
}

/* ------------------------------------------------------------------ */
/* the library, scored                                                 */
/* ------------------------------------------------------------------ */

export interface QualityRow {
  readonly album: LibraryAlbum;
  readonly quality: AlbumQuality;
}

/** Score every album. One query for the albums, one for the tracks, one for the documents. */
export async function scoreLibrary(options: {
  db?: Database;
  settings?: Settings;
  albumIds?: readonly string[];
}): Promise<{ rows: QualityRow[]; currentSchema: number }> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const currentSchema = effectiveSchemaVersion(settings);

  const albums =
    options.albumIds === undefined
      ? await db.select().from(libraryAlbums).orderBy(libraryAlbums.albumArtist)
      : options.albumIds.length === 0
        ? []
        : await db
            .select()
            .from(libraryAlbums)
            .where(inArray(libraryAlbums.id, [...options.albumIds]));

  if (albums.length === 0) return { rows: [], currentSchema };

  const ids = albums.map((album) => album.id);
  const tracks = await db
    .select()
    .from(libraryTracks)
    .where(inArray(libraryTracks.albumId, ids))
    .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);

  const loaded = await documentsOfTracks(tracks, db);
  const byAlbum = new Map<string, LoadedTrack[]>();
  for (const entry of loaded) {
    const albumId = entry.track.albumId;
    if (albumId === null) continue;
    const held = byAlbum.get(albumId);
    if (held === undefined) byAlbum.set(albumId, [entry]);
    else held.push(entry);
  }

  return {
    rows: albums.map((album) => ({
      album,
      quality: scoreAlbum(album, byAlbum.get(album.id) ?? [], currentSchema),
    })),
    currentSchema,
  };
}

/** One album, scored. The album page and the re-tag both start here. */
export async function scoreOneAlbum(
  albumId: string,
  options: { db?: Database; settings?: Settings } = {},
): Promise<QualityRow | null> {
  const { rows } = await scoreLibrary({ ...options, albumIds: [albumId] });
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* library-wide statistics                                             */
/* ------------------------------------------------------------------ */

export interface LibraryQualityStats {
  readonly albums: number;
  readonly tracks: number;
  readonly artists: number;
  /** Mean of the album scores, global. */
  readonly averageScore: number | null;
  readonly averageByProfile: Readonly<Record<ProfileId, number | null>>;
  readonly below80: number;
  readonly untagged: number;
  readonly incomplete: number;
  readonly noLyrics: number;
  readonly noReplayGain: number;
  readonly youtubeCover: number;
  readonly driftTracks: number;
  readonly filesBehind: number;
  readonly filesCurrent: number;
  readonly albumsBehind: number;
  readonly currentSchema: number;
  readonly schemaOverridden: boolean;
}

function mean(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

export function summarise(
  rows: readonly QualityRow[],
  currentSchema: number,
  schemaOverridden: boolean,
): LibraryQualityStats {
  const tracks = rows.flatMap((row) => row.quality.tracks);
  const averageByProfile = Object.fromEntries(
    PROFILE_IDS.map((id) => [id, mean(rows.map((row) => row.quality.byProfile[id]))]),
  ) as Record<ProfileId, number | null>;

  return {
    albums: rows.length,
    tracks: tracks.length,
    artists: new Set(rows.map((row) => row.album.albumArtist)).size,
    averageScore: mean(rows.map((row) => row.quality.score)),
    averageByProfile,
    below80: rows.filter((row) => row.quality.score !== null && row.quality.score < 0.8).length,
    untagged: rows.filter((row) => row.quality.untagged).length,
    incomplete: rows.filter((row) => row.quality.presentCount < row.quality.trackCount).length,
    noLyrics: tracks.filter((track) => track.hasDocument && !track.hasLyrics).length,
    noReplayGain: tracks.filter((track) => track.hasDocument && !track.hasReplayGain).length,
    youtubeCover: rows.filter((row) => row.quality.youtubeCover).length,
    driftTracks: tracks.filter((track) => track.drift).length,
    filesBehind: tracks.filter((track) => track.behind).length,
    filesCurrent: tracks.filter((track) => !track.behind).length,
    albumsBehind: rows.filter((row) => row.quality.filesBehind > 0).length,
    currentSchema,
    schemaOverridden,
  };
}

/* ------------------------------------------------------------------ */
/* the filters of /library/quality                                     */
/* ------------------------------------------------------------------ */

export {
  QUALITY_FILTERS,
  QUALITY_FILTER_LABELS,
  type QualityFilter,
} from "#/lib/library-filters.ts";

/** Whether an album passes one filter, scored through `profile` (or globally). */
export function matchesFilter(
  row: QualityRow,
  filter: QualityFilter,
  profile: ProfileId | "global",
): boolean {
  const quality = row.quality;
  const score = profile === "global" ? quality.score : quality.byProfile[profile];
  switch (filter) {
    case "all":
      return true;
    case "below80":
      return score !== null && score < 0.8;
    case "incomplete":
      return quality.presentCount < quality.trackCount;
    case "untagged":
      return quality.untagged;
    case "schema":
      return quality.filesBehind > 0;
    case "drift":
      return quality.driftCount > 0;
    case "lyrics":
      return quality.tracks.some((track) => track.hasDocument && !track.hasLyrics);
    case "ytcover":
      return quality.youtubeCover;
    case "replaygain":
      return quality.tracks.some((track) => track.hasDocument && !track.hasReplayGain);
  }
}

/* ------------------------------------------------------------------ */
/* the tag map, as the Console shows it                                */
/* ------------------------------------------------------------------ */

export type TagState = "present" | "missing" | "na" | "unknown";

/** One row of the tag-map table: the definition, plus what this album did with it. */
export interface TagMapRow {
  readonly field: string;
  readonly group: string;
  readonly vorbis: string;
  readonly id3: string | null;
  readonly mp4: string | null;
  readonly level: TagLevel;
  readonly multi: boolean;
  readonly albumScope: boolean;
  readonly source: string;
  readonly note: string;
  /** Which of the six profiles are known to read this field. */
  readonly readers: readonly ProfileId[];
  readonly state: TagState;
  /** Only for `na`: what the source said. */
  readonly reason: string | null;
  /** How many of the album's tracks carry it. */
  readonly tracks: number;
}

const READERS: ReadonlyMap<string, ProfileId[]> = new Map(
  TAGS.map((tag) => [
    tag.field,
    PROFILE_IDS.filter((id) => profileById(id).reads.includes(tag.field)),
  ]),
);

/** The whole tag map, optionally coloured by what one album actually holds. */
export function tagMapRows(documents: readonly TrackDocument[] = []): TagMapRow[] {
  return TAGS.map((tag) => {
    let present = 0;
    let na = 0;
    let reason: string | null = null;
    for (const document of documents) {
      if (tag.field in document.fields) present += 1;
      else if (tag.field in document.na) {
        na += 1;
        reason ??= document.na[tag.field]?.reason ?? null;
      }
    }
    const state: TagState =
      documents.length === 0
        ? "unknown"
        : present > 0
          ? "present"
          : na === documents.length
            ? "na"
            : "missing";
    return {
      field: tag.field,
      group: tag.group,
      vorbis: tag.vorbis,
      id3: tag.id3,
      mp4: tag.mp4,
      level: tag.level,
      multi: tag.multi,
      albumScope: tag.albumScope,
      source: tag.source,
      note: tag.note,
      readers: READERS.get(tag.field) ?? [],
      state,
      reason,
      tracks: present,
    };
  });
}

/* ------------------------------------------------------------------ */
/* the cheap counts, for the sidebar and the dashboard tile            */
/* ------------------------------------------------------------------ */

/** How many library files are behind the current schema. One `count(*)`, no documents read. */
export async function filesBehindCount(
  options: { db?: Database; settings?: Settings } = {},
): Promise<{ behind: number; total: number; currentSchema: number; overridden: boolean }> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const currentSchema = effectiveSchemaVersion(settings);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      behind: sql<number>`count(*) filter (where ${libraryTracks.tagSchemaVersion} is null or ${libraryTracks.tagSchemaVersion} < ${currentSchema})::int`,
    })
    .from(libraryTracks);

  return {
    behind: totals?.behind ?? 0,
    total: totals?.total ?? 0,
    currentSchema,
    overridden: isSchemaOverridden(settings),
  };
}

/** The library tracks a re-tag would touch, in a stable order. */
export async function tracksBehindSchema(options: {
  db?: Database;
  settings?: Settings;
  albumId?: string;
  limit?: number;
}): Promise<LibraryTrack[]> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const currentSchema = effectiveSchemaVersion(settings);
  const behind = or(
    isNull(libraryTracks.tagSchemaVersion),
    sql`${libraryTracks.tagSchemaVersion} < ${currentSchema}`,
  );
  const where =
    options.albumId === undefined
      ? and(isNotNull(libraryTracks.path), behind)
      : and(eq(libraryTracks.albumId, options.albumId), behind);

  const query = db
    .select()
    .from(libraryTracks)
    .where(where)
    .orderBy(libraryTracks.albumId, libraryTracks.discNumber, libraryTracks.trackNumber);
  return options.limit === undefined ? await query : await query.limit(options.limit);
}
