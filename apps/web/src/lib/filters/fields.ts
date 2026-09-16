/**
 * What each library page lets you filter on — the whitelist, as data.
 *
 * Read this as the contract between three things that must not drift apart: the URL (anything
 * not named here is refused before it reaches a query), the value editor (the `type` chooses
 * which one is drawn), and `server/services/library-filter.sql.ts` (which binds every name
 * below to one SQL expression, and whose unit test fails if a name here has no binding).
 *
 * **Every field is a column, or something a column can be compared against.** That is the rule
 * the list was chosen by. Where a useful field exists only inside the metadata document — the
 * jsonb in `metadata_documents.document` — it is left out rather than turned into a per-row
 * JSON parse over the whole library. For albums that is **label, genre, release type and
 * release country**: none of them is denormalised onto `library_albums`, all four would mean
 * reading every track's document to answer one chip, and the honest thing is to say so here
 * rather than ship a filter that scans. Two document facts *are* offered, on tracks — lyrics
 * and ReplayGain — because each is a single existence test on one jsonb key rather than a
 * parse of the whole document, and they are the two the Quality page already counts.
 *
 * Client-safe: this file imports types only, so a route may pull it into the browser bundle.
 */
import type { FilterFieldDef, FilterFieldSet } from "./types.ts";

/* ------------------------------------------------------------------ */
/* shared pieces                                                       */
/* ------------------------------------------------------------------ */

const TEXT_OPERATORS = [
  "contains",
  "notContains",
  "eq",
  "neq",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
] as const;

const NUMBER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isEmpty",
  "isNotEmpty",
] as const;

const DATE_OPERATORS = ["gte", "lte", "between"] as const;
const ENUM_OPERATORS = ["eq", "neq", "in", "notIn"] as const;
const BOOLEAN_OPERATORS = ["is"] as const;

/** `library_tracks.format` is the file's extension, lower case and without the dot. */
const FORMAT_OPTIONS = [
  { value: "opus", label: "Opus" },
  { value: "flac", label: "FLAC" },
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A" },
  { value: "ogg", label: "Ogg" },
  { value: "oga", label: "Oga" },
  { value: "wav", label: "WAV" },
  { value: "aac", label: "AAC" },
  { value: "wma", label: "WMA" },
  { value: "alac", label: "ALAC" },
] as const;

const SCHEMA_OPTIONS = [
  { value: "current", label: "Current", hint: "written under the projection this app runs" },
  { value: "behind", label: "Behind", hint: "written under an older projection, or never read" },
] as const;

/* ------------------------------------------------------------------ */
/* albums — /library                                                   */
/* ------------------------------------------------------------------ */

export const ALBUM_FILTER_FIELDS: FilterFieldSet = Object.freeze<FilterFieldDef[]>([
  { name: "title", label: "Title", type: "text", operators: [...TEXT_OPERATORS] },
  { name: "artist", label: "Album artist", type: "text", operators: [...TEXT_OPERATORS] },
  {
    name: "year",
    label: "Year",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 1900,
    max: 2100,
  },
  {
    name: "score",
    label: "Metadata",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    max: 100,
    unit: "%",
    /*
     * The *mean of the tracks' scores*, which is `AlbumCompleteness.meanTrackScore` and not
     * quite the badge on the card. The badge subtracts a penalty for fields whose value
     * diverges across the album, and that penalty is computed by the domain out of the
     * documents — there is no column for it and no way to write one in SQL. Rather than a
     * filter that quietly disagrees with the number beside it, the field says which of the two
     * it is.
     */
    hint: "Mean of the tracks' completeness. The badge subtracts a divergence penalty this cannot see.",
  },
  {
    name: "tracks",
    label: "Tracks present",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    unit: "tracks",
    hint: "Files we hold for the album.",
  },
  {
    name: "total",
    label: "Tracks on the release",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    unit: "tracks",
    hint: "The denominator. Only a real total when the source below is release or tags.",
  },
  {
    name: "completion",
    label: "Completion",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    /*
     * The "incomplete" notion, with the third state it needs. An album whose `track_count`
     * came from counting our own rows has no total at all, so it can be neither complete nor
     * incomplete — saying "5/5" there is exactly the lie `track_count_source` was added to
     * stop, and a filter that swept those albums into "complete" would put it back.
     */
    options: [
      { value: "complete", label: "Complete", hint: "every track of a known total is present" },
      { value: "incomplete", label: "Incomplete", hint: "a known total we do not hold all of" },
      { value: "unknown", label: "Unknown total", hint: "no release and no totals in the tags" },
    ],
  },
  {
    name: "totalSource",
    label: "Total from",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [
      { value: "release", label: "The release" },
      { value: "tags", label: "The tags" },
      { value: "rows", label: "Our own rows", hint: "which means the total is unknown" },
    ],
  },
  { name: "hasCover", label: "Has cover", type: "boolean", operators: [...BOOLEAN_OPERATORS] },
  {
    name: "tagged",
    label: "Matched to a release",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
    hint: "False is the Untagged chip: imported from the YouTube tags alone.",
  },
  {
    name: "verification",
    label: "Verification",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [
      { value: "unverified", label: "Never verified" },
      { value: "ok", label: "Clean", hint: "every field read back as written" },
      { value: "mismatch", label: "Mismatch", hint: "a field came back different" },
      { value: "not_indexed", label: "Not indexed", hint: "the server did not index a field" },
    ],
  },
  {
    name: "schema",
    label: "Tag schema",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [...SCHEMA_OPTIONS],
    hint: "Behind means at least one of the album's files is.",
  },
  {
    name: "missingFiles",
    label: "Missing files",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
    hint: "The last scan could not find at least one of the album's files on disk.",
  },
  {
    name: "format",
    label: "Format",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [...FORMAT_OPTIONS],
    hint: "Matches when any of the album's files is of that format.",
  },
  { name: "added", label: "Added", type: "date", operators: [...DATE_OPERATORS] },
]);

