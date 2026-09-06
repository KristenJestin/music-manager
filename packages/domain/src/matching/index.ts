/**
 * The matching engine (`docs/04-pipeline-et-matching.md` § Algorithme de présélection).
 *
 * Three entry points, one namespace each, so a call site reads like the specification:
 *
 * ```ts
 * import { releaseCandidates, recordingCandidates, mapping } from "@mm/domain";
 *
 * const ranking  = releaseCandidates.score({ videos, hints, candidates });
 * const proposal = mapping.assign(videos, flattenTracks(ranking.preselected.release));
 * const single   = recordingCandidates.score({ video, candidates });
 * ```
 *
 * Everything is pure: no network, no clock, no randomness. Given the same recorded
 * MusicBrainz payloads the engine returns the same scores, which is what makes the four
 * scenarios of the phase specification testable at all.
 */

export * as releaseCandidates from "./release-candidates.ts";
export * as recordingCandidates from "./recording-candidates.ts";
export * as mapping from "./mapping.ts";
export * as lucene from "./lucene.ts";

export {
  DEFAULT_CONFIG,
  DEFAULT_LOOKUP_LIMIT,
  DEFAULT_PREFERENCES,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  withDefaults,
} from "./config.ts";
export type { DeepPartialConfig } from "./config.ts";

export { albumHints } from "./hints.ts";
export type { HintFallback } from "./hints.ts";

export {
  artistScore,
  creditName,
  flattenTracks,
  mainFormat,
  mainLabel,
  round3,
  titleScore,
  trackTotal,
  withinTolerance,
  yearOf,
} from "./signals.ts";

export type { ReleaseRanking } from "./release-candidates.ts";
export type { RecordingRanking } from "./recording-candidates.ts";

export type {
  AcoustIdHint,
  AlbumHints,
  BorrowRelease,
  ExtraVideo,
  MappingLine,
  MappingResult,
  MappingSignals,
  MappingStatus,
  MappingWeights,
  MatchTrack,
  MatchVideo,
  MatchingConfig,
  MatchingPreferences,
  MatchingThresholds,
  MatchingWeights,
  Penalty,
  RecordingCandidate,
  RecordingCandidateInput,
  RecordingScoreInput,
  RecordingSignals,
  RecordingWeights,
  ReleaseCandidate,
  ReleaseCandidateInput,
  ReleaseScoreInput,
  ReleaseSignals,
  ReleaseWeights,
  UncoveredTrack,
} from "./types.ts";
