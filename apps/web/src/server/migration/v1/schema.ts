/**
 * The v1 database, described in v2's terms.
 *
 * v1 is an EF Core application (`v1/core/Data/ApplicationDbContext.cs`). Three facts about it
 * decide everything in this file, and each of them is a trap if you assume otherwise:
 *
 *  - **Identifiers are quoted PascalCase.** No snake-case convention is configured, so the
 *    tables really are `"Songs"`, `"SongForceMetadata"`, `"UserPlaylists"`,
 *    `"UserPlaylistSongs"` and every column must be double-quoted in SQL.
 *  - **Enums are strings, not Postgres enum types.** `ConfigureConventions` declares
 *    `Properties<Enum>().HaveConversion<string>()`, so `DownloadStatus` holds `'Present'`,
 *    `Platform` holds `'YouTube'` — the exact C# member spelling, capital T included.
 *  - **Three list columns are `;`-joined strings and are NOT NULL.** `Genres`, `Performers`
 *    and `AlbumArtists` round-trip an empty list as `''`, never as NULL, and the reader side
 *    of the converter is `Split(';', RemoveEmptyEntries)` with no trimming. A value containing
 *    a semicolon was already unrecoverable in v1; we inherit that, we do not invent a repair.
 *
 * Nothing here touches a connection: these are the shapes and the pure decoders, so the
 * parsing rules are unit-testable without a v1 database — which matters, because tonight
 * there is no v1 database.
 */

/* ------------------------------------------------------------------ */
/* vocabularies                                                        */
/* ------------------------------------------------------------------ */

/**
 * `v1/core/Data/Enums/SongStatus.cs`, in declaration order.
 *
 * `DownloadQueued` is commented out in v1 and was therefore never persisted; it is absent
 * here for the same reason.
 */
export const V1_SONG_STATUSES = [
  "Needed",
  "ReadyToDownload",
  "Downloading",
  "Downloaded",
  "ProcessingMetadata",
  "Present",
  "NeedsManualReview",
  "DownloadFailed",
  "MetadataFailed",
  "ProcessingFailed",
] as const;
export type V1SongStatus = (typeof V1_SONG_STATUSES)[number];

export function isV1SongStatus(value: string): value is V1SongStatus {
  return (V1_SONG_STATUSES as readonly string[]).includes(value);
}

/** `v1/core/Data/Enums/SourcePlatform.cs`. Stored as the member name, not the integer. */
export const V1_PLATFORMS = ["Unknown", "YouTube", "SoundCloud"] as const;
export type V1Platform = (typeof V1_PLATFORMS)[number];

/**
 * `ForceMetadataType`, declared inside `v1/core/Data/Entities/SongForceMetadata.cs`.
 *
 * The names are the property names of v1's `MusicMetadata`, because v1 applies an override by
 * reflecting on this string. There is deliberately no member for `Artist`, `Duration` or the
 * two `*Force` MBID columns — those are not overridable in v1 and must not be invented here.
 */
export const V1_FORCE_FIELDS = [
  "Title",
  "Subtitle",
  "Performers",
  "Album",
  "Isrc",
  "AlbumArtists",
  "Year",
  "Publisher",
  "TrackNumber",
  "TrackCount",
  "DiscNumber",
  "DiscCount",
  "Genres",
  "MusicBrainzRecordingId",
  "MusicBrainzReleaseId",
  "MusicBrainzArtistId",
  "MusicBrainzAlbumArtistId",
  "MusicBrainzReleaseGroupId",
  "MusicBrainzReleaseStatus",
  "MusicBrainzReleaseCountry",
  "CoverArtBytes",
  "CoverArtMimeType",
] as const;
export type V1ForceField = (typeof V1_FORCE_FIELDS)[number];

