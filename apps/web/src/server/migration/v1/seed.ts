/**
 * The v1 row, as a metadata document (§ Étapes 2).
 *
 * v1 knew about twenty fields. v2's document has a hundred and twenty. So the seed is not the
 * document — it is the floor under it: every value v1 held, entered with source `v1` and low
 * confidence, so that `documents.build` overwrites all of it the moment MusicBrainz answers,
 * and so that a track whose MBID lookup never succeeds still arrives in v2 with a title, an
 * artist and an album rather than with nothing.
 *
 * Two categories are **locked** instead, because they are decisions a human already made
 * field by field, and a migration that quietly reverted them would be worse than one that
 * refused to run:
 *
 *  - every field with a `SongForceMetadata` row — that table exists for no other purpose;
 *  - the forced MBIDs (`MusicBrainzRecordingIdForce` / `…ReleaseIdForce`, gated by
 *    `MusicBrainzForced`), which are the answer somebody typed in after v1 got it wrong.
 *
 * The two **row** flags, `ForceSongMetadata` and `ForceSourceMetadata`, lock nothing by
 * themselves. They say "skip MusicBrainz and use the Songs row as it stands"
 * (`v1/core/Data/Entities/Song.cs` §Processing Flags, applied in `ProcessSongJob.cs`), and
 * that was v1's answer to a lookup it could not trust. It is not v2's answer: when the row
 * carries a release MBID and a recording MBID, **those** are what build the track — title,
 * artists, album artists, album, year, genres, numbers and label all come from the release v1
 * itself pointed at, and the seed stays underneath them as the floor it has always been.
 * Locking a whole row on the strength of a boolean throws away the best identifier v1 ever
 * recorded, which is the opposite of migrating it.
 *
 * `frozenFields` below is the one exception, and it is narrow on purpose: read it for why a
 * row with **no** MBID at all still freezes what its flag covered.
 *
 * `ForceSongMetadata` wins over `ForceSourceMetadata` when both are set, because v1's
 * `if / else if` says so.
 *
 * Everything here is pure. The v1 row and its overrides go in, a `DocumentPatch` comes out.
 */
import {
  field,
  type DocumentPatch,
  type EmbeddedPicture,
  type Field,
  type FieldValue,
} from "@mm/domain";
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
  /**
   * The release the plan settled on for this track — `PlannedAlbum.releaseMbid`.
   *
   * `identifiersOf` sees the forced value and the row; it cannot see the third rung,
   * `MUSICBRAINZ_ALBUMID` in the file, which `inventory.releaseMbidFor` adds. Passing the
   * album's answer here is what makes "is there anything to query?" the *same* question the
   * rest of the migration asks. Absent or `null`, the row's own column answers instead — the
   * two are a union, because either one is a release somebody can look up.
   */
  readonly releaseMbid?: string | null;
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
  // `CoverArtBytes` / `CoverArtMimeType` are bytes rather than text, so they are not in this
  // table; `forcedCover` below turns the pair into a locked `front_cover` instead.
};

/** The two `SongForceMetadata` members that carry the picture rather than a text field. */
const COVER_FORCE_FIELDS: ReadonlySet<string> = new Set(["CoverArtBytes", "CoverArtMimeType"]);

/**
 * The document fields `ForceSongMetadata` covers.
 *
 * One entry per assignment in `ProcessSongJob.cs`'s `if (song.ForceSongMetadata)` block, in
 * the same order, plus the Vorbis aliases the projection reads separately. They are frozen
 * only in the no-MBID case — see `frozenFields`.
 */
const FORCE_SONG_FIELDS: readonly string[] = [
  "title",
  "subtitle",
  "artists",
  "artist",
  "album",
  "isrc",
  "albumartists",
  "albumartist",
  "date",
  "originalyear",
  "label",
  "tracknumber",
  "totaltracks",
  "totaltracks_alias",
  "discnumber",
  "totaldiscs",
  "totaldiscs_alias",
  "genre",
  "musicbrainz_recordingid",
  "musicbrainz_albumid",
  "musicbrainz_artistid",
  "musicbrainz_albumartistid",
  "musicbrainz_releasegroupid",
  "releasestatus",
  "releasecountry",
];

/**
 * The document fields `ForceSourceMetadata` covers.
 *
 * Exactly the properties v1's `else if (song.ForceSourceMetadata)` branch assigns from the
 * parsed description. `TrackNumber` and `TrackCount` are copied into the tag DTO there but are
 * never *set* from the parse, so they are not in the list; the MBIDs are nulled out, so there
 * is nothing to freeze there either.
 */
const FORCE_SOURCE_FIELDS: readonly string[] = [
  "title",
  "artists",
  "artist",
  "album",
  "albumartists",
  "albumartist",
  "date",
  "originalyear",
  "label",
];

