/**
 * The versioned tag schema (`docs/03-metadonnees.md` §1, §8).
 *
 * Every file we write carries `MUSICMANAGER_TAGSCHEMA=<n>`. When the projection changes — a
 * new field, a new convention — this number goes up, and a background job re-tags the files
 * that are behind **from the raw cache, with no network and no re-download**, showing a diff
 * per file before it writes anything.
 *
 * Rules for bumping:
 *  1. add the resolver(s) and the tag-map entries;
 *  2. add an entry at the top of `TAG_SCHEMA_CHANGELOG` naming every key that changes;
 *  3. raise `TAG_SCHEMA_VERSION`;
 *  4. re-generate the golden files and read the diff — it is the review.
 */

export const TAG_SCHEMA_VERSION = 7;

export interface TagSchemaChange {
  readonly version: number;
  /** `YYYY-MM-DD`. */
  readonly at: string;
  /** Vorbis keys added by this version. */
  readonly added: readonly string[];
  /** Vorbis keys whose value or formatting changed. */
  readonly changed: readonly string[];
  /** Vorbis keys no longer written. */
  readonly removed: readonly string[];
  readonly note: string;
}

/** Newest first. */
export const TAG_SCHEMA_CHANGELOG: readonly TagSchemaChange[] = Object.freeze([
  {
    version: 7,
    at: "2026-09-21",
    added: [],
    changed: [
      "ARTIST",
      "ALBUMARTIST",
      "COMPOSER",
      "COMPOSERSORT",
      "LYRICIST",
      "WRITER",
      "ARRANGER",
      "CONDUCTOR",
      "PRODUCER",
      "ENGINEER",
      "MIXER",
      "REMIXER",
      "DJMIXER",
      "DIRECTOR",
      "PERFORMER",
      "MUSICBRAINZ_COMPOSERID",
      "MUSICBRAINZ_LYRICISTID",
      "MUSICBRAINZ_PRODUCERID",
      "MUSICBRAINZ_ENGINEERID",
      "MUSICBRAINZ_MIXERID",
      "MUSICBRAINZ_REMIXERID",
      "MUSICBRAINZ_DJMIXERID",
      "MUSICBRAINZ_CONDUCTORID",
      "MUSICBRAINZ_ARRANGERID",
      "MUSICBRAINZ_PERFORMERID",
    ],
    removed: [],
    note: "Issue #19: a special-purpose artist is not a credit. MusicBrainz points a relation at `[traditional]`, `[unknown]`, `[no artist]`… when nobody is to be credited, and that row was reaching the tags — a traditional song was tagged COMPOSER=[traditional] with MUSICBRAINZ_COMPOSERID pointing at a placeholder. Such a relation now produces no credit field at all: the field is n/a (“MusicBrainz special-purpose artist”) instead of carrying a bracketed non-name, and a real composer credited beside a `[traditional]` co-writer still reaches COMPOSER. Dropping a credit entry no longer takes the join phrase that joins the two names around it with it, so `A feat. [unknown] & B` reads `A & B` in ARTIST rather than `A feat. B`. The match is by MBID, never by name. The re-tag repairs the library offline from the raw cache.",
  },
  {
    version: 6,
    at: "2026-09-21",
    added: [],
    changed: [
      "ARTIST",
      "ARTISTS",
      "ARTISTSORT",
      "MUSICBRAINZ_ARTISTID",
      "ALBUMARTIST",
      "ALBUMARTISTS",
      "ALBUMARTISTSORT",
      "MUSICBRAINZ_ALBUMARTISTID",
      "LABEL",
      "CATALOGNUMBER",
    ],
    removed: [],
    note: "Issue #6: a MusicBrainz special-purpose entity is not a value. A credit that names `[unknown]`, `[no artist]`, `[dialogue]`… names nobody, so the entry is dropped and the four credit fields are n/a (“MusicBrainz special-purpose artist”) instead of carrying a bracketed non-name; `label-info` pointing at `[no label]` leaves LABEL n/a (“MusicBrainz special-purpose label”), and `[none]`, the string the style guide asks an editor to type when a release has no catalogue number, is no longer a catalogue number. The match is by MBID, never by name, so a real bracketed label such as `[PIAS]` still reaches its tag, and `Various Artists` is deliberately kept: it is the row that sets COMPILATION. The `label`/`catalognumber` pair is album-scope, so the union no longer propagates `[no label]` across an album's tracks. The re-tag repairs the library offline from the raw cache: 78 files out of ~4,000 carry LABEL=[no label] today.",
  },
  {
    version: 5,
    at: "2026-09-21",
    added: [],
    changed: [],
    removed: ["ITUNESADVISORY", "SUBTITLE"],
    note: "Issue #5: two tags leaked editorial metadata into the player's UI. ITUNESADVISORY is a store convention (1 = explicit, 2 = clean) that Symfonium draws as a “C”/“E” badge in front of every title; it is now written only when the new `writeExplicitTag` setting is on, and `explicit` is n/a (“disabled by settings”) otherwise — the value is still resolved and matching still ranks with `explicitPreference`. SUBTITLE received the MusicBrainz recording disambiguation, which tells two recordings apart in the database rather than subtitling a track; it is now n/a (“MusicBrainz disambiguation is an editor note”) and nothing writes it. The re-tag removes both from existing files, offline, from the raw cache.",
  },
  {
    version: 4,
    at: "2026-09-21",
    added: [],
    changed: [],
    removed: ["WORK", "MOVEMENT", "MOVEMENTNUMBER", "MOVEMENTTOTAL", "SHOWMOVEMENT"],
    note: "Issue #4: `WORK` is display metadata, not an identifier, and MusicBrainz links a work to any recording that performs one — so writing it unconditionally put the track's own title in a header on every pop album, which a player that groups by work (Symfonium, from 13.3.0) then shows. The work fields are now written on classical releases only (the release group carries a `classical` genre, or the release has the classical shape), unless the new `writeWorkTags` setting says `always`; `never` writes none of them. MUSICBRAINZ_WORKID is written either way, and the re-tag repairs a library offline from the raw cache.",
  },
  {
    version: 3,
    at: "2026-09-13",
    added: [],
    changed: [
      "ARTIST",
      "ARTISTS",
      "ALBUMARTIST",
      "ALBUMARTISTS",
      "ALBUM",
      "ALBUMSORT",
      "TITLE",
      "TITLESORT",
    ],
    removed: [],
    note: "Picard's “translate names to this locale”: with a preferred locale set, artist and album names are taken from the MusicBrainz alias of that locale (梶浦由記 → Yuki Kajiura) and the originals move into ALBUMSORT and TITLESORT, which MusicBrainz otherwise leaves empty. ARTISTSORT is unchanged — the sort-name already holds the original. **With the default empty locale nothing changes at all**, and that is what the golden files assert; the bump exists so a library tagged before the setting existed is re-projected the day somebody chooses one.",
  },
  {
    version: 2,
    at: "2026-09-07",
    added: [],
    changed: [
      "the 36 album-scope keys now carry the album's value on every track, not the recording's",
      "GENRE",
      "MOOD",
      "COPYRIGHT",
      "LABEL",
      "CATALOGNUMBER",
    ],
    removed: [],
    note: "`albumScope: true` was a claim the pipeline did not keep: GENRE came from the recording and COPYRIGHT from each video's ℗ line, so any album that was not mono-genre split itself on Navidrome and lost 0.02 of score per field. `albumscope/rules.ts` now names one value per album-scope field and the `tag` step writes it on every track; the re-tag repairs the files already in the library, offline.",
  },
  {
    version: 1,
    at: "2026-09-05",
    added: ["the complete Picard superset of docs/03-metadonnees.md §2 — 103 keys"],
    changed: [],
    removed: [],
    note: "First projection. v1 wrote a much smaller set and is not upgraded in place: the v2 library is imported from scratch.",
  },
]);

/** True when a file written with `version` must be re-tagged. */
export function needsRetag(version: number | undefined): boolean {
  return version === undefined || version < TAG_SCHEMA_VERSION;
}
