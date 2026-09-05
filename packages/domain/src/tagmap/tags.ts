/**
 * The tag map — the single source of tag names in the whole system.
 *
 * This file encodes, row by row, the correspondence tables of
 * `docs/03-metadonnees.md` §2.1 to §2.6 (the Picard superset). The toolbox never sees a
 * MusicBrainz concept: it receives already-projected key/value pairs produced from this
 * table (`../../../../CLAUDE.md`).
 *
 * A row in the documentation sometimes names several keys ("TRACKNUMBER, TRACKTOTAL
 * (+ TOTALTRACKS)", "REPLAYGAIN_TRACK_GAIN / _PEAK / _RANGE"). Those are expanded here into
 * one entry per key, because one key is one line in a file. `tags.doc.test.ts` re-parses the
 * markdown tables and asserts that every Vorbis key they mention exists below.
 *
 * Fields:
 *  - `field`      stable internal name, the key of a `TrackDocument`;
 *  - `group`      the documentation section the row comes from;
 *  - `vorbis`     Vorbis comment key (Opus, FLAC) — uppercase, one entry per value;
 *  - `id3`        ID3v2.4 frame, `null` when the format has no equivalent;
 *  - `mp4`        MP4 atom, `null` when the format has no equivalent;
 *  - `level`      "required" counts towards "complete", then "recommended", "optional" (§6);
 *  - `multi`      one tag per value (Vorbis), repeated frames (ID3), a list (MP4);
 *  - `albumScope` must be identical on every track of the album, or servers split it (§2 notes);
 *  - `source`     where the value comes from, for the UI and for the resolvers;
 *  - `note`       free-form clarification.
 */

/** Documentation section a tag belongs to. */
export const TAG_GROUPS = [
  "identity",
  "release",
  "credits",
  "classification",
  "identifiers",
  "loudness",
  "analysis",
  "lyrics-artwork",
  "provenance",
] as const;

export type TagGroup = (typeof TAG_GROUPS)[number];

/** §2: **R** required (counts towards "complete"), **C** recommended, **O** optional. */
export type TagLevel = "required" | "recommended" | "optional";

/** The three container formats we write (§1). */
export const TAG_FORMATS = ["vorbis", "id3v24", "mp4"] as const;
export type TagFormat = (typeof TAG_FORMATS)[number];

export interface TagDefinition {
  readonly field: string;
  readonly group: TagGroup;
  readonly vorbis: string;
  readonly id3: string | null;
  readonly mp4: string | null;
  readonly level: TagLevel;
  readonly multi: boolean;
  readonly albumScope: boolean;
  readonly source: string;
  readonly note: string;
}

/** MP4 free-form atoms all share this prefix; spelling it once keeps the table readable. */
const FF = "----:com.apple.iTunes:";

interface TagInput {
  field: string;
  vorbis: string;
  id3?: string | null;
  mp4?: string | null;
  level: "R" | "C" | "O";
  multi?: boolean;
  albumScope?: boolean;
  source: string;
  note?: string;
}

const LEVELS: Record<"R" | "C" | "O", TagLevel> = {
  R: "required",
  C: "recommended",
  O: "optional",
};

function group(name: TagGroup, rows: readonly TagInput[]): TagDefinition[] {
  return rows.map((row) => ({
    field: row.field,
    group: name,
    vorbis: row.vorbis,
    id3: row.id3 ?? null,
    mp4: row.mp4 ?? null,
    level: LEVELS[row.level],
    multi: row.multi ?? false,
    albumScope: row.albumScope ?? false,
    source: row.source,
    note: row.note ?? "",
  }));
}

/* ------------------------------------------------------------------ §2.1 Identity and position */