/* ------------------------------------------------------------------ */
/* tracks — /library/tracks                                            */
/* ------------------------------------------------------------------ */

export const TRACK_FILTER_FIELDS: FilterFieldSet = Object.freeze<FilterFieldDef[]>([
  { name: "title", label: "Title", type: "text", operators: [...TEXT_OPERATORS] },
  { name: "artist", label: "Artist", type: "text", operators: [...TEXT_OPERATORS] },
  { name: "album", label: "Album", type: "text", operators: [...TEXT_OPERATORS] },
  {
    name: "duration",
    label: "Duration",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    unit: "s",
  },
  {
    name: "format",
    label: "Format",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [...FORMAT_OPTIONS],
  },
  {
    name: "hasLyrics",
    label: "Has lyrics",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
    hint: "Synchronised or plain, as the document holds them.",
  },
  {
    name: "hasReplayGain",
    label: "Has ReplayGain",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
  },
  {
    name: "fingerprint",
    label: "Fingerprint",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [
      { value: "ok", label: "Agrees", hint: "AcoustID confirmed the recording we mapped" },
      { value: "mismatch", label: "Disagrees", hint: "AcoustID named another recording" },
      { value: "none", label: "Not fingerprinted" },
    ],
  },
  {
    name: "score",
    label: "Metadata",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    max: 100,
    unit: "%",
    hint: "The track's completeness, exactly as the row's badge reads it.",
  },
  {
    name: "schema",
    label: "Tag schema",
    type: "enum",
    operators: [...ENUM_OPERATORS],
    options: [...SCHEMA_OPTIONS],
  },
  {
    name: "missingFile",
    label: "Missing file",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
    hint: "The last scan could not find this file on disk.",
  },
  {
    name: "tagged",
    label: "Has a recording MBID",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
  },
  { name: "added", label: "Added", type: "date", operators: [...DATE_OPERATORS] },
]);

/* ------------------------------------------------------------------ */
/* artists — /library/artists                                          */
/* ------------------------------------------------------------------ */

export const ARTIST_FILTER_FIELDS: FilterFieldSet = Object.freeze<FilterFieldDef[]>([
  { name: "name", label: "Name", type: "text", operators: [...TEXT_OPERATORS] },
  {
    name: "albums",
    label: "Albums",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    unit: "albums",
  },
  {
    name: "tracks",
    label: "Tracks",
    type: "number",
    operators: [...NUMBER_OPERATORS],
    min: 0,
    unit: "tracks",
  },
  {
    name: "hasImage",
    label: "Has image",
    type: "boolean",
    operators: [...BOOLEAN_OPERATORS],
    hint: "An artist.jpg the cache knows a URL for.",
  },
  {
    name: "country",
    label: "Country",
    type: "text",
    operators: [...TEXT_OPERATORS],
    hint: "The ISO code MusicBrainz gives the artist, when one is cached.",
  },
]);
