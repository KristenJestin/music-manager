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
  albumScopeConsistency,
  albumScopeRule,
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

/**
 * One album-scope field whose tracks do not agree — and what that costs.
 *
 * The fourth test report's §1: the album scored 0.9529 while every track scored 0.9929, and
 * nothing in `get_album` said why. `divergentFields` was already computed and thrown away;
 * this is the same fact with the two things a reader needs — the values in presence, and the
 * one action that repairs them.
 */
export interface DivergentField {
  readonly field: string;
  readonly vorbis: string;
  /** One entry per distinct value, with the 1-based track numbers that carry it. */
  readonly values: readonly { readonly value: string; readonly tracks: readonly number[] }[];
  /** The disc a medium-scoped divergence sits on; `null` for an album-wide field. */
  readonly medium: number | null;
  /** What the album's value would be, in one line (`albumscope/rules.ts`). */
  readonly rule: string;
  /** The remedy. Always `RETAG_ACTION`: the resolution is offline and needs no source. */
  readonly action: string;
  /** What this field costs the album's score. */
  readonly penalty: number;
}

/**
 * The remedy for a divergence: re-project the files from the documents.
 *
 * A constant rather than a string typed four times, because MCP's `retag`, `POST /retag` and
 * the album page's button are the same operation, and a test asserts the three agree.
 */
export const RETAG_ACTION = "Re-tag";

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
  /** The mean of the tracks' own scores, before the divergence penalty. */
  readonly meanTrackScore: number | null;
  readonly divergentFields: readonly string[];
  /** The same divergences, with the values in presence and the action that repairs them. */
  readonly divergences: readonly DivergentField[];
  /** What the divergences cost the album's score — `meanTrackScore - score`. */
  readonly penalty: number;
  readonly missing: readonly MissingField[];
  readonly naCount: number;
  readonly trackCount: number;
  readonly presentCount: number;
  readonly documentCount: number;
  /**
   * How many of this album's files the **last scan** could not find on disk.
   *
   * Distinct from `trackCount - presentCount`, which is "incomplete": an album can be missing
   * a track because it was never imported (the release has thirteen and the playlist had
   * eleven), and that is a different problem with a different remedy. This one means the file
   * *was* there and is not any more — a re-download that keeps the mapping, not a new import
   * (DRIVE-1 §B5).
   */
  readonly missingCount: number;
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
  /**
   * Which rung of `docs/03-metadonnees.md` §4's cover ladder the picture on disk came from
   * (decision 168), verbatim from the document — `Cover Art Archive · this release (…)`,
   * `… · release group (…)`, `… · another release of the group (…)`, or
   * `YouTube thumbnail, cropped square`. `null` for an album with no cover at all.
   *
   * `youtubeCover` answers "is it a thumbnail"; this answers the question the fifth owner
   * review actually asked, which is *where did this picture come from* — because three of the
   * four rungs are the same source and were until now indistinguishable.
   */
  readonly coverProvenance: string | null;
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

/**
 * What the `source` column of the tag map names, when it names MusicBrainz.
 *
 * The whole point of splitting this out is that "Fetch from MusicBrainz" must be a *claim*
 * about where the field comes from, not a default. `originalfilename`'s source is
 * `` `<youtube id>.<ext>` ``, and telling a reader to fetch it from MusicBrainz — which the
 * old `return` at the bottom did for every unmatched field — is advice that cannot work.
 */
const MUSICBRAINZ_MARKERS = [
  "mbid",
  "recording",
  "release",
  "release-group",
  "work",
  "medium",
  "track",
  "artist",
  "url-rels",
  "mb ",
  "mb genres",
  "mb tags",
  "classical works",
];

/**
 * The label of the one action that repairs an album's own MusicBrainz identity.
 *
 * A constant rather than a string typed twice, because `refreshAlbumFromSource` is what it
 * promises and a test asserts the two agree. An action nobody implements is worse than no
 * action: it sends a reader looking for a button that is not there.
 */
export const REFRESH_ALBUM_ACTION = "Refetch from MusicBrainz";