const IDENTITY = group("identity", [
  {
    field: "title",
    vorbis: "TITLE",
    id3: "TIT2",
    mp4: "©nam",
    level: "R",
    source: "recording / track",
    note: "The title as credited on this release, not the recording's own title.",
  },
  {
    field: "titlesort",
    vorbis: "TITLESORT",
    id3: "TSOT",
    mp4: "sonm",
    level: "C",
    source: "recording",
  },
  {
    field: "subtitle",
    vorbis: "SUBTITLE",
    id3: "TIT3",
    mp4: `${FF}SUBTITLE`,
    level: "O",
    source: "recording disambiguation",
    note: "“radio edit”, “live at Bercy”…",
  },
  {
    field: "artist",
    vorbis: "ARTIST",
    id3: "TPE1",
    mp4: "©ART",
    level: "R",
    source: "track artist-credit",
    note: "Single string built with the MusicBrainz join phrases (“A feat. B”).",
  },
  {
    field: "artists",
    vorbis: "ARTISTS",
    id3: "TXXX:Artists",
    mp4: `${FF}ARTISTS`,
    level: "R",
    multi: true,
    source: "track artist-credit",
    note: "One tag per artist; readers that split ARTIST on “feat.” find the clean list here.",
  },
  {
    field: "artistsort",
    vorbis: "ARTISTSORT",
    id3: "TSOP",
    mp4: "soar",
    level: "C",
    multi: true,
    source: "artist sort-name",
  },
  {
    field: "album",
    vorbis: "ALBUM",
    id3: "TALB",
    mp4: "©alb",
    level: "R",
    albumScope: true,
    source: "release",
  },
  {
    field: "albumsort",
    vorbis: "ALBUMSORT",
    id3: "TSOA",
    mp4: "soal",
    level: "C",
    albumScope: true,
    source: "release",
  },
  {
    field: "albumartist",
    vorbis: "ALBUMARTIST",
    id3: "TPE2",
    mp4: "aART",
    level: "R",
    albumScope: true,
    source: "release artist-credit",
    note: "“Various Artists” on compilations — this is what groups an album.",
  },
  {
    field: "albumartists",
    vorbis: "ALBUMARTISTS",
    id3: "TXXX:ALBUMARTISTS",
    mp4: `${FF}ALBUMARTISTS`,
    level: "R",
    multi: true,
    albumScope: true,
    source: "release artist-credit",
  },
  {
    field: "albumartistsort",
    vorbis: "ALBUMARTISTSORT",
    id3: "TSO2",
    mp4: "soaa",
    level: "C",
    albumScope: true,
    source: "artist sort-name",
  },
  {
    field: "albumcomment",
    vorbis: "MUSICBRAINZ_ALBUMCOMMENT",
    id3: "TXXX:MUSICBRAINZ_ALBUMCOMMENT",
    mp4: `${FF}MUSICBRAINZ_ALBUMCOMMENT`,
    level: "C",
    albumScope: true,
    source: "release disambiguation",
    note: "“deluxe edition”, “2011 remaster” — keeps two editions apart.",
  },
  {
    field: "tracknumber",
    vorbis: "TRACKNUMBER",
    id3: "TRCK",
    mp4: "trkn",
    level: "R",
    source: "medium / track",
    note: "Vorbis writes a plain number, never “3/12”; ID3 and MP4 carry number and total together.",
  },
  {
    field: "totaltracks",
    vorbis: "TRACKTOTAL",
    id3: "TRCK",
    mp4: "trkn",
    level: "R",
    albumScope: true,
    source: "medium",
  },
  {
    field: "totaltracks_alias",
    vorbis: "TOTALTRACKS",
    id3: null,
    mp4: null,
    level: "R",
    albumScope: true,
    source: "medium",
    note: "§2.1 asks for both spellings in Vorbis; older readers only know this one.",
  },
  {
    field: "discnumber",
    vorbis: "DISCNUMBER",
    id3: "TPOS",
    mp4: "disk",
    level: "R",
    source: "medium",
  },
  {
    field: "totaldiscs",
    vorbis: "DISCTOTAL",
    id3: "TPOS",
    mp4: "disk",
    level: "R",
    albumScope: true,
    source: "release",
  },
  {
    field: "totaldiscs_alias",
    vorbis: "TOTALDISCS",
    id3: null,
    mp4: null,
    level: "R",
    albumScope: true,
    source: "release",
    note: "Vorbis alias of DISCTOTAL, same rule as TOTALTRACKS.",
  },
  {
    field: "discsubtitle",
    vorbis: "DISCSUBTITLE",
    id3: "TSST",
    mp4: `${FF}DISCSUBTITLE`,
    level: "C",
    source: "medium title",
  },
  {
    field: "compilation",
    vorbis: "COMPILATION",
    id3: "TCMP",
    mp4: "cpil",
    level: "C",
    albumScope: true,
    source: "Various Artists",
    note: "Written as 1; stops compilations polluting the artist list.",
  },
]);

