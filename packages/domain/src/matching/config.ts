/**
 * The default weights, thresholds and preferences — `docs/04-pipeline-et-matching.md`
 * § Algorithme de présélection, whose weights this file fixes.
 *
 * Two lineages meet here. The **signals** are the ones the documentation lists, and the
 * **relative severity of the penalties** is ported from v1's
 * `MusicBrainzMatcherService.cs`, whose lists were tuned against a real library. What is not
 * ported is v1's *scale*: it accumulated unbounded integer points (`Score * 10`, `-1000` for
 * a non-official release, `+300` for an album) on top of MusicBrainz's own relevance, which
 * made a score impossible to read and impossible to threshold. Everything here is in [0, 1],
 * so "0.95 is safe" means something, and every deduction is named in `penalties`.
 *
 * The mapping between the two scales, kept deliberately: v1's `-200` disambiguation hit
 * (deluxe/live/remaster/…) is the harshest single deduction, `-75` for a compilation is about
 * a third of it, `-30` for an unrecognised comment about a seventh. The ratios survive; the
 * magnitudes are divided by roughly 1000.
 *
 * Everything is a parameter. The service reads these defaults, overlays the `settings` rows,
 * and hands the result down; no scoring function reads a constant it was not given.
 */

import type {
  MatchingConfig,
  MatchingPreferences,
  MatchingThresholds,
  MatchingWeights,
} from "./types.ts";

/**
 * Release weights. They sum to 1, so the blend stays in [0, 1].
 *
 * The **tracklist fit dominates** at 0.26 because `docs/04` says so in as many words: it "est
 * le signal décisif entre éditions d'un même album". Right behind it sits `coverage`, added by
 * decision 152: the fit answers "how much of *this release* do your videos cover", and on its
 * own it is blind in exactly one direction — a one-track single covered by one of your eleven
 * videos fits 1/1, which is a perfect score for importing one eleventh of what you asked for.
 * `coverage` is the other half of the same question, "how many of *your videos* would this
 * release give a track to", and the two together are what the owner's third review calls an
 * honest fit.
 *
 * Title and artist come next — they are what puts a candidate in the list at all, so they
 * discriminate less *within* the list than they look. Format, country, status and — since
 * decision 167 — **cover art** are tie-breakers between pressings of one album, and a label is
 * only ever a corroboration, because "Provided to YouTube by" names the current distributor
 * rather than the original imprint.
 *
 * `coverArt`'s 0.03 was paid for by title, artist and year (0.16/0.16/0.06 → 0.15/0.15/0.05),
 * and the choice is not arbitrary: the two-level search of decision 151 has already agreed on
 * the title and the artist by the time two pressings of one release group are being compared,
 * so those two signals are the ones with the least left to say at exactly the moment this one
 * speaks. The total is still 1.
 */
const RELEASE_WEIGHTS = {
  title: 0.15,
  artist: 0.15,
  durations: 0.26,
  coverage: 0.2,
  trackCount: 0.09,
  year: 0.05,
  label: 0.01,
  format: 0.03,
  status: 0.01,
  country: 0.02,
  coverArt: 0.03,
} as const satisfies MatchingWeights["release"];

/**
 * Recording weights, for a lone video. They sum to 1.
 *
 * Duration carries more here than in the release case: with a single video there is no
 * tracklist to fit, and a ±2 s length agreement is the strongest thing left. The ISRC is
 * decisive when present and simply absent from the denominator when it is not — see
 * `renormalise` in `recording-candidates.ts`.
 */
const RECORDING_WEIGHTS = {
  title: 0.32,
  artist: 0.24,
  duration: 0.28,
  ytTags: 0.1,
  isrc: 0.06,
} as const satisfies MatchingWeights["recording"];

/**
 * Mapping weights, per (video, track) pair. They sum to 1.
 *
 * AcoustID is the heaviest single input when it is there — a fingerprint that names a
 * recording present in the tracklist is near-certain (`docs/04` § `fingerprint`) — and is
 * dropped from the denominator when no fingerprint ran, which is the normal case at `match`
 * time since `fingerprint` comes *after* `download`. Without it the ranking is duration
 * first, title second, playlist position third: position is real evidence on an album and
 * noise on a shuffled playlist, so it must never be able to outvote a duration disagreement.
 */
const MAPPING_WEIGHTS = {
  acoustid: 0.4,
  duration: 0.27,
  title: 0.18,
  position: 0.09,
  ytTrackTag: 0.06,
} as const satisfies MatchingWeights["mapping"];

export const DEFAULT_WEIGHTS: MatchingWeights = {
  release: RELEASE_WEIGHTS,
  recording: RECORDING_WEIGHTS,
  mapping: MAPPING_WEIGHTS,
};

