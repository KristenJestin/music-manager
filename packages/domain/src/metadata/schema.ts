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

export const TAG_SCHEMA_VERSION = 4;

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