/* ---------------------------------------------------------------- §2.2 Dates and release */

const RELEASE = group("release", [
  {
    field: "date",
    vorbis: "DATE",
    id3: "TDRC",
    mp4: "©day",
    level: "R",
    albumScope: true,
    source: "release",
    note: "Date of THIS release, full YYYY-MM-DD when MusicBrainz knows it.",
  },
  {
    field: "releasedate",
    vorbis: "RELEASEDATE",
    id3: "TDRL",
    mp4: `${FF}RELEASEDATE`,
    level: "C",
    albumScope: true,
    source: "release",
    note: "Same value as DATE; some readers only look at one of the two.",
  },
  {
    field: "originaldate",
    vorbis: "ORIGINALDATE",
    id3: "TDOR",
    mp4: `${FF}ORIGINALDATE`,
    level: "R",
    albumScope: true,
    source: "release-group first-release-date",
    note: "Keeps a later reissue sorted under the original year.",
  },
  {
    field: "originalyear",
    vorbis: "ORIGINALYEAR",
    id3: "TDOR",
    mp4: `${FF}ORIGINALYEAR`,
    level: "R",
    albumScope: true,
    source: "release-group first-release-date",
    note: "Year-only duplicate for readers that ignore ORIGINALDATE.",
  },
  {
    field: "releasetype",
    vorbis: "RELEASETYPE",
    id3: "TXXX:MusicBrainz Album Type",
    mp4: `${FF}MusicBrainz Album Type`,
    level: "R",
    multi: true,
    albumScope: true,
    source: "release-group primary + secondary types",
    note: "album, ep, single, live, compilation, soundtrack, remix — lowercased.",
  },
  {
    field: "releasestatus",
    vorbis: "RELEASESTATUS",
    id3: "TXXX:MusicBrainz Album Status",
    mp4: `${FF}MusicBrainz Album Status`,
    level: "R",
    albumScope: true,
    source: "release",
    note: "official / promotion / bootleg — a filter, not a display value.",
  },
  {
    field: "releasecountry",
    vorbis: "RELEASECOUNTRY",
    id3: "TXXX:MusicBrainz Album Release Country",
    mp4: `${FF}MusicBrainz Album Release Country`,
    level: "C",
    albumScope: true,
    source: "release",
  },
  {
    field: "media",
    vorbis: "MEDIA",
    id3: "TMED",
    mp4: `${FF}MEDIA`,
    level: "C",
    albumScope: true,
    source: "medium format",
    note: 'Digital Media, CD, 12" Vinyl…',
  },
  {
    field: "label",
    vorbis: "LABEL",
    id3: "TPUB",
    mp4: `${FF}LABEL`,
    level: "C",
    multi: true,
    albumScope: true,
    source: "release label-info",
  },
  {
    field: "catalognumber",
    vorbis: "CATALOGNUMBER",
    id3: "TXXX:CATALOGNUMBER",
    mp4: `${FF}CATALOGNUMBER`,
    level: "C",
    multi: true,
    albumScope: true,
    source: "release label-info",
  },
  {
    field: "barcode",
    vorbis: "BARCODE",
    id3: "TXXX:BARCODE",
    mp4: `${FF}BARCODE`,
    level: "C",
    albumScope: true,
    source: "release",
  },
  {
    field: "asin",
    vorbis: "ASIN",
    id3: "TXXX:ASIN",
    mp4: `${FF}ASIN`,
    level: "O",
    albumScope: true,
    source: "release url-rels (Amazon)",
  },
  {
    field: "script",
    vorbis: "SCRIPT",
    id3: "TXXX:SCRIPT",
    mp4: `${FF}SCRIPT`,
    level: "O",
    albumScope: true,
    source: "release text-representation",
    note: "Latn, Cyrl, Jpan…",
  },
  {
    field: "language",
    vorbis: "LANGUAGE",
    id3: "TLAN",
    mp4: `${FF}LANGUAGE`,
    level: "O",
    source: "work",
    note: "Language of the lyrics, ISO 639-3.",
  },
  {
    field: "copyright",
    vorbis: "COPYRIGHT",
    id3: "TCOP",
    mp4: "cprt",
    level: "O",
    albumScope: true,
    source: "℗ / © line of the YouTube description, release",
  },
  {
    field: "license",
    vorbis: "LICENSE",
    id3: "WCOP",
    mp4: `${FF}LICENSE`,
    level: "O",
    source: "url-rels (license)",
    note: "§2.2 allows WCOP or TXXX:LICENSE in ID3; WCOP is the standard URL frame.",
  },
  {
    field: "website",
    vorbis: "WEBSITE",
    id3: "WOAR",
    mp4: null,
    level: "O",
    source: "artist url-rels (official homepage)",
    note: "No MP4 equivalent — dropped for AAC.",
  },
]);

