/**
 * "Expanded Edition", "Deluxe", "Bonus Track Version" — the words a YouTube playlist title
 * carries that MusicBrainz never published.
 *
 * The placeholder that used to live here is gone: `fix-matching-exactness` landed the real
 * stripper in `packages/domain/src/normalize/title.ts`, and the matcher's own fallback and this
 * button now read the same vocabulary out of the same module. A second, shorter list here would
 * have been a card offering a search the matcher would not have run, or refusing one it would.
 *
 * One contract had to be translated rather than re-exported, and it is worth saying why.
 * `@mm/domain`'s `stripEditionQualifier` returns a **string**, unchanged when there is nothing
 * to strip, because that is what a search query wants: one call, always a usable title. The
 * card wants the opposite reading — *is* there a qualifier, and what is underneath it — and it
 * greys the button out on `null`. `hasEditionQualifier` is the domain's own answer to the first
 * half, so `editionBaseTitle` below is those two composed and nothing else: no second
 * vocabulary, no second opinion about what counts as an edition.
 */
export { hasEditionQualifier, stripEditionQualifier } from "@mm/domain";

import { hasEditionQualifier, stripEditionQualifier, stripReleaseTypePrefix } from "@mm/domain";

/**
 * What an import's own title reads without its edition qualifier, or `null`.
 *
 * The import row's title is the *playlist* title, which for a YouTube-generated release reads
 * "Album - The Best Damn Thing (Expanded Edition)". `stripReleaseTypePrefix` is what the
 * matcher's own hints already apply to that same string (`packages/domain/src/matching/hints.ts`),
 * so applying it here too is what makes the button's label and the search it launches describe
 * one title rather than two.
 *
 * `null` is "there is nothing to drop", and it is what greys the button out, so "this title has
 * a qualifier" and "this is what it reads without it" stay one answer rather than two calls
 * that can disagree.
 *
 * One function, called by the card to decide whether to offer the button and by the server
 * function to decide what to search for. Two spellings of this would be one spelling too many.
 */
export function editionBaseTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined || title.trim() === "") return null;
  const stated = stripReleaseTypePrefix(title);
  if (!hasEditionQualifier(stated)) return null;
  const base = stripEditionQualifier(stated);
  return base.trim() === "" ? null : base;
}
