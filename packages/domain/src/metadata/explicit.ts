/**
 * Whether the advisory tag is written at all (`docs/03-metadonnees.md` §2.6, issue #5, D5-01).
 *
 * `ITUNESADVISORY` is a store convention — the iTunes Store's `1` explicit / `2` clean — that
 * players now draw in their own UI: Symfonium puts a “C”/“E” badge in front of every title on an
 * album page. On the owner's 4,000-file library it was on 3,236 files, and no listener asked for
 * it.
 *
 * The flag is *not* what the app knows. Matching ranks on the release's own comment
 * (`matching/signals.ts`, `explicitPenalty`) and on the `explicitPreference` setting; it never
 * reads Deezer and never reads this tag, so nothing here can move a candidate. The verify table
 * reads the file rather than the document — the other reason the setting only decides what is
 * *written* (D5-01): off, `explicit` is `n/a` with the reason “disabled by settings”, the same
 * sentence every other field a setting switched off answers with, which is what the Console
 * prints next to the `n/a`. `patch.na` records no value, so the fact survives in the raw cache
 * alone — Deezer's answer is still there for a later re-resolution, and no document source
 * carries it.
 */

/** What the setting is worth when nobody chose: the behaviour issue #5 asks for. */
export const DEFAULT_WRITE_EXPLICIT_TAG = false;

/** Whether the advisory is written, and — when it is not — why not. */
export interface ExplicitTagDecision {
  readonly write: boolean;
  /** The reason recorded as `n/a`, so completeness reads the field as “not applicable”. */
  readonly reason: string | null;
}

/**
 * A boolean is the whole decision, where the work fields needed a three-valued ladder: nobody
 * asked for a middle position between writing the advisory and not writing it.
 */
export function decideExplicitTag(write: boolean): ExplicitTagDecision {
  return write ? { write: true, reason: null } : { write: false, reason: "disabled by settings" };
}