export function isV1ForceField(value: string): value is V1ForceField {
  return (V1_FORCE_FIELDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* rows                                                                */
/* ------------------------------------------------------------------ */

/** One `"Songs"` row, decoded. `id` is a number in v1; we keep it as a string everywhere. */
export interface V1Song {
  readonly id: number;
  readonly sourceUrl: string;
  readonly sourceUrlParent: string | null;
  readonly platform: string;
  readonly sourceId: string;
  readonly sourceIdParent: string | null;
  readonly sourceTitle: string | null;
  readonly sourceDescription: string | null;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly artist: string | null;
  readonly performers: readonly string[];
  readonly album: string | null;
  readonly isrc: string | null;
  readonly albumArtists: readonly string[];
  readonly year: number | null;
  readonly trackNumber: number | null;
  readonly trackCount: number | null;
  readonly discNumber: number | null;
  readonly discCount: number | null;
  readonly publisher: string | null;
  readonly genres: readonly string[];
  /** Milliseconds in v1 (`bigint`); the document wants seconds. Kept raw here. */
  readonly duration: number | null;
  readonly downloadStatus: string;
  /** Relative, forward slashes, without the output root. May be null before a download. */
  readonly finalFilePath: string | null;
  readonly lastAttempt: Date | null;
  readonly errorMessage: string | null;
  readonly musicBrainzRecordingId: string | null;
  readonly musicBrainzReleaseId: string | null;
  readonly musicBrainzReleaseGroupId: string | null;
  readonly musicBrainzArtistId: string | null;
  readonly musicBrainzAlbumArtistId: string | null;
  readonly musicBrainzReleaseStatus: string | null;
  readonly musicBrainzReleaseCountry: string | null;
  readonly musicBrainzForced: boolean;
  readonly musicBrainzRecordingIdForce: string | null;
  readonly musicBrainzReleaseIdForce: string | null;
  readonly forceSongMetadata: boolean;
  readonly forceSourceMetadata: boolean;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface V1ForceMetadata {
  readonly id: number;
  readonly songId: number;
  readonly field: string;
  readonly value: string;
  readonly isArrayValue: boolean;
}

export interface V1Playlist {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
}

export interface V1PlaylistSong {
  readonly playlistId: number;
  readonly songId: number;
  readonly order: number;
}

/** Everything one read of the v1 database produces. */
export interface V1Dataset {
  readonly songs: readonly V1Song[];
  /** Keyed by song id. */
  readonly forces: ReadonlyMap<number, readonly V1ForceMetadata[]>;
  readonly playlists: readonly V1Playlist[];
  readonly playlistSongs: readonly V1PlaylistSong[];
}

/* ------------------------------------------------------------------ */
/* the decoders                                                        */
/* ------------------------------------------------------------------ */

/**
 * v1's list converter, read side: `v.Split(';', StringSplitOptions.RemoveEmptyEntries)`.
 *
 * No trimming — v1 does not trim either, and a migration that quietly "cleaned" the data
 * would make the reconciliation report lie about what v1 actually held.
 */
export function splitList(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  return raw.split(";").filter((part) => part !== "");
}

/**
 * The other `;` rule: `SongForceMetadata.Value` when `IsArrayValue` is true.
 *
 * v1 uses a plain `Split(';')` here — empties are **kept** — and trims each item. The two
 * rules genuinely differ, so they are two functions rather than one with a flag; the tests
 * assert the difference, because getting it wrong silently drops or adds an artist.
 */
export function splitForcedList(raw: string): readonly string[] {
  if (raw.trim() === "") return [];
  return raw.split(";").map((part) => part.trim());
}

/** A UUID column arrives as a string or as null; normalise the empty string away too. */
export function uuidOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}

export function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Decode one raw `"Songs"` row. Written against the column names, not against ordinals. */
export function decodeSong(row: Record<string, unknown>): V1Song {
  return {
    id: intOrNull(row["Id"]) ?? 0,
    sourceUrl: String(row["SourceUrl"] ?? ""),
    sourceUrlParent: textOrNull(row["SourceUrlParent"]),
    platform: String(row["Platform"] ?? "Unknown"),
    sourceId: String(row["SourceId"] ?? ""),
    sourceIdParent: textOrNull(row["SourceIdParent"]),
    sourceTitle: textOrNull(row["SourceTitle"]),
    sourceDescription: textOrNull(row["SourceDescription"]),
    title: textOrNull(row["Title"]),
    subtitle: textOrNull(row["Subtitle"]),
    artist: textOrNull(row["Artist"]),
    performers: splitList(typeof row["Performers"] === "string" ? row["Performers"] : ""),
    album: textOrNull(row["Album"]),
    isrc: textOrNull(row["Isrc"]),
    albumArtists: splitList(typeof row["AlbumArtists"] === "string" ? row["AlbumArtists"] : ""),
    year: intOrNull(row["Year"]),
    trackNumber: intOrNull(row["TrackNumber"]),
    trackCount: intOrNull(row["TrackCount"]),
    discNumber: intOrNull(row["DiscNumber"]),
    discCount: intOrNull(row["DiscCount"]),
    publisher: textOrNull(row["Publisher"]),
    genres: splitList(typeof row["Genres"] === "string" ? row["Genres"] : ""),
    duration: intOrNull(row["Duration"]),
    downloadStatus: String(row["DownloadStatus"] ?? "Needed"),
    finalFilePath: textOrNull(row["FinalFilePath"]),
    lastAttempt: dateOrNull(row["LastAttempt"]),
    errorMessage: textOrNull(row["ErrorMessage"]),
    musicBrainzRecordingId: uuidOrNull(row["MusicBrainzRecordingId"]),
    musicBrainzReleaseId: uuidOrNull(row["MusicBrainzReleaseId"]),
    musicBrainzReleaseGroupId: uuidOrNull(row["MusicBrainzReleaseGroupId"]),
    musicBrainzArtistId: uuidOrNull(row["MusicBrainzArtistId"]),
    musicBrainzAlbumArtistId: uuidOrNull(row["MusicBrainzAlbumArtistId"]),
    musicBrainzReleaseStatus: textOrNull(row["MusicBrainzReleaseStatus"]),
    musicBrainzReleaseCountry: textOrNull(row["MusicBrainzReleaseCountry"]),
    musicBrainzForced: row["MusicBrainzForced"] === true,
    musicBrainzRecordingIdForce: uuidOrNull(row["MusicBrainzRecordingIdForce"]),
    musicBrainzReleaseIdForce: uuidOrNull(row["MusicBrainzReleaseIdForce"]),
    forceSongMetadata: row["ForceSongMetadata"] === true,
    forceSourceMetadata: row["ForceSourceMetadata"] === true,
    createdAt: dateOrNull(row["CreatedAt"]),
    updatedAt: dateOrNull(row["UpdatedAt"]),
  };
}

export function decodeForce(row: Record<string, unknown>): V1ForceMetadata {
  return {
    id: intOrNull(row["Id"]) ?? 0,
    songId: intOrNull(row["SongId"]) ?? 0,
    field: String(row["Field"] ?? ""),
    value: String(row["Value"] ?? ""),
    isArrayValue: row["IsArrayValue"] === true,
  };
}

/* ------------------------------------------------------------------ */
/* derived facts                                                       */
/* ------------------------------------------------------------------ */

/**
 * The MBIDs to use for one song, forced values winning.
 *
 * v1 has exactly two forcible MBIDs on the `Songs` row — `MusicBrainzRecordingIdForce` and
 * `MusicBrainzReleaseIdForce` — gated by `MusicBrainzForced`, plus whatever
 * `SongForceMetadata` overrides. The gate is honoured rather than ignored: a `*Force` column
 * left over from a since-cleared flag is not what v1 would have used, so it is not what v2
 * migrates.
 */
export interface V1Identifiers {
  readonly recordingMbid: string | null;
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly artistMbid: string | null;
  readonly albumArtistMbid: string | null;
  /** Which of the above came from a user override, and must therefore be locked in v2. */
  readonly forced: readonly string[];
}

export function identifiersOf(
  song: V1Song,
  forces: readonly V1ForceMetadata[] = [],
): V1Identifiers {
  const forced = new Set<string>();
  const byField = new Map(forces.map((entry) => [entry.field, entry.value]));

  const override = (field: V1ForceField, fallback: string | null): string | null => {
    const raw = byField.get(field);
    if (raw === undefined) return fallback;
    const value = uuidOrNull(raw);
    if (value === null) return fallback;
    forced.add(field);
    return value;
  };

  let recording = song.musicBrainzRecordingId;
  let release = song.musicBrainzReleaseId;
  if (song.musicBrainzForced) {
    if (song.musicBrainzRecordingIdForce !== null) {
      recording = song.musicBrainzRecordingIdForce;
      forced.add("MusicBrainzRecordingId");
    }
    if (song.musicBrainzReleaseIdForce !== null) {
      release = song.musicBrainzReleaseIdForce;
      forced.add("MusicBrainzReleaseId");
    }
  }

  return {
    recordingMbid: override("MusicBrainzRecordingId", recording),
    releaseMbid: override("MusicBrainzReleaseId", release),
    releaseGroupMbid: override("MusicBrainzReleaseGroupId", song.musicBrainzReleaseGroupId),
    artistMbid: override("MusicBrainzArtistId", song.musicBrainzArtistId),
    albumArtistMbid: override("MusicBrainzAlbumArtistId", song.musicBrainzAlbumArtistId),
    forced: [...forced],
  };
}

/**
 * The YouTube (or SoundCloud) id v1 recorded, which is the last resort of the reconciliation.
 *
 * `SourceId` is the authoritative column; the URL is parsed only when it is empty, because a
 * v1 row is unique on `(Platform, SourceId)` and that pair is the closest thing v1 has to a
 * stable identity for a video.
 */
export function sourceVideoId(song: V1Song): string | null {
  if (song.sourceId !== "") return song.sourceId;
  return videoIdFromUrl(song.sourceUrl);
}

/** `https://www.youtube.com/watch?v=abc` / `https://youtu.be/abc` → `abc`. */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === "") return null;
  const watch = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(url);
  if (watch?.[1] !== undefined) return watch[1];
  const short = /youtu\.be\/([A-Za-z0-9_-]{6,})/.exec(url);
  if (short?.[1] !== undefined) return short[1];
  const embed = /\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,})/.exec(url);
  if (embed?.[1] !== undefined) return embed[1];
  return null;
}
