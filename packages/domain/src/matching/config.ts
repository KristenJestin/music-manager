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
 * The **tracklist fit dominates** at 0.30 because `docs/04` says so in as many words: it "est
 * le signal décisif entre éditions d'un même album". Title and artist come next — they are
 * what puts a candidate in the list at all, so they discriminate less *within* the list than
 * they look. Format, country and status are tie-breakers between pressings of one album, and
 * a label is only ever a corroboration, because "Provided to YouTube by" names the current
 * distributor rather than the original imprint.
 */
const RELEASE_WEIGHTS = {
  title: 0.18,
  artist: 0.18,
  durations: 0.3,
  trackCount: 0.12,
  year: 0.08,
  label: 0.02,
  format: 0.05,
  status: 0.02,
  country: 0.05,
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
