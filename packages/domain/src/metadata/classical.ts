/**
 * Is this release classical — and should its work fields be written? (`docs/03-metadonnees.md`
 * §2.4, issue #4.)
 *
 * `WORK` is not an identifier like `MUSICBRAINZ_WORKID`: it is a *display* value that players
 * act on. Symfonium, from 13.3.0, groups an album's tracks by work whenever the tag is there
 * ("Group classical tracks by their work metadata", on by default), which is what a symphony's
 * four movements want and what a pop album does not: there the work carries the track's own
 * name, so every song grows a header repeating it. MusicBrainz links a work to *any* recording
 * that performs one, pop and soundtracks included, so writing it unconditionally puts one line
 * of noise per track on 98% of a library.
 *
 * The predicate and the decision live here, next to `CLASSICAL_FIELDS` and away from the
 * resolver, because `verify` and the tag map want the same truth (D4-01).
 *
 * Two ways a release is classical, and the first one decides:
 *
 *  1. **the release group carries it** — a genre or tag naming `classical` (`classical`,
 *     `contemporary classical`, `cinematic classical`), which is what MusicBrainz's own
 *     community votes are for;
 *  2. **the release has the classical shape** — a composer credit *and* a work that carries a
 *     catalogue number (`Op. 67`, `BWV 1043`, `K. 622`) or movements.
 *
 * Both read the raw cache the pipeline already fetched: `releaseFull` asks for `release-groups`
 * and `genres`, and the work comes with its own relations. Nothing here needs a new lookup.
 */

/** The `writeWorkTags` setting (D4-03): one key, three values, no boolean. */
export const WRITE_WORK_TAGS = ["classical", "always", "never"] as const;
export type WriteWorkTags = (typeof WRITE_WORK_TAGS)[number];

/** What the setting is worth when nobody chose: the behaviour issue #4 asks for. */
export const DEFAULT_WRITE_WORK_TAGS: WriteWorkTags = "classical";

/** The fields the decision owns — `WORK` plus §2.4's movement block. */
export const WORK_TAG_FIELDS = [
  "work",
  "movement",
  "movementnumber",
  "movementtotal",
  "showmovement",
] as const;
export type WorkTagField = (typeof WORK_TAG_FIELDS)[number];

/** What the predicate reads of a work. */
export interface ClassicalWorkShape {
  /** The work's title, where a catalogue number is written. */
  readonly title?: string | undefined;
  /** True when the work credits a composer — §2.3's `composer` relation. */
  readonly composer?: boolean | undefined;
  /** How many movements MusicBrainz models under this work. */
  readonly movements?: number | undefined;
}

export interface ClassicalReleaseInput {
  /** Genre **and** tag names of the release group, then of the release itself. */
  readonly genres?: readonly (string | undefined)[] | undefined;
  /** The work the recording performs, when MusicBrainz links one. */
  readonly work?: ClassicalWorkShape | undefined;
}

/**
 * Catalogue references only classical repertoire carries.
 *
 * The alternative set aside was MusicBrainz's work *type* (`Symphony`, `Opera`), which the
 * cache does not hold: `workFull` asks for relations, aliases, tags and genres, never the type
 * block, and inventing a new request to classify a tag we may not write is the wrong trade.
 * The title is already in the payload.
 */
const CATALOGUE_NUMBER = /(?:^|[\s(])(?:op|bwv|hob|hwv|rv|woo|kv|k|d)\.?\s?\d/i;

export function isClassicalRelease(input: ClassicalReleaseInput): boolean {
  if (namesClassical(input.genres)) return true;
  const work = input.work;
  // The shape is a conjunction: a composer credit alone is a pop songwriter, a catalogue
  // number alone is a title that looks like one.
  if (work === undefined || work.composer !== true) return false;
  if ((work.movements ?? 0) > 0) return true;
  return work.title !== undefined && CATALOGUE_NUMBER.test(work.title);
}

/** True when one of the names says `classical` — as a word, so `neoclassical` is not one. */
function namesClassical(names: readonly (string | undefined)[] | undefined): boolean {
  for (const name of names ?? []) {
    if (name === undefined) continue;
    if (
      name
        .toLowerCase()
        .split(/[^a-z]+/)
        .includes("classical")
    )
      return true;
  }
  return false;
}

/** Whether the work fields are written, and — when they are not — why not (D4-02). */
export interface WorkTagsDecision {
  readonly write: boolean;
  /** The reason recorded as n/a, so completeness does not read the field as a hole. */
  readonly reason: string | null;
}

/**
 * `always` and `never` are absolute; `classical` — the default — follows the release.
 *
 * The two reasons are the two scenarios of Spec · metadata.resolve: a pop release and a
 * setting that turned the fields off are different facts about a file, and the Console shows
 * the reason next to the `n/a`.
 */
export function decideWorkTags(mode: WriteWorkTags, classical: boolean): WorkTagsDecision {
  switch (mode) {
    case "always":
      return { write: true, reason: null };
    case "never":
      return { write: false, reason: "disabled by settings" };
    case "classical":
      return classical
        ? { write: true, reason: null }
        : { write: false, reason: "not a classical release" };
  }
}
