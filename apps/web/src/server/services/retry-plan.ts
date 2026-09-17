/**
 * Which steps an import can be retried from, and what each one redoes — **in words**.
 *
 * `retryJob` has always taken a step; the Console has never offered one. So a finished album
 * could only be retried from its resume point, which for a `done` job is `verify`, and forcing a
 * re-match meant `mm retry --step match` in a terminal. Fifteen of the owner's finished albums
 * were in that state. This module is the list the menu draws, and the sentences it draws.
 *
 * **It imports nothing but the vocabulary**, on purpose. The menu is rendered in the browser and
 * the same list validates the request on the server, and one list is the only way those two can
 * agree; `client-boundary.guard.test.ts` lets client code reach a `server/**` module exactly when
 * it can *prove* the module is pure, so purity here is checked rather than promised. Keep it that
 * way: one `drizzle-orm` import and the Console starts shipping a Postgres driver to a visitor.
 *
 * Two rules decide the list, and both are about not offering nonsense:
 *
 *  1. **Never past the head.** An import that has never downloaded cannot re-run `place`, and a
 *     menu that offers it is a menu that produces a confusing failure. The ceiling is the
 *     import's own `step`, which is how far it has got.
 *  2. **`confirm` is not on it.** It is a gate, not work: rewinding to it and rewinding to
 *     `match` differ only in whether the mapping is recomputed, which is precisely what the two
 *     entries around it already say in words. A third entry whose difference nobody can state is
 *     how a menu stops being read.
 */
import { STEPS, type ImportStatus, type StepName } from "#/server/db/schema/enums.vocab.ts";

/**
 * Every step but `confirm`, which is a gate rather than work — see the module header.
 *
 * A type and not a comment, so `DESCRIPTIONS` below is exhaustive by the compiler's reckoning:
 * a ninth step added to the pipeline and forgotten here is a build error, not a menu entry that
 * renders `undefined`.
 */
export type RetryStep = Exclude<StepName, "confirm">;

const isRetryStep = (step: StepName): step is RetryStep => step !== "confirm";

/** One entry of the Retry menu. */
export interface RetryOption {
  readonly step: RetryStep;
  /** The menu row: what the step is called, as the pipeline calls it. */
  readonly label: string;
  /** What re-running from here will redo, in one sentence a person can act on. */
  readonly detail: string;
  /**
   * True when running it throws away work that is not merely recomputable — a mapping somebody
   * confirmed, or the listing the mapping is indexed against. The Console must confirm these
   * before running them, and must say what is lost in the dialog rather than in a tooltip.
   */
  readonly destructive: boolean;
  /** The sentence the confirmation shows. `null` exactly when `destructive` is false. */
  readonly warning: string | null;
}

/**
 * The eight steps, minus `confirm`, each with the sentence that says what it costs.
 *
 * `download` and everything after it are cheap in the only sense that matters here: they can be
 * run again without any decision being lost. `download` re-fetches only what has no file;
 * `tag` and `place` rewrite from the database, which is the source of truth for metadata; and
 * `verify` reads the library back and writes nothing to it at all.
 */
const DESCRIPTIONS: Readonly<Record<RetryStep, Omit<RetryOption, "step">>> = {
  resolve: {
    label: "Re-read the source",
    detail:
      "Asks the source for its listing again, then redoes everything after it. The videos, the " +
      "match and the confirmed release all come back from scratch.",
    destructive: true,
    warning:
      "Re-reading the source discards the confirmed release and the video → track mapping, and " +
      "the import will ask to be matched again. Files already downloaded are kept.",
  },
  match: {
    label: "Match again",
    detail:
      "Asks MusicBrainz again and rebuilds the video → track mapping. The release currently " +
      "confirmed on this import is discarded.",
    destructive: true,
    warning:
      "Matching again throws away the confirmed release and the video → track mapping, and the " +
      "import will ask to be confirmed again. Files already downloaded are kept.",
  },
  download: {
    label: "Download again",
    detail:
      "Fetches the audio for any track that has no file yet. The mapping and the confirmed " +
      "release are kept, and tracks already on disk are not fetched twice.",
    destructive: false,
    warning: null,
  },
  fingerprint: {
    label: "Fingerprint again",
    detail:
      "Fingerprints the files on disk and re-checks them against the mapping. Nothing is " +
      "downloaded and no tags are written.",
    destructive: false,
    warning: null,
  },
  tag: {
    label: "Rebuild the tags",
    detail:
      "Rebuilds the metadata document from the database and writes the tags again — the step to " +
      "run after changing a field by hand or after a tag-schema change.",
    destructive: false,
    warning: null,
  },
  place: {
    label: "File into the library again",
    detail:
      "Moves the tracks into the library under the current path template. Useful after the " +
      "template or the album's metadata changed.",
    destructive: false,
    warning: null,
  },
  verify: {
    label: "Check this album again",
    detail:
      "Reads the album back from the library and re-checks it. Changes nothing on disk — this " +
      "is what the plain Retry does on a finished import.",
    destructive: false,
    warning: null,
  },
};

/** The order the menu shows, which is the pipeline's own. */
const OFFERED: readonly RetryStep[] = STEPS.filter(isRetryStep);

/**
 * The steps this import can sensibly be retried from, in pipeline order.
 *
 * `cancelled` gets an empty list, matching the Console: a cancelled import has nothing to offer
 * and its Retry button is not drawn. Everything else is offered every work step from `resolve` up
 * to and including the furthest it has reached — which for a `done` album is all seven, and that
 * is the point of this whole change.
 */
export function retryOptionsFor(job: {
  readonly status: ImportStatus;
  readonly step: StepName;
}): RetryOption[] {
  if (job.status === "cancelled") return [];
  const ceiling = STEPS.indexOf(job.step);
  return OFFERED.filter((step) => STEPS.indexOf(step) <= ceiling).map((step) => ({
    step,
    ...DESCRIPTIONS[step],
  }));
}

/**
 * Whether rewinding to `step` has to forget the confirmed mapping.
 *
 * `match` reads a supplied mapping out of `imports.options` and applies it verbatim — that is
 * the escape hatch `confirm-mapping` and `confirm-best` both write through. So rewinding to
 * `match` without clearing it would re-apply the very mapping the person asked to be rid of, and
 * "Match again" would be a button that changed nothing. `resolve` implies `match`, and its own
 * listing is what the mapping's positions are indexed against, so it clears it too.
 */
export function forgetsMapping(step: StepName): boolean {
  return step === "resolve" || step === "match";
}
