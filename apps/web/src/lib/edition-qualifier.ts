/**
 * "Expanded Edition", "Deluxe", "Bonus Track Version" — the words a YouTube playlist title
 * carries that MusicBrainz never published.
 *
 * ## This is a placeholder, and it is meant to be deleted
 *
 * The **automatic** fallback belongs to the matcher and is being built on the branch
 * `fix-matching-exactness`, in `packages/domain/src/normalize/`. Nothing here tries to be that:
 * this file exists only so the "search without the edition qualifier" button on a candidateless
 * review card has something to call while that branch is in flight, and so the shape of what it
 * calls is agreed in advance.
 *
 * **At merge**, delete the body below and make this module one line:
 *
 * ```ts
 * export { stripEditionQualifier } from "@mm/domain";
 * ```
 *
 * The contract the button needs, and the whole of it:
 *
 * > `stripEditionQualifier(title)` returns the title with its edition qualifier removed, or
 * > `null` when the title carries none. Pure; no I/O.
 *
 * A `null` return is what greys the button out, so "this title has a qualifier" and "this is
 * what it reads without it" are one answer rather than two calls that can disagree.
 *
 * It lives in `lib/` rather than in `server/` because both sides need it: the card decides
 * whether to offer the button, and the server function decides what to search for. One module,
 * one answer, and one import to change when the real one lands.
 */
import { stripReleaseTypePrefix } from "@mm/domain";

/**
 * The qualifiers seen in the owner's 30 stuck imports, as whole words.
 *
 * Deliberately short and deliberately dumb. Widening this list is the other branch's job, and
 * a placeholder that grew a vocabulary of its own would be the thing nobody remembers to
 * remove.
 */
const QUALIFIERS = [
  "expanded edition",
  "deluxe edition",
  "deluxe version",
  "deluxe",
  "bonus track version",
  "bonus tracks version",
  "special edition",
  "anniversary edition",
  "remastered edition",
];

/** A trailing `(…)` or `[…]` segment, which is where a qualifier is written. */
const TRAILING_BRACKET = /\s*[([]([^()[\]]*)[)\]]\s*$/;

/**
 * The title without its edition qualifier, or `null` when it has none.
 *
 * Only a *trailing* bracketed segment is considered, and only when the whole of it is one of
 * the qualifiers above: "The Best Damn Thing (Expanded Edition)" is an edition of an album,
 * while "Sgt. Pepper (Remastered 2009)" and "Blue (Live at Wembley)" are not the same record
 * under another name, and stripping those would send the search somewhere else entirely.
 */
export function stripEditionQualifier(title: string): string | null {
  const trimmed = title.trim();
  const match = TRAILING_BRACKET.exec(trimmed);
  if (match === null) return null;
  const inner = (match[1] ?? "").trim().toLowerCase();
  if (!QUALIFIERS.includes(inner)) return null;
  const base = trimmed.slice(0, match.index).trim();
  return base === "" ? null : base;
}

/**
 * What an import's own title reads without its edition qualifier, or `null`.
 *
 * The import row's title is the *playlist* title, which for a YouTube-generated release reads
 * "Album - The Best Damn Thing (Expanded Edition)". `stripReleaseTypePrefix` is what the
 * matcher's own hints already apply to that same string (`packages/domain/src/matching/hints.ts`),
 * so applying it here too is what makes the button's label and the search it launches describe
 * one title rather than two.
 *
 * One function, called by the card to decide whether to offer the button and by the server
 * function to decide what to search for. Two spellings of this would be one spelling too many.
 */
export function editionBaseTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined || title.trim() === "") return null;
  return stripEditionQualifier(stripReleaseTypePrefix(title));
}
