/**
 * The v1 row, as a metadata document (§ Étapes 2).
 *
 * v1 knew about twenty fields. v2's document has a hundred and twenty. So the seed is not the
 * document — it is the floor under it: every value v1 held, entered with source `v1` and low
 * confidence, so that `documents.build` overwrites all of it the moment MusicBrainz answers,
 * and so that a track whose MBID lookup never succeeds still arrives in v2 with a title, an
 * artist and an album rather than with nothing.
 *
 * Two categories are **locked** instead, because they are decisions a human already made and
 * a migration that quietly reverted them would be worse than one that refused to run:
 *
 *  - every field with a `SongForceMetadata` row — that table exists for no other purpose;
 *  - the forced MBIDs (`MusicBrainzRecordingIdForce` / `…ReleaseIdForce`, gated by
 *    `MusicBrainzForced`), which are the answer somebody typed in after v1 got it wrong.
 *
 * Everything here is pure. The v1 row and its overrides go in, a `DocumentPatch` comes out.
 */
import { field, type DocumentPatch, type Field, type FieldValue } from "@mm/domain";
import {
  identifiersOf,
  splitForcedList,
  type V1ForceField,
  type V1ForceMetadata,
  type V1Song,
} from "./schema.ts";

/**
 * How sure we are of anything v1 said: not very.
 *
 * `merge` settles same-rank sources by confidence, and `v1` is absent from every precedence
 * list — so it already loses to MusicBrainz, Deezer and the rest. The low number is belt and
 * braces, and it is what the Console shows next to the value: "v1, 0.2" is an honest label
 * for a tag somebody's first-generation importer wrote three years ago.
 */
export const V1_CONFIDENCE = 0.2;

export interface SeedOptions {
  /** Stamped on every field as `fetchedAt`. Defaults to the row's `UpdatedAt`, then to now. */
  readonly now?: Date;
}

export interface SeedResult {
  readonly patch: DocumentPatch;
  /** Document field names that came from a v1 override and are therefore locked. */
  readonly locked: readonly string[];
  /** v1 `SongForceMetadata` rows we could not map onto a v2 field. */
  readonly ignoredForces: readonly string[];
}

/** v1 `ForceMetadataType` member → the v2 document field it overrides. */
const FORCE_TO_FIELD: Readonly<Partial<Record<V1ForceField, string>>> = {
  Title: "title",
  Subtitle: "subtitle",
  Performers: "artists",
  Album: "album",
  Isrc: "isrc",
  AlbumArtists: "albumartists",
  Year: "date",
  Publisher: "label",
  TrackNumber: "tracknumber",
  TrackCount: "totaltracks",
  DiscNumber: "discnumber",
  DiscCount: "totaldiscs",
  Genres: "genre",
  MusicBrainzRecordingId: "musicbrainz_recordingid",
  MusicBrainzReleaseId: "musicbrainz_albumid",
  MusicBrainzArtistId: "musicbrainz_artistid",
  MusicBrainzAlbumArtistId: "musicbrainz_albumartistid",
  MusicBrainzReleaseGroupId: "musicbrainz_releasegroupid",
  MusicBrainzReleaseStatus: "releasestatus",
  MusicBrainzReleaseCountry: "releasecountry",
  // `CoverArtBytes` / `CoverArtMimeType` are bytes, not a document field: the picture is
  // re-fetched from the Cover Art Archive in v2 and the v1 blob is deliberately dropped.
};

/**
 * Build the seed patch.
 *
 * The `_alias` fields (`TOTALTRACKS`, `TOTALDISCS`) are filled too: §2.1 asks for both
 * spellings in Vorbis and the projection reads them from the document, not from each other.
 */
