/**
 * Last.fm top tags → `GENRE` and `MOOD` (`docs/03-metadonnees.md` §4, "repli genres/moods").
 *
 * A **fallback**, and the merge order enforces it: `SOURCE_PRECEDENCE` puts MusicBrainz above
 * Last.fm, so a MusicBrainz genre always wins and this resolver only ever fills a field that
 * would otherwise be missing. That is the §4 preference — MB > Last.fm > ListenBrainz — as a
 * property of the data rather than as a chain of `if`s at the call site.
 *
 * Last.fm's tags are folksonomy at its rawest, so they go through `vocabulary.ts`: no
 * decades, no "seen live", no "female vocalists". Track tags are richer than artist tags when
 * they exist, so a caller passes both and the track's win by list order.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";
import { genresFromTags, moodsFromTags, type CountedTag } from "./vocabulary.ts";

/** One entry of a `toptags.tag` array. */
export interface LastfmTagInput {
  readonly name?: string;
  readonly count?: number;
}

export interface LastfmOptions {
  readonly fetchedAt: string;
  /** How many `GENRE` values at most (`maxGenres`). */
  readonly limit?: number;
  /** Ignore a tag with fewer votes than this (`genreMinCount`). */
  readonly minCount?: number;
}

/**
 * Last.fm counts are a 0–100 popularity, not a vote count: the top tag of a well-known track
 * is always 100. Normalising is pointless, ordering is all that matters, so the count is
 * passed through and only compared against `minCount`.
 */
export function countedTags(tags: readonly LastfmTagInput[]): CountedTag[] {
  return tags
    .map((tag) => ({ name: tag.name ?? "", count: tag.count ?? 0 }))
    .filter((tag) => tag.name !== "");
}

export function fromLastfmTags(
  tags: readonly LastfmTagInput[],
  options: LastfmOptions,
): DocumentPatch {
  const patch = new PatchBuilder("lastfm", options.fetchedAt, 0.7);
  const counted = countedTags(tags);

  // No n/a here, ever: Last.fm having no tag for a track says nothing about whether the track
  // has a genre. Only MusicBrainz is authoritative enough to declare a field non-existent.
  patch.set(
    "genre",
    genresFromTags(counted, { limit: options.limit ?? 3, minCount: options.minCount ?? 0 }),
  );
  patch.set("mood", moodsFromTags(counted, options.minCount ?? 0));

  return patch.build();
}