/**
 * What a row flag freezes, which is nothing at all as soon as there is an MBID to query.
 *
 * The rule the flags now obey:
 *
 *  - **a release MBID or a recording MBID exists** (forced, or on the row, or written into the
 *    file as `MUSICBRAINZ_ALBUMID`): MusicBrainz is queried and its answer is the track. The
 *    flag freezes nothing; the seed stays at `V1_CONFIDENCE` and fills only what MusicBrainz
 *    leaves missing. This is the case the rule exists for — v1 held a perfectly good pair of
 *    identifiers and set the flag because *its own* matcher had been wrong, not because the
 *    release was.
 *  - **neither exists**: there is no build to speak of, and the seed is all the track has. The
 *    flag then freezes the fields it covered, because `documents.build` is not empty in that
 *    case either — the YouTube resolver still answers from the yt-dlp entry `execute.ts`
 *    reconstructs (`title` from the video title, `artist` from the uploader, `label` and
 *    `date` from the parsed description), and `youtube` *is* in `SOURCE_PRECEDENCE` while `v1`
 *    is not. Left unlocked, a v1 row reading "Safe and Sound / D.A.N.C.E. / Fire" would come
 *    back out of a later `rebuild` titled "Justice - Safe and Sound _ D.A.N.C.E. _ Fire".
 *    Freezing here is not "v1 wins over MusicBrainz"; it is "a video title does not silently
 *    replace what v1 deliberately froze, when nobody asked for a match".
 */
function frozenFields(song: V1Song, hasMbid: boolean): readonly string[] {
  if (hasMbid) return [];
  if (song.forceSongMetadata) return FORCE_SONG_FIELDS;
  if (song.forceSourceMetadata) return FORCE_SOURCE_FIELDS;
  return [];
}

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
  // v1 wrote `ALBUMARTIST ← performers` when the album artists were empty
  // (`ProcessSongJob.ApplyID3TagsInternal`), so the fallback is part of the seed rather than
  // of the projection: seeded at `V1_CONFIDENCE`, it fills the hole a source leaves and gets
  // out of the way the moment one answers, which is what keeps ALBUMARTIST non-empty for
  // every v1 row that had a performer.
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

  /* ---- the processing flags, which freeze only when there is nothing to query ---- */
  const hasMbid = ids.recordingMbid !== null || (options.releaseMbid ?? ids.releaseMbid) !== null;
  for (const name of frozenFields(song, hasMbid)) {
    const held = fields[name];
    if (held === undefined) continue;
    fields[name] = { ...held, locked: true, confidence: 1 };
    locked.add(name);
  }

  /* ---- the picture v1's owner forced, which v2 used to throw away ---- */
  const cover = forcedCover(forces);
  if (cover !== null) {
    fields["front_cover"] = field([cover], "v1", fetchedAt, { confidence: 1, locked: true });
    locked.add("front_cover");
  }

  /* ---- the overrides, which win and stay won ---- */
  for (const force of forces) {
    if (COVER_FORCE_FIELDS.has(force.field)) {
      // A MIME type with no bytes beside it is half an override, and there is nothing to do
      // with it. Say so rather than dropping it, which is the rule for every other field.
      if (cover === null) ignoredForces.push(force.field);
      continue;
    }
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

/**
 * The picture `SongForceMetadata` holds, as an `EmbeddedPicture`.
 *
 * v1 stores it base64-encoded in `Value` (`ApplyForceMetadata` calls
 * `Convert.FromBase64String`) with the MIME type in a second row, and it is the *only* cover
 * v1 would have written for that track. v2 used to drop it on the theory that the Cover Art
 * Archive would supply a better one — which is true when there is a release MBID and a
 * network, and false in exactly the cases somebody bothered to force a cover.
 *
 * The bytes travel as a `data:` URL because that is what an `EmbeddedPicture` carries: a URL.
 * It needs no file on disk, no fetch and no cache entry, it renders in the Console's cover
 * picker like any other candidate, and `execute.ts` decodes it locally rather than asking the
 * toolbox to "download" it.
 */
function forcedCover(forces: readonly V1ForceMetadata[]): EmbeddedPicture | null {
  const bytes = forces.find((force) => force.field === "CoverArtBytes")?.value.trim();
  if (bytes === undefined || bytes === "") return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(bytes)) return null;
  const mime = forces.find((force) => force.field === "CoverArtMimeType")?.value.trim();
  return {
    kind: "front",
    mimeType: mime === undefined || mime === "" ? "image/jpeg" : mime,
    url: `data:${mime === undefined || mime === "" ? "image/jpeg" : mime};base64,${bytes.replace(/\s+/g, "")}`,
    comment: "v1 forced cover",
    provenance: "v1 · SongForceMetadata.CoverArtBytes",
  };
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
