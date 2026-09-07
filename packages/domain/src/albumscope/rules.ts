/**
 * What "album scope" means, field by field (`docs/03-metadonnees.md` §2, §6).
 *
 * The tag map marks 36 tags `albumScope: true`: they must carry the same value on every track
 * of the album, or Navidrome, Jellyfin and Plex group the files into two albums. Marking them
 * is not enough — the pipeline fills several of them from a **per-track** source (the
 * recording's MusicBrainz genres, the ℗ line of each YouTube description), so any album that
 * is not mono-genre diverged by construction and lost `DIVERGENCE_PENALTY` per field.
 *
 * This table is the missing half: for each of those fields, *which set the value must be
 * constant over* and *how one value is chosen* when the tracks disagree. It is data, not
 * control flow, so the Console, the tools and the re-tag all quote the same sentence.
 *
 * Two groupings, because "album" is not always the right set:
 *
 *  - **album** — one value for the whole release. Most of the 36.
 *  - **medium** — one value per disc. `TRACKTOTAL` and `MEDIA` are sourced from the *medium*
 *    (`source: "medium"`, `"medium format"`), so a two-disc release legitimately says 12 on
 *    disc one and 10 on disc two. Forcing those to one value would corrupt the second disc,
 *    and comparing them across the album — which is what the consistency check used to do —
 *    reported a divergence that is not one.
 *
 * This file imports nothing but the tag map: `metadata/document.ts` reads it, and a cycle
 * through the resolvers would be a build error rather than a design.
 */

import { ALBUM_SCOPE_FIELDS } from "../tagmap/tags.ts";

/** The set a value must be constant over. */
export type AlbumScopeGrouping = "album" | "medium";

/**
 * How one value is chosen when the tracks disagree.
 *
 * Every strategy first keeps only the entries from the **best-ranked source** present on the
 * album (`SOURCE_PRECEDENCE`), so one track that fell back to Last.fm cannot outvote twelve
 * that MusicBrainz answered for.
 *
 *  - `majority` — the most frequent value; ties go to the earliest track. For a field the
 *    release already answers for, that is "the release's value", stated without asking twice.
 *  - `union` — the values of every track, most frequent first then alphabetically, capped at
 *    `maxGenres`. A multi-valued field is a *set*: an album whose recordings are tagged
 *    `electropop`, `synth-pop` and `alternative pop` is all three, and picking one would throw
 *    away two true facts to satisfy a constraint that only asks for one *list*.
 *  - `mostSpecific` — the longest rendering among the best-ranked source's values, ties to the
 *    earliest track. `COPYRIGHT` is a legal notice, and one video's description carrying the
 *    full `℗ 2018 CHVRCHES, under exclusive license to Vertigo/Capitol…` while twelve carry
 *    the abbreviated form is not a disagreement about the album — it is twelve truncations of
 *    one sentence.
 */
export type AlbumScopeStrategy = "majority" | "union" | "mostSpecific";

export interface AlbumScopeRule {
  readonly grouping: AlbumScopeGrouping;
  readonly strategy: AlbumScopeStrategy;
  /** Only for `union`: keep at most `maxGenres` values. */
  readonly capped: boolean;
  /** One line, quoted verbatim by the tools and the album's quality tab. */
  readonly why: string;
}

const MAJORITY_WHY =
  "the release answers for it, so the value the most tracks carry is the album's";

const DEFAULT: AlbumScopeRule = Object.freeze({
  grouping: "album",
  strategy: "majority",
  capped: false,
  why: MAJORITY_WHY,
});

const MEDIUM: AlbumScopeRule = Object.freeze({
  grouping: "medium",
  strategy: "majority",
  capped: false,
  why: "the medium answers for it, so it is constant per disc and not across the album",
});

const OVERRIDES: Readonly<Record<string, AlbumScopeRule>> = Object.freeze({
  /* ---- sourced from the medium, not the release ---- */
  totaltracks: MEDIUM,
  totaltracks_alias: MEDIUM,
  media: MEDIUM,

  /* ---- multi-valued sets: the album is the union of what its tracks say ---- */
  genre: Object.freeze({
    grouping: "album",
    strategy: "union",
    capped: true,
    why: "the album's genres are the release group's when MusicBrainz has them, otherwise the union of its tracks' genres, most voted first and capped at `maxGenres`",
  }),
  mood: Object.freeze({
    grouping: "album",
    strategy: "union",
    capped: true,
    why: "the album's moods are the union of its tracks' moods, most frequent first and capped at `maxGenres`",
  }),
  label: Object.freeze({
    grouping: "album",
    strategy: "union",
    capped: false,
    why: "a release can be issued by several labels at once; the album carries all of them",
  }),
  catalognumber: Object.freeze({
    grouping: "album",
    strategy: "union",
    capped: false,
    why: "one catalogue number per label-info entry; the album carries all of them",
  }),
  albumartists: Object.freeze({
    grouping: "album",
    strategy: "majority",
    capped: false,
    why: MAJORITY_WHY,
  }),

  /* ---- a legal notice, taken in its fullest form ---- */
  copyright: Object.freeze({
    grouping: "album",
    strategy: "mostSpecific",
    capped: false,
    why: "the ℗ / © line is per video and often abbreviated; the album keeps the fullest form of it",
  }),
});

/** The rule for one field. Every `albumScope` tag has one; anything else falls back to it. */
export function albumScopeRule(field: string): AlbumScopeRule {
  return OVERRIDES[field] ?? DEFAULT;
}

/** The 36 fields the tag map marks `albumScope`, each with the rule that unifies it. */
export const ALBUM_SCOPE_RULES: readonly (AlbumScopeRule & { readonly field: string })[] =
  Object.freeze(ALBUM_SCOPE_FIELDS.map((field) => ({ field, ...albumScopeRule(field) })));
