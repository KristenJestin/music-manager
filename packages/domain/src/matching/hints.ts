/**
 * What the source listing believes the album is, before MusicBrainz is asked.
 *
 * This lives in the engine, not in the service, for one reason: it has to be computed **the
 * same way everywhere**. The `match` step, the `mm match` command and the cassette recorder
 * all feed the same scorer, and the hints are an input to it — a label read in one place and
 * left null in another is enough to reorder two near-identical pressings, send the lookup
 * budget to a different six candidates, and make a recording unreplayable. That is not a
 * hypothetical: it is what happened the first time these three derived their own.
 *
 * Two sources, in order of trust:
 *
 *  1. the YouTube Music tags (`album`, `artist`, `release_year`), taken by majority across the
 *     listing — a playlist where twelve of fifteen entries say "Discovery" is a Discovery
 *     playlist, whatever the other three say;
 *  2. the auto-generated description, parsed by `normalize/youtube-description.ts`, which is
 *     the only place the **label** ("Provided to YouTube by …") and the exact release date
 *     ("Released on: …") ever appear.
 */

import { parseYouTubeDescription } from "../normalize/youtube-description.ts";
import type { AlbumHints, MatchVideo } from "./types.ts";

/** The most frequent non-empty value, or `null`. Ties go to the first seen, for determinism. */
function majority<T>(values: readonly (T | null | undefined)[]): T | null {
  const counts = new Map<T, number>();
  const order: T[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (!counts.has(value)) order.push(value);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const value of order) {
    const count = counts.get(value) ?? 0;
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** What a caller already knows from elsewhere — the import row's own title/artist/year. */
export interface HintFallback {
  readonly album?: string | null;
  readonly artist?: string | null;
  readonly year?: number | null;
}

/**
 * Derive the album hints from a listing.
 *
 * The description is read from the **first video that has one**, because YouTube's
 * auto-generated blurb repeats the same album, label and release date on every entry of a
 * playlist; reading all fifteen would cost fifteen parses to learn one fact.
 */
export function albumHints(videos: readonly MatchVideo[], fallback: HintFallback = {}): AlbumHints {
  const described = videos.find(
    (video) => video.description != null && video.description.trim() !== "",
  );
  const parsed =
    described?.description == null ? null : parseYouTubeDescription(described.description);

  return {
    album:
      majority(videos.map((video) => video.ytAlbum)) ?? parsed?.album ?? fallback.album ?? null,
    artist:
      majority(videos.map((video) => video.ytArtist ?? video.uploader)) ??
      parsed?.albumArtist ??
      fallback.artist ??
      null,
    year:
      majority(videos.map((video) => video.ytReleaseYear)) ?? parsed?.year ?? fallback.year ?? null,
    // Only the description ever says this, and it names the current distributor rather than
    // the original imprint — which is why `labelScore` treats a mismatch so gently.
    label: parsed?.label ?? null,
    releasedOn: parsed?.releasedOn ?? null,
  };
}
