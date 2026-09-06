/**
 * What counts as a genre, and what counts as a mood, in a folksonomy.
 *
 * MusicBrainz, Last.fm and ListenBrainz all return "tags": a flat list of whatever their
 * users typed. Most of it is genre, some of it is mood, and a stubborn tail of it is neither
 * — "seen live", "favourites", "00s", "albums i own". Writing that tail into `GENRE` is how a
 * library ends up with a genre called "spotify" (`docs/03-metadonnees.md` §2.4).
 *
 * The three sources share this file so that a tag rejected from MusicBrainz is also rejected
 * from Last.fm. One vocabulary, one rule, three callers.
 */

/** Tags that describe a feeling rather than a style; `MOOD` takes only these. */
export const MOOD_VOCABULARY: ReadonlySet<string> = new Set([
  "aggressive",
  "atmospheric",
  "calm",
  "chill",
  "dark",
  "dreamy",
  "energetic",
  "epic",
  "euphoric",
  "happy",
  "hypnotic",
  "melancholic",
  "melancholy",
  "mellow",
  "nostalgic",
  "party",
  "peaceful",
  "relaxing",
  "romantic",
  "sad",
  "sensual",
  "uplifting",
  "upbeat",
]);

/**
 * Tags that are about the *listener*, not the music. Exact matches only: "favourite" is
 * noise, but "favourite songs of all time" is a playlist name and is caught by the same test
 * because it starts with one of these, which is checked below.
 */
const NON_MUSICAL = [
  "seen live",
  "favourite",
  "favorite",
  "favourites",
  "favorites",
  "albums i own",
  "own it",
  "my music",
  "spotify",
  "soundcloud",
  "youtube",
  "radio",
  "under 2000 listeners",
  "beautiful",
  "awesome",
  "cool",
  "good",
  "best",
  "amazing",
  "love",
  "loved",
  "check out",
  "to listen",
  "want to hear",
  "male vocalists",
  "female vocalists",
  "male vocalist",
  "female vocalist",
  "singer-songwriter-ish",
];

/** A decade or a year — "00s", "1990s", "2001" are dates, not genres. */
const DECADE = /^(?:(?:19|20)?[0-9]0s|(?:19|20)[0-9][0-9])$/;

/** True when a community tag is fit to become a `GENRE` value. */
export function isGenreTag(name: string): boolean {
  const value = name.trim().toLowerCase();
  if (value === "" || value.length > 40) return false;
  if (DECADE.test(value)) return false;
  if (MOOD_VOCABULARY.has(value)) return false;
  return !NON_MUSICAL.some((noise) => value === noise || value.startsWith(`${noise} `));
}

/** True when a community tag belongs in `MOOD`. */
export function isMoodTag(name: string): boolean {
  return MOOD_VOCABULARY.has(name.trim().toLowerCase());
}

/** A community tag as the three sources all express it: a name and a vote count. */
export interface CountedTag {
  readonly name: string;
  readonly count: number;
}

/**
 * The top `limit` genres of a tag list: above `minCount` votes, most voted first, ties broken
 * alphabetically so the same cached response always yields the same document (§8).
 *
 * Names are title-cased on the way out because that is what a library browser shows and what
 * Picard writes; the comparison stays case-insensitive.
 */
export function genresFromTags(
  tags: readonly CountedTag[],
  options: { limit: number; minCount: number },
): string[] {
  const seen = new Set<string>();
  const kept: CountedTag[] = [];
  for (const tag of tags) {
    const name = tag.name.trim();
    if (!isGenreTag(name) || tag.count < options.minCount) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    kept.push({ name, count: tag.count });
  }
  return kept
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, options.limit)
    .map((tag) => titleCase(tag.name));
}

/** The moods of a tag list, in the same order, deduplicated. */
export function moodsFromTags(tags: readonly CountedTag[], minCount = 0): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...tags].sort((a, b) => b.count - a.count)) {
    const lower = tag.name.trim().toLowerCase();
    if (!isMoodTag(lower) || tag.count < minCount || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/** "french house" → "French House"; "R&B" stays "R&B". */
export function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
