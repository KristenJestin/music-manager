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

export const TAG_SCHEMA_VERSION = 2;

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
