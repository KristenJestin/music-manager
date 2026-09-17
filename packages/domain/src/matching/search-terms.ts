/**
 * What a person typed, read as a title and an artist.
 *
 * ## The bug this exists for
 *
 * The wizard's manual search took the whole typed string and put it in **one field**:
 * `lucene.releaseQuery({ album: typed })`. So `bewitched Laufey` asked MusicBrainz for a
 * release literally *titled* "bewitched Laufey", found nothing, and answered "Nothing found for
 * that" — over a record MusicBrainz obviously has. Free text was being treated as one field's
 * exact value.
 *
 * ## What this does, and what it deliberately does not
 *
 * Two fields are the honest answer, and the wizard offers them. This is for the other half:
 * somebody who pastes `Laufey - Bewitched`, which is how a title is written everywhere else.
 * It splits on the separators people actually use and **hands the split back** so the page can
 * show it — a guess that is visible and correctable is useful, and a silent one is the bug one
 * layer along.
 *
 * It is not a query builder. `packages/domain/src/matching/lucene.ts` owns the query, it
 * already takes an artist, and it is being edited on another branch; nothing here touches it.
 */

/**
 * The separators, in the order they are tried.
 *
 * Whitespace on both sides of the dashes is required, so `Jay-Z` and `Non-Stop` are never
 * split; `by` is matched as a whole word for the same reason.
 */
const SEPARATORS: readonly RegExp[] = [/\s+[–—]\s+/, /\s+-\s+/, /\s+\bby\b\s+/i];

export interface SearchTerms {
  readonly title: string;
  readonly artist: string | null;
  /** True when the split was guessed from one string rather than typed into two fields. */
  readonly guessed: boolean;
}

/**
 * Split `Artist - Title`, `Title by Artist`, or neither.
 *
 * **Which side is which.** `A - B` is read as *artist – title*, because that is the order
 * YouTube writes ("Daft Punk - One More Time") and YouTube is where every string here comes
 * from. `A by B` is read the other way round, because that is what "by" means. Both are
 * guesses, both are shown, and the two fields are one click away when a guess is wrong.
 *
 * A string with no separator is a title with no artist, which is exactly what the old code
 * assumed of *every* string — the difference is that it is now true when it is assumed.
 */
export function splitSearchTerms(input: string): SearchTerms {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") return { title: "", artist: null, guessed: false };

  for (const [index, separator] of SEPARATORS.entries()) {
    const match = separator.exec(text);
    if (match === null || match.index <= 0) continue;
    const left = text.slice(0, match.index).trim();
    const right = text.slice(match.index + match[0].length).trim();
    if (left === "" || right === "") continue;
    // The third separator is `by`, which names the artist on the right; the dashes are
    // YouTube's order, which names the artist on the left.
    const byArtist = index === SEPARATORS.length - 1;
    return byArtist
      ? { title: left, artist: right, guessed: true }
      : { title: right, artist: left, guessed: true };
  }

  return { title: text, artist: null, guessed: false };
}

/** The split as one line, for saying out loud what was searched for. */
export function describeSearchTerms(terms: SearchTerms): string {
  return terms.artist === null || terms.artist === ""
    ? `“${terms.title}”`
    : `“${terms.title}” by “${terms.artist}”`;
}