/** A field's value comes from somewhere; that somewhere is what the "Fetch" button does. */
export function actionFor(field: string): string {
  const tag = tagByField(field);
  const source = (tag?.source ?? "").toLowerCase();
  if (source === "") return "Edit by hand";

  /* The specific non-MusicBrainz sources, each with the thing that actually refreshes it. */
  if (source.includes("lrclib")) return "Retry LRCLIB";
  if (source.includes("acoustid") || source.includes("fpcalc")) return "Fingerprint";
  if (source.includes("rsgain") || source.includes("replaygain")) return "Run ReplayGain";
  if (source.includes("last.fm") || source.includes("lastfm")) return "Fetch from Last.fm";
  if (source.includes("listenbrainz")) return "Fetch from ListenBrainz";
  if (source.includes("deezer")) return "Fetch from Deezer";
  if (source.includes("cover") || source.includes("artwork")) return "Fetch artwork";
  if (source.includes("relation") || source.includes("-rels")) return "Fetch MB relations";
  if (source.includes("yt-dlp") || source.includes("youtube")) {
    return "Comes from the source video — re-import to refresh it";
  }
  if (source.includes("local analysis")) return "Analyse the file";
  if (source === "application") return "Written by Music Manager itself — re-tag";
  if (source.includes("heuristic")) return "Derived, not fetched — edit by hand";

  /*
   * Only now may the answer be MusicBrainz, and only when the source says so. Anything left
   * over is a field nobody fetches: saying "edit by hand" is less useful than a fetch button
   * and more useful than a fetch button that does nothing.
   */
  return MUSICBRAINZ_MARKERS.some((marker) => source.includes(marker))
    ? "Fetch from MusicBrainz"
    : "Edit by hand";
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
 * The `provenance` clause the front cover carries, or `null`.
 *
 * Read off the value rather than derived from `source`, because §4's ladder has three rungs
 * that all say `coverartarchive` — decision 168 is exactly the observation that the source id
 * cannot answer "where did this cover come from". A document written before that decision has
 * no clause and answers `null`; a re-tag fills it in.
 */
function coverProvenanceOf(document: TrackDocument): string | null {
  const held = document.fields["front_cover"]?.value;
  if (!Array.isArray(held)) return null;
  const first = held[0] as { provenance?: unknown } | undefined;
  return typeof first?.provenance === "string" && first.provenance !== "" ? first.provenance : null;
}

/**
 * The album-scope divergences, named field by field with the values in presence.
 *
 * `albumScopeConsistency` reports positions in the document array; the reader wants track
 * numbers, so they are translated here against the same ordering `scoreAlbum` built. A track
 * with no document has no position, which is why the two arrays are walked in step rather than
 * indexed independently.
 */
/**
 * A multi-valued rendering, for a human.
 *
 * `canonicalValue` joins a list with U+001F, which is exactly right for comparing two values
 * and exactly wrong on a screen or in a tool's answer: it came out as
 * `house\u001felectronic\u001fdance`. The separator stays a control character where equality
 * is decided; it becomes a semicolon — the separator the tag map itself uses for a list — the
 * moment the value is shown.
 */
function readable(value: string): string {
  return value.split("\u001f").join("; ");
}

function describeDivergences(
  documents: readonly TrackDocument[],
  tracks: readonly TrackQuality[],
  penalty: number,
): DivergentField[] {
  if (documents.length < 2) return [];
  const report = albumScopeConsistency(documents);
  if (report.divergences.length === 0) return [];

  // The nth document belongs to the nth track that *has* one.
  const withDocument = tracks.filter((track) => track.hasDocument);
  const numberOf = (position: number): number =>
    withDocument[position]?.trackNumber ?? position + 1;

  const each = report.divergences.length === 0 ? 0 : penalty / report.divergences.length;

  return report.divergences.map((divergence) => {
    const tag = tagByField(divergence.field);
    return {
      field: divergence.field,
      vorbis: tag?.vorbis ?? divergence.field.toUpperCase(),
      values: divergence.values.map((entry) => ({
        value: readable(entry.value),
        tracks: entry.tracks.map(numberOf),
      })),
      medium: divergence.medium ?? null,
      rule: albumScopeRule(divergence.field).why,
      action: RETAG_ACTION,
      penalty: each,
    };
  });
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
  /**
   * The ids whose file is really on disk, when the caller has checked.
   *
   * Omit it and `presentCount` counts *rows*, which is what the grid wants: it renders
   * hundreds of albums and must not stat the whole library to do it. `albumDetail` passes the
   * set, because "13/13 present" over an empty directory is the failure this parameter exists
   * to stop — an agent read it, concluded the library was healthy, and it was not there at all.
   */
  onDisk?: ReadonlySet<string>,
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
  /*
   * The release group is missing from the *album row* even when every document has it.
   *
   * `missing` is derived from the documents, and the documents get
   * `musicbrainz_releasegroupid` from the release lookup — so an album whose
   * `release_group_mbid` column is null had nothing in `missing` to explain it. That is the
   * third test report's §4: the CHVRCHES album scored below its own tracks, the reader was
   * told only that `originalfilename` was absent, and the one field that could be fixed was
   * the one field not named. The column matters on its own: it is what the Cover Art Archive
   * falls back to when a release has no cover, and what Discover compares a discography
   * against. `REFRESH_ALBUM_ACTION` is a tool, not a slogan — see `refreshAlbumFromSource`.
   */
  const albumGroupMissing =
    album.releaseMbid !== null && album.releaseMbid !== "" && album.releaseGroupMbid === null;
  if (albumGroupMissing && !counter.has("musicbrainz_releasegroupid")) {
    counter.set("musicbrainz_releasegroupid", tracks.length);
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
        action:
          field === "musicbrainz_releasegroupid" && albumGroupMissing
            ? REFRESH_ALBUM_ACTION
            : actionFor(field),
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
    meanTrackScore: overall.meanTrackScore,
    byProfile: documents.length === 0 ? EMPTY_PROFILES : overall.byProfile,
    divergentFields: overall.divergentFields,
    divergences: describeDivergences(documents, tracks, overall.penalty),
    penalty: overall.penalty,
    missing,
    naCount: overall.na.length,
    trackCount: album.trackCount,
    presentCount:
      onDisk === undefined
        ? tracks.length
        : tracks.filter((track) => onDisk.has(track.libraryTrackId)).length,
    documentCount: documents.length,
    missingCount: loaded.filter((entry) => entry.track.missingAt !== null).length,
    schemaVersion: schemaVersions.length === 0 ? null : Math.min(...schemaVersions),
    filesBehind: tracks.filter((track) => track.behind).length,
    driftCount: tracks.filter((track) => track.drift).length,
    lyricsCount: tracks.filter((track) => track.hasLyrics).length,
    replayGainCount: tracks.filter((track) => track.hasReplayGain).length,
    untagged: album.releaseMbid === null || album.releaseMbid === "",
    youtubeCover: documents.some(isYouTubeCover),
    coverProvenance: documents.map(coverProvenanceOf).find((clause) => clause !== null) ?? null,
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
    // "Files the last scan could not find", which is not the same question as "incomplete":
    // one is a file that has gone, the other a track that was never imported (DRIVE-1 §B5).
    case "missing":
      return quality.missingCount > 0;
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