export const DEFAULT_THRESHOLDS: MatchingThresholds = {
  /** `docs/04`: "Le seuil « safe » (défaut 0,95)". It marks; it does not skip `confirm`. */
  safe: 0.95,
  /**
   * v1 used a margin of 40–50 points on a scale where a candidate's base was 900–1000, i.e.
   * about 4 %. Kept, on the normalised scale: two candidates within 0.04 are ambiguous and
   * the Inbox has to ask rather than the engine guess.
   */
  ambiguityMargin: 0.04,
  /**
   * Below this a (video, track) pair is not bound at all: the video becomes an extra and the
   * track stays uncovered. Set above the level a title-only coincidence reaches (~0.2) and
   * below the level a duration+title agreement reaches (~0.6).
   */
  bindingFloor: 0.35,
  /** A bound line under this is shown as `check` rather than `confident`. */
  confidentFloor: 0.9,
  /** `docs/04`: "à ± 2 s". */
  durationToleranceSeconds: 2,
  durationDecaySeconds: 8,
  /** The same 0.87 the `fingerprint` step already uses for its title fallback. */
  titleMatch: 0.87,
  /**
   * How hard a release is hit for the videos it would leave behind (decision 152).
   *
   * The deduction is `coveragePenalty × shortfall²`, where `shortfall` is the share of the
   * source videos the 1:1 assignment binds to nothing. **Quadratic**, and that shape is the
   * whole design: a playlist that carries a radio edit next to the album leaves one video of
   * fifteen over, shortfall 0.067, deduction 0.002 — which is right, because that playlist is
   * ordinary. A one-track single facing eleven videos leaves ten of them over, shortfall
   * 0.909, deduction 0.45 — which is also right, because that candidate is not the record.
   * A linear penalty cannot be both; it either slanders the first case or forgives the second,
   * and the version shipped before this one forgave it at 94 %.
   */
  coveragePenalty: 0.55,
  /**
   * What one surplus video costs, relative to one missing track, in `trackCount`.
   *
   * Still asymmetric — a playlist with an extra radio edit is normal and a release with tracks
   * nobody has a video for means an incomplete import — but no longer *derisory*: at the 0.35
   * it used to be, ten surplus videos against a single cost 0.32 of one signal out of nine,
   * which is the "pénalité dérisoire" of the third owner review (D3).
   */
  trackSurplusCost: 0.7,
};

export const DEFAULT_PREFERENCES: MatchingPreferences = {
  /** `docs/04`: "pays (préférences XW, FR, GB, US)". */
  countries: ["XW", "FR", "GB", "US"],
  /** `docs/04`: "Digital Media préféré pour une source YouTube Music". */
  format: "Digital Media",
  explicit: "either",
};

export const DEFAULT_CONFIG: MatchingConfig = {
  weights: DEFAULT_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  preferences: DEFAULT_PREFERENCES,
};

/** How many candidates get a tracklist lookup, so the fit can be computed for them. */
export const DEFAULT_LOOKUP_LIMIT = 6;

/**
 * How many release *groups* get a release search of their own (decision 151).
 *
 * One group was the old behaviour and the bug the owner reported: "Bad Ideas" is a 2019 album
 * *and* a 2020 single, the search picked the single's group, and the eleven-track album was
 * never a candidate at all — one card, "2 searches and 1 lookup". Three is the number that
 * covers the shapes this actually takes (album / single / EP of the same name, or an album and
 * its deluxe re-issue filed apart) without turning a match into a minute: the budget is
 * `1 + groups` searches, so three groups is four searches, four seconds.
 */
export const DEFAULT_GROUP_LIMIT = 3;

/** Fill in whatever the caller left out. Every entry point takes a partial config. */
export function withDefaults(partial?: DeepPartialConfig): MatchingConfig {
  if (partial === undefined) return DEFAULT_CONFIG;
  return {
    weights: {
      release: { ...DEFAULT_WEIGHTS.release, ...partial.weights?.release },
      recording: { ...DEFAULT_WEIGHTS.recording, ...partial.weights?.recording },
      mapping: { ...DEFAULT_WEIGHTS.mapping, ...partial.weights?.mapping },
    },
    thresholds: { ...DEFAULT_THRESHOLDS, ...partial.thresholds },
    preferences: { ...DEFAULT_PREFERENCES, ...partial.preferences },
  };
}

export interface DeepPartialConfig {
  readonly weights?: {
    readonly release?: Partial<MatchingWeights["release"]>;
    readonly recording?: Partial<MatchingWeights["recording"]>;
    readonly mapping?: Partial<MatchingWeights["mapping"]>;
  };
  readonly thresholds?: Partial<MatchingThresholds>;
  readonly preferences?: Partial<MatchingPreferences>;
}