export function seedDocument(
  song: V1Song,
  forces: readonly V1ForceMetadata[] = [],
  options: SeedOptions = {},
): SeedResult {
  const fetchedAt = (options.now ?? song.updatedAt ?? new Date()).toISOString();
  const fields: Record<string, Field> = {};
  const locked = new Set<string>();
  const ignoredForces: string[] = [];

  const put = (name: string, value: FieldValue | null | undefined): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim() === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    fields[name] = field(value, "v1", fetchedAt, { confidence: V1_CONFIDENCE });
  };

  /* ---- identity and position ---- */
  put("title", song.title);
  put("subtitle", song.subtitle);
  const artists = song.performers.length > 0 ? song.performers : compact([song.artist]);
  put("artists", artists);
  // v1 has no join phrases, so the single-string ARTIST is the list rendered the only way we
  // can defend: "A; B" would be wrong, "A" alone would lose information, so " & " it is.
  if (artists.length > 0) put("artist", artists.join(" & "));
  put("album", song.album);
  const albumArtists = song.albumArtists.length > 0 ? song.albumArtists : artists;
  put("albumartists", albumArtists);
  if (albumArtists.length > 0) put("albumartist", albumArtists.join(" & "));
  put("tracknumber", song.trackNumber);
  put("totaltracks", song.trackCount);
  put("totaltracks_alias", song.trackCount);
  put("discnumber", song.discNumber);
  put("totaldiscs", song.discCount);
  put("totaldiscs_alias", song.discCount);

  /* ---- release ---- */
  if (song.year !== null) {
    // v1 only ever knew a year. A bare `YYYY` is a valid ISO-8601 date and every reader
    // accepts it; inventing `-01-01` would be inventing a fact.
    put("date", String(song.year));
    put("originalyear", String(song.year));
  }
  put("label", song.publisher);
  put("releasestatus", song.musicBrainzReleaseStatus);
  put("releasecountry", song.musicBrainzReleaseCountry);

  /* ---- classification ---- */
  put("genre", song.genres);

  /* ---- identifiers ---- */
  const ids = identifiersOf(song, forces);
  put("musicbrainz_recordingid", ids.recordingMbid);
  put("musicbrainz_albumid", ids.releaseMbid);
  put("musicbrainz_releasegroupid", ids.releaseGroupMbid);
  put("musicbrainz_artistid", ids.artistMbid === null ? null : [ids.artistMbid]);
  put("musicbrainz_albumartistid", ids.albumArtistMbid === null ? null : [ids.albumArtistMbid]);
  put("isrc", song.isrc === null ? null : [song.isrc]);

  /* ---- provenance: the one thing a v1 file already carried ---- */
  put("musicmanager_sourceurl", song.sourceUrl);

  /* ---- the overrides, which win and stay won ---- */
  for (const force of forces) {
    const name = FORCE_TO_FIELD[force.field as V1ForceField];
    if (name === undefined) {
      ignoredForces.push(force.field);
      continue;
    }
    const value = decodeForced(force, name);
    if (value === null) {
      ignoredForces.push(force.field);
      continue;
    }
    fields[name] = field(value, "v1", fetchedAt, { confidence: 1, locked: true });
    locked.add(name);
    // The Vorbis aliases must not diverge from the value they alias.
    if (name === "totaltracks") mirror(fields, "totaltracks_alias", fields[name]);
    if (name === "totaldiscs") mirror(fields, "totaldiscs_alias", fields[name]);
  }

  /* ---- a forced MBID is a decision too, even without a SongForceMetadata row ---- */
  for (const forcedField of ids.forced) {
    const name = FORCE_TO_FIELD[forcedField as V1ForceField];
    if (name === undefined) continue;
    const held = fields[name];
    if (held === undefined) continue;
    fields[name] = { ...held, locked: true, confidence: 1 };
    locked.add(name);
  }

  return { patch: { fields }, locked: [...locked], ignoredForces };
}

function mirror(fields: Record<string, Field>, name: string, source: Field | undefined): void {
  if (source !== undefined) fields[name] = source;
}

/**
 * Decode one `SongForceMetadata` value the way v1's `ApplyForceMetadata` does.
 *
 * v1 dispatches on the CLR type of the target property; we dispatch on the v2 field, which is
 * the same information from the other end. A value v1 would have failed to parse returns
 * `null` here and is reported as ignored — v1 assigned null in that case, *erasing* the
 * resolved value, which is a bug we decline to inherit.
 */
function decodeForced(force: V1ForceMetadata, name: string): FieldValue | null {
  const raw = force.value;

  if (force.isArrayValue) {
    const list = splitForcedList(raw).filter((item) => item !== "");
    return list.length === 0 ? null : list;
  }

  switch (name) {
    case "tracknumber":
    case "totaltracks":
    case "discnumber":
    case "totaldiscs": {
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "date": {
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(parsed) ? String(parsed) : null;
    }
    case "artists":
    case "albumartists":
    case "genre":
    case "isrc":
    case "musicbrainz_artistid":
    case "musicbrainz_albumartistid": {
      const trimmed = raw.trim();
      return trimmed === "" ? null : [trimmed];
    }
    default: {
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    }
  }
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && value !== "");
}

/**
 * The album a v1 row belongs to, as a grouping key.
 *
 * v1 has no album entity — an album is whatever the rows agree on. The key is therefore the
 * pair that v1's own path generator used, which guarantees that rows sharing a folder share
 * an album row, and that is the property the library tables need.
 */
export function albumKeyOf(song: V1Song): string {
  const artist = song.albumArtists[0] ?? song.artist ?? "Unknown Artist";
  const album = song.album ?? "Unknown Album";
  const year = song.year === null ? "" : String(song.year);
  return `${artist.toLowerCase()} ${album.toLowerCase()} ${year}`;
}
