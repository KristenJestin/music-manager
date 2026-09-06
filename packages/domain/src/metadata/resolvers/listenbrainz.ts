/**
 * ListenBrainz community tags → `GENRE` and `MOOD` (`docs/03-metadonnees.md` §4).
 *
 * The last fallback of the genre chain (MB > Last.fm > ListenBrainz), and the same shape as
 * `fromLastfmTags` on purpose: two sources of folksonomy differing only in where the JSON
 * came from should not differ in how the tags are filtered. `vocabulary.ts` is shared.
 *
 * ListenBrainz counts *are* vote counts, unlike Last.fm's 0–100 popularity, so `minCount`
 * bites harder here — which is right: a genre one person typed once is not a genre.
 */

import type { DocumentPatch } from "../document.ts";
import { PatchBuilder } from "./patch.ts";
import { genresFromTags, moodsFromTags, type CountedTag } from "./vocabulary.ts";

export interface ListenBrainzTagInput {
  readonly tag?: string;
  readonly count?: number;
  readonly genre_mbid?: string;
}

export interface ListenBrainzOptions {
  readonly fetchedAt: string;
  readonly limit?: number;
  readonly minCount?: number;
}

export function countedTags(tags: readonly ListenBrainzTagInput[]): CountedTag[] {
  return tags
    .map((tag) => ({ name: tag.tag ?? "", count: tag.count ?? 0 }))
    .filter((tag) => tag.name !== "");
}

export function fromListenBrainzTags(
  tags: readonly ListenBrainzTagInput[],
  options: ListenBrainzOptions,
): DocumentPatch {
  const patch = new PatchBuilder("listenbrainz", options.fetchedAt, 0.6);
  const counted = countedTags(tags);

  patch.set(
    "genre",
    genresFromTags(counted, { limit: options.limit ?? 3, minCount: options.minCount ?? 0 }),
  );
  patch.set("mood", moodsFromTags(counted, options.minCount ?? 0));

  return patch.build();
}