/* ------------------------------------------------ §2.3 Credits (MusicBrainz relations) */

const CREDITS = group("credits", [
  {
    field: "composer",
    vorbis: "COMPOSER",
    id3: "TCOM",
    mp4: "©wrt",
    level: "C",
    multi: true,
    source: "work-rels / recording-rels",
  },
  {
    field: "composersort",
    vorbis: "COMPOSERSORT",
    id3: "TSOC",
    mp4: "soco",
    level: "C",
    multi: true,
    source: "artist sort-name",
  },
  {
    field: "lyricist",
    vorbis: "LYRICIST",
    id3: "TEXT",
    mp4: `${FF}LYRICIST`,
    level: "C",
    multi: true,
    source: "work-rels",
  },
  {
    field: "writer",
    vorbis: "WRITER",
    id3: "TXXX:Writer",
    mp4: null,
    level: "C",
    multi: true,
    source: "work-rels (writer role)",
    note: "Used when MusicBrainz says “writer” without splitting composer / lyricist.",
  },
  {
    field: "arranger",
    vorbis: "ARRANGER",
    id3: "TIPL:arranger",
    mp4: null,
    level: "C",
    multi: true,
    source: "work-rels / recording-rels",
  },
  {
    field: "conductor",
    vorbis: "CONDUCTOR",
    id3: "TPE3",
    mp4: `${FF}CONDUCTOR`,
    level: "C",
    multi: true,
    source: "recording-rels",
  },
  {
    field: "producer",
    vorbis: "PRODUCER",
    id3: "TIPL:producer",
    mp4: `${FF}PRODUCER`,
    level: "C",
    multi: true,
    source: "recording-rels · YouTube description fallback",
  },
  {
    field: "engineer",
    vorbis: "ENGINEER",
    id3: "TIPL:engineer",
    mp4: `${FF}ENGINEER`,
    level: "C",
    multi: true,
    source: "recording-rels (recording, mastering, sound, audio)",
    note: "Sub-roles fold into ENGINEER; the exact role stays in the raw cache.",
  },
  {
    field: "mixer",
    vorbis: "MIXER",
    id3: "TIPL:mix",
    mp4: `${FF}MIXER`,
    level: "C",
    multi: true,
    source: "recording-rels",
  },
  {
    field: "remixer",
    vorbis: "REMIXER",
    id3: "TPE4",
    mp4: `${FF}REMIXER`,
    level: "C",
    multi: true,
    source: "recording-rels",
  },
  {
    field: "djmixer",
    vorbis: "DJMIXER",
    id3: "TIPL:DJ-mix",
    mp4: `${FF}DJMIXER`,
    level: "C",
    multi: true,
    source: "recording-rels",
  },
  {
    field: "director",
    vorbis: "DIRECTOR",
    id3: "TXXX:DIRECTOR",
    mp4: "©dir",
    level: "O",
    multi: true,
    source: "recording-rels (video director)",
  },
  {
    field: "performer",
    vorbis: "PERFORMER",
    id3: "TMCL",
    mp4: null,
    level: "C",
    multi: true,
    source: "recording-rels / work-level-rels",
    note: "Rendered as “Name (role)” in Vorbis, as a TMCL role/name pair in ID3. Performance roles Picard does not map land here (§2.3).",
  },
  {
    field: "musicbrainz_composerid",
    vorbis: "MUSICBRAINZ_COMPOSERID",
    id3: "TXXX:MusicBrainz Composer Id",
    mp4: `${FF}MusicBrainz Composer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_producerid",
    vorbis: "MUSICBRAINZ_PRODUCERID",
    id3: "TXXX:MusicBrainz Producer Id",
    mp4: `${FF}MusicBrainz Producer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_engineerid",
    vorbis: "MUSICBRAINZ_ENGINEERID",
    id3: "TXXX:MusicBrainz Engineer Id",
    mp4: `${FF}MusicBrainz Engineer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_mixerid",
    vorbis: "MUSICBRAINZ_MIXERID",
    id3: "TXXX:MusicBrainz Mixer Id",
    mp4: `${FF}MusicBrainz Mixer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_remixerid",
    vorbis: "MUSICBRAINZ_REMIXERID",
    id3: "TXXX:MusicBrainz Remixer Id",
    mp4: `${FF}MusicBrainz Remixer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_djmixerid",
    vorbis: "MUSICBRAINZ_DJMIXERID",
    id3: "TXXX:MusicBrainz DJ-Mixer Id",
    mp4: `${FF}MusicBrainz DJ-Mixer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_conductorid",
    vorbis: "MUSICBRAINZ_CONDUCTORID",
    id3: "TXXX:MusicBrainz Conductor Id",
    mp4: `${FF}MusicBrainz Conductor Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_arrangerid",
    vorbis: "MUSICBRAINZ_ARRANGERID",
    id3: "TXXX:MusicBrainz Arranger Id",
    mp4: `${FF}MusicBrainz Arranger Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_lyricistid",
    vorbis: "MUSICBRAINZ_LYRICISTID",
    id3: "TXXX:MusicBrainz Lyricist Id",
    mp4: `${FF}MusicBrainz Lyricist Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_performerid",
    vorbis: "MUSICBRAINZ_PERFORMERID",
    id3: "TXXX:MusicBrainz Performer Id",
    mp4: `${FF}MusicBrainz Performer Id`,
    level: "O",
    multi: true,
    source: "artist MBID",
  },
]);

/* ---------------------------------------------------- §2.4 Classification and work */

const CLASSIFICATION = group("classification", [
  {
    field: "genre",
    vorbis: "GENRE",
    id3: "TCON",
    mp4: "©gen",
    level: "R",
    multi: true,
    albumScope: true,
    source: "MB genres recording > release-group > artist ; Last.fm / ListenBrainz fallback",
  },
  {
    field: "mood",
    vorbis: "MOOD",
    id3: "TMOO",
    mp4: `${FF}MOOD`,
    level: "C",
    multi: true,
    albumScope: true,
    source: "MB tags (filtered), Last.fm",
  },
  { field: "work", vorbis: "WORK", id3: "TXXX:WORK", mp4: "©wrk", level: "O", source: "work" },
  {
    field: "grouping",
    vorbis: "GROUPING",
    id3: "TIT1",
    mp4: "©grp",
    level: "O",
    albumScope: true,
    source: "work parent / series",
  },
  {
    field: "movement",
    vorbis: "MOVEMENTNAME",
    id3: "MVNM",
    mp4: "©mvn",
    level: "O",
    source: "classical works",
  },
  {
    field: "movementnumber",
    vorbis: "MOVEMENT",
    id3: "MVIN",
    mp4: "mvi",
    level: "O",
    source: "classical works",
  },
  {
    field: "movementtotal",
    vorbis: "MOVEMENTTOTAL",
    id3: "MVIN",
    mp4: "mvc",
    level: "O",
    source: "classical works",
  },
  {
    field: "showmovement",
    vorbis: "SHOWMOVEMENT",
    id3: "TXXX:SHOWMOVEMENT",
    mp4: "shwm",
    level: "O",
    source: "classical heuristics",
  },
]);

/* ------------------------------------------------------------ §2.5 Identifiers */

const IDENTIFIERS = group("identifiers", [
  {
    field: "musicbrainz_recordingid",
    vorbis: "MUSICBRAINZ_TRACKID",
    id3: "UFID:http://musicbrainz.org",
    mp4: `${FF}MusicBrainz Track Id`,
    level: "R",
    source: "recording MBID",
    note: "Picard's confusing name: this is the RECORDING id.",
  },
  {
    field: "musicbrainz_releasetrackid",
    vorbis: "MUSICBRAINZ_RELEASETRACKID",
    id3: "TXXX:MusicBrainz Release Track Id",
    mp4: `${FF}MusicBrainz Release Track Id`,
    level: "R",
    source: "release-track MBID",
  },
  {
    field: "musicbrainz_albumid",
    vorbis: "MUSICBRAINZ_ALBUMID",
    id3: "TXXX:MusicBrainz Album Id",
    mp4: `${FF}MusicBrainz Album Id`,
    level: "R",
    albumScope: true,
    source: "release MBID",
  },
  {
    field: "musicbrainz_releasegroupid",
    vorbis: "MUSICBRAINZ_RELEASEGROUPID",
    id3: "TXXX:MusicBrainz Release Group Id",
    mp4: `${FF}MusicBrainz Release Group Id`,
    level: "R",
    albumScope: true,
    source: "release-group MBID",
  },
  {
    field: "musicbrainz_artistid",
    vorbis: "MUSICBRAINZ_ARTISTID",
    id3: "TXXX:MusicBrainz Artist Id",
    mp4: `${FF}MusicBrainz Artist Id`,
    level: "R",
    multi: true,
    source: "artist MBID",
    note: "One per credited artist, same order as ARTISTS.",
  },
  {
    field: "musicbrainz_albumartistid",
    vorbis: "MUSICBRAINZ_ALBUMARTISTID",
    id3: "TXXX:MusicBrainz Album Artist Id",
    mp4: `${FF}MusicBrainz Album Artist Id`,
    level: "R",
    multi: true,
    albumScope: true,
    source: "artist MBID",
  },
  {
    field: "musicbrainz_workid",
    vorbis: "MUSICBRAINZ_WORKID",
    id3: "TXXX:MusicBrainz Work Id",
    mp4: `${FF}MusicBrainz Work Id`,
    level: "O",
    source: "work MBID",
  },
  {
    field: "musicbrainz_originalalbumid",
    vorbis: "MUSICBRAINZ_ORIGINALALBUMID",
    id3: "TXXX:MusicBrainz Original Album Id",
    mp4: `${FF}MusicBrainz Original Album Id`,
    level: "O",
    albumScope: true,
    source: "release MBID (covers, merges)",
  },
  {
    field: "musicbrainz_originalartistid",
    vorbis: "MUSICBRAINZ_ORIGINALARTISTID",
    id3: "TXXX:MusicBrainz Original Artist Id",
    mp4: `${FF}MusicBrainz Original Artist Id`,
    level: "O",
    multi: true,
    source: "artist MBID (covers)",
  },
  {
    field: "isrc",
    vorbis: "ISRC",
    id3: "TSRC",
    mp4: `${FF}ISRC`,
    level: "C",
    multi: true,
    source: "recording ISRCs",
    note: "Also the key used to query Deezer for explicit / BPM / gain.",
  },
  {
    field: "acoustid",
    vorbis: "ACOUSTID_ID",
    id3: "TXXX:Acoustid Id",
    mp4: `${FF}Acoustid Id`,
    level: "C",
    source: "AcoustID",
  },
  {
    field: "acoustid_fingerprint",
    vorbis: "ACOUSTID_FINGERPRINT",
    id3: "TXXX:Acoustid Fingerprint",
    mp4: `${FF}Acoustid Fingerprint`,
    level: "O",
    source: "fpcalc (Chromaprint)",
    note: "Bulky (≈ 2 KB per track) — optional, off by default.",
  },
]);

/* ------------------------------------------------------- §2.6 Loudness (rsgain) */

const LOUDNESS = group("loudness", [
  {
    field: "replaygain_track_gain",
    vorbis: "REPLAYGAIN_TRACK_GAIN",
    id3: "TXXX:REPLAYGAIN_TRACK_GAIN",
    mp4: `${FF}REPLAYGAIN_TRACK_GAIN`,
    level: "R",
    source: "rsgain",
  },
  {
    field: "replaygain_track_peak",
    vorbis: "REPLAYGAIN_TRACK_PEAK",
    id3: "TXXX:REPLAYGAIN_TRACK_PEAK",
    mp4: `${FF}REPLAYGAIN_TRACK_PEAK`,
    level: "R",
    source: "rsgain",
  },
  {
    field: "replaygain_track_range",
    vorbis: "REPLAYGAIN_TRACK_RANGE",
    id3: "TXXX:REPLAYGAIN_TRACK_RANGE",
    mp4: `${FF}REPLAYGAIN_TRACK_RANGE`,
    level: "O",
    source: "rsgain",
  },
  {
    field: "replaygain_album_gain",
    vorbis: "REPLAYGAIN_ALBUM_GAIN",
    id3: "TXXX:REPLAYGAIN_ALBUM_GAIN",
    mp4: `${FF}REPLAYGAIN_ALBUM_GAIN`,
    level: "R",
    albumScope: true,
    source: "rsgain (whole album at once)",
    note: "Only correct once every track of the album is on disk.",
  },
  {
    field: "replaygain_album_peak",
    vorbis: "REPLAYGAIN_ALBUM_PEAK",
    id3: "TXXX:REPLAYGAIN_ALBUM_PEAK",
    mp4: `${FF}REPLAYGAIN_ALBUM_PEAK`,
    level: "R",
    albumScope: true,
    source: "rsgain",
  },
  {
    field: "replaygain_album_range",
    vorbis: "REPLAYGAIN_ALBUM_RANGE",
    id3: "TXXX:REPLAYGAIN_ALBUM_RANGE",
    mp4: `${FF}REPLAYGAIN_ALBUM_RANGE`,
    level: "O",
    albumScope: true,
    source: "rsgain",
  },
  {
    field: "replaygain_reference_loudness",
    vorbis: "REPLAYGAIN_REFERENCE_LOUDNESS",
    id3: "TXXX:REPLAYGAIN_REFERENCE_LOUDNESS",
    mp4: `${FF}REPLAYGAIN_REFERENCE_LOUDNESS`,
    level: "O",
    source: "rsgain",
    note: "−18 LUFS.",
  },
  {
    field: "r128_track_gain",
    vorbis: "R128_TRACK_GAIN",
    id3: null,
    mp4: null,
    level: "R",
    source: "rsgain (Opus output)",
    note: "Opus only, Q7.8 fixed point relative to −23 LUFS. Written alongside REPLAYGAIN_*.",
  },
  {
    field: "r128_album_gain",
    vorbis: "R128_ALBUM_GAIN",
    id3: null,
    mp4: null,
    level: "R",
    albumScope: true,
    source: "rsgain (Opus output)",
    note: "Opus only.",
  },
]);

/* ------------------------------------------------------- §2.6 Audio analysis */

const ANALYSIS = group("analysis", [
  {
    field: "bpm",
    vorbis: "BPM",
    id3: "TBPM",
    mp4: "tmpo",
    level: "C",
    source: "Deezer (by ISRC), local analysis fallback",
  },
  {
    field: "key",
    vorbis: "KEY",
    id3: "TKEY",
    mp4: `${FF}initialkey`,
    level: "O",
    source: "local analysis",
  },
]);

/* ------------------------------------------- §2.6 Lyrics, artwork and explicit */

const LYRICS_ARTWORK = group("lyrics-artwork", [
  {
    field: "explicit",
    vorbis: "ITUNESADVISORY",
    id3: "TXXX:ITUNESADVISORY",
    mp4: "rtng",
    level: "C",
    source: "Deezer explicit_lyrics by ISRC · MB disambiguation · you",
    note: "1 = explicit, 2 = clean.",
  },
  {
    field: "lyrics",
    vorbis: "LYRICS",
    id3: "USLT",
    mp4: "©lyr",
    level: "C",
    source: "LRCLIB (synced LRC, plain text fallback)",
    note: "LRCLIB's `instrumental` marks the field n/a instead of missing. Synced lyrics also go to SYLT in ID3 and to the .lrc sidecar.",
  },
  {
    field: "lyrics_synced",
    vorbis: "LYRICS",
    id3: "SYLT",
    mp4: null,
    level: "O",
    source: "LRCLIB (synced LRC)",
    note: "The ID3 half of the row above: SYLT carries the timestamps USLT cannot.",
  },
  {
    field: "front_cover",
    vorbis: "METADATA_BLOCK_PICTURE",
    id3: "APIC:3",
    mp4: "covr",
    level: "R",
    source: "Cover Art Archive > cropped YouTube thumbnail",
    note: "Opus and FLAC: a FLAC picture block in base64. Projected apart from the text tags.",
  },
  {
    field: "back_cover",
    vorbis: "METADATA_BLOCK_PICTURE",
    id3: "APIC:4",
    mp4: "covr",
    level: "O",
    source: "Cover Art Archive",
    note: "Optional back cover (§2.6, “back en option”).",
  },
]);

/* --------------------------------------------------- §2.6 Provenance and misc */

const PROVENANCE = group("provenance", [
  {
    field: "comment",
    vorbis: "COMMENT",
    id3: "COMM",
    mp4: "©cmt",
    level: "R",
    source: "YouTube",
    note: "“Source: youtu.be/… · imported <date> by Music Manager <ver>” — provenance you can grep.",
  },
  {
    field: "encodedby",
    vorbis: "ENCODEDBY",
    id3: "TENC",
    mp4: "©too",
    level: "O",
    source: "yt-dlp version",
  },
  {
    field: "encodersettings",
    vorbis: "ENCODERSETTINGS",
    id3: "TSSE",
    mp4: "©too",
    level: "O",
    source: "yt-dlp format id + codec",
  },
  {
    field: "originalfilename",
    vorbis: "ORIGINALFILENAME",
    id3: "TOFN",
    mp4: null,
    level: "O",
    source: "`<youtube id>.<ext>`",
  },
  {
    field: "musicmanager_tagschema",
    vorbis: "MUSICMANAGER_TAGSCHEMA",
    id3: "TXXX:MUSICMANAGER_TAGSCHEMA",
    mp4: `${FF}MUSICMANAGER_TAGSCHEMA`,
    level: "R",
    source: "application",
    note: "The projection version that wrote this file; drives the background re-tag.",
  },
  {
    field: "musicmanager_importid",
    vorbis: "MUSICMANAGER_IMPORTID",
    id3: "TXXX:MUSICMANAGER_IMPORTID",
    mp4: `${FF}MUSICMANAGER_IMPORTID`,
    level: "R",
    source: "application",
  },
  {
    field: "musicmanager_sourceurl",
    vorbis: "MUSICMANAGER_SOURCEURL",
    id3: "TXXX:MUSICMANAGER_SOURCEURL",
    mp4: `${FF}MUSICMANAGER_SOURCEURL`,
    level: "R",
    source: "application",
    note: "Machine-readable twin of COMMENT.",
  },
]);

/** The whole table, in documentation order. This is the only source of tag names. */
export const TAGS: readonly TagDefinition[] = Object.freeze([
  ...IDENTITY,
  ...RELEASE,
  ...CREDITS,
  ...CLASSIFICATION,
  ...IDENTIFIERS,
  ...LOUDNESS,
  ...ANALYSIS,
  ...LYRICS_ARTWORK,
  ...PROVENANCE,
]);

/** Every `field` name of the table — the vocabulary a `TrackDocument` may use. */
export type TagField = (typeof TAGS)[number]["field"];

const BY_FIELD = new Map(TAGS.map((tag) => [tag.field, tag]));

/** Look a tag up by its internal field name. */
export function tagByField(field: string): TagDefinition | undefined {
  return BY_FIELD.get(field);
}

/** Look a tag up by its Vorbis key. Several fields may share one (LYRICS, the pictures). */
export function tagsByVorbisKey(key: string): TagDefinition[] {
  return TAGS.filter((tag) => tag.vorbis === key);
}

/** The key a tag takes in `format`, or `null` when that format has no equivalent. */
export function keyFor(tag: TagDefinition, format: TagFormat): string | null {
  switch (format) {
    case "vorbis":
      return tag.vorbis;
    case "id3v24":
      return tag.id3;
    case "mp4":
      return tag.mp4;
  }
}

/** Fields that must carry the same value on every track of an album (§2 notes). */
export const ALBUM_SCOPE_FIELDS: readonly string[] = Object.freeze(
  TAGS.filter((tag) => tag.albumScope).map((tag) => tag.field),
);

/** Weight of a level in the completeness score (§6): R = 3, C = 2, O = 1. */
export const LEVEL_WEIGHT: Readonly<Record<TagLevel, number>> = Object.freeze({
  required: 3,
  recommended: 2,
  optional: 1,
});
