/**
 * The vocabulary of the matcher (`docs/04-pipeline-et-matching.md` § Algorithme de
 * présélection).
 *
 * Two rules shape every type here:
 *
 *  - **Signals are normalised to [0, 1]** and kept alongside the aggregate. A score without
 *    its signals is an opinion; with them it is an argument, and decision 002 says the
 *    algorithm has to argue rather than decide.
 *  - **The output shapes are the ones the Console already draws** (`prototypes/shared/data.js`,
 *    `wizard.releaseCandidates` / `wizard.single.recordingCandidates` / `wizard.mapping`):
 *    `score`, `signals`, `why[]`, `preselected`, `fit`/`fitOf`, `durDelta`, and a per-line
 *    `confidence` + `status`. P06 renders these verbatim.
 *
 * Everything is pure data: no MBIDs are resolved here, no network is touched, and the
 * MusicBrainz payloads arrive already parsed as the structural types of `metadata/resolvers`.
 */

import type { MbRelease } from "../metadata/resolvers/musicbrainz-types.ts";
import type { CoverArtInfo } from "./signals.ts";

export type { CoverArtInfo };

/* ------------------------------------------------------------------ */
/* inputs                                                              */
/* ------------------------------------------------------------------ */

/** One AcoustID candidate for one video. Optional throughout: the fingerprint is P03's. */
export interface AcoustIdHint {
  readonly recordingMbid: string;
  /** AcoustID's own confidence, already in [0, 1]. */
  readonly score: number;
}

/**
 * One source video, as the matcher sees it.
 *
 * The YouTube Music tags (`track`, `artist`, `album`, `release_year`) are kept apart from the
 * title because they are a different kind of evidence: a title is a string a human typed, a
 * tag is what YouTube's own metadata says, and the two disagree often enough to be worth
 * scoring separately.
 */
export interface MatchVideo {
  readonly id: string;
  /** Position in the source listing, zero-based, as `resolve` numbered it. */
  readonly index: number;
  readonly title: string;
  readonly durationSeconds: number | null;
  readonly uploader?: string | null;
  readonly ytTrack?: string | null;
  readonly ytArtist?: string | null;
  readonly ytAlbum?: string | null;
  readonly ytReleaseYear?: number | null;
  /** An ISRC carried by the source, when there is one. Decisive, and usually absent. */
  readonly isrc?: string | null;
  /** The auto-generated YouTube description, verbatim. The only source of the label. */
  readonly description?: string | null;
  readonly acoustid?: readonly AcoustIdHint[];
}

/** What the source listing and the "Provided to YouTube by" description agree the album is. */
export interface AlbumHints {
  readonly album?: string | null;
  readonly artist?: string | null;
  /** ℗ year, `Released on:`, or the `release_year` tag — whichever the parser found. */
  readonly year?: number | null;
  readonly label?: string | null;
  readonly releasedOn?: string | null;
}

/** One track of a candidate release, flattened across media into tracklist order. */
export interface MatchTrack {
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
  readonly title: string;
  readonly artist: string | null;
  readonly lengthSeconds: number | null;
  /** Position inside its medium, one-based, as MusicBrainz numbers it. */
  readonly position: number;
  readonly mediumPosition: number;
  /** Position across every medium, zero-based. The key the assignment works on. */
  readonly absoluteIndex: number;
}

/* ------------------------------------------------------------------ */
/* weights and thresholds                                              */
/* ------------------------------------------------------------------ */

/** The ten release signals of `docs/04`, in the order the Console lists them. */
export interface ReleaseSignals {
  readonly title: number;
  readonly artist: number;
  readonly trackCount: number;
  /** The tracklist fit: the share of the release's tracks a video lands on. */
  readonly durations: number;
  /**
   * The other direction of the same fit: the share of **your videos** this release would give
   * a track to (decision 152).
   *
   * `durations` alone cannot tell a fourteen-track album covered by fourteen videos from a
   * one-track single covered by one of them: both are 1.0. This one says 1.0 and 0.09.
   */
  readonly coverage: number;
  /**
   * Whether the Cover Art Archive has a front for this exact pressing (decision 167).
   *
   * A tie-breaker and nothing more — the owner's fifth review: at an equal fit, the release
   * that comes with a picture is the better import, because the one without it makes the
   * `tag` step fall back down `docs/03` §4's ladder to somebody else's pressing or to a
   * YouTube thumbnail. `0` here means "MusicBrainz says none"; a candidate whose release was
   * never looked up has no answer at all and is dropped from the blend instead.
   */
  readonly coverArt: number;
  readonly year: number;
  readonly label: number;
  readonly format: number;
  readonly status: number;
  readonly country: number;
}

export interface RecordingSignals {
  readonly title: number;
  readonly artist: number;
  readonly duration: number;
  readonly ytTags: number;
  readonly isrc: number;
}

export interface MappingSignals {
  readonly title: number;
  readonly duration: number;
  readonly position: number;
  readonly ytTrackTag: number;
  /** Absent when no fingerprint was run for this video. */
  readonly acoustid?: number;
}

export type ReleaseWeights = { readonly [K in keyof ReleaseSignals]: number };
export type RecordingWeights = { readonly [K in keyof RecordingSignals]: number };
export type MappingWeights = { readonly [K in keyof MappingSignals]-?: number };

export interface MatchingWeights {
  readonly release: ReleaseWeights;
  readonly recording: RecordingWeights;
  readonly mapping: MappingWeights;
}

/** Country/format/explicit preferences — the ones `decisions` teaches, visibly (`docs/04`). */
export interface MatchingPreferences {
  /** Best first. `XW` is MusicBrainz's worldwide pseudo-country. */
  readonly countries: readonly string[];
  readonly format: string;
  readonly explicit: "either" | "explicit" | "clean";
}

export interface MatchingThresholds {
  /** Marks the first candidate. It never skips `confirm` (decision 002). */
  readonly safe: number;
  /** Two candidates closer than this are ambiguous: the Inbox has to ask. */
  readonly ambiguityMargin: number;
  /** A (video, track) pair below this is not bound at all. */
  readonly bindingFloor: number;
  /** A bound line below this is `check` rather than `confident`. */
  readonly confidentFloor: number;
  /** ± this many seconds counts as a duration hit (`docs/04`: ±2 s). */
  readonly durationToleranceSeconds: number;
  /** Beyond the tolerance the duration sub-score decays linearly across this window. */
  readonly durationDecaySeconds: number;
  /** Normalised title similarity above which two titles are the same work. */
  readonly titleMatch: number;
  /** Deduction at a total miss; scaled by the square of the share of videos left over. */
  readonly coveragePenalty: number;
  /** What one surplus video costs relative to one missing track, inside `trackCount`. */
  readonly trackSurplusCost: number;
}

/** Everything the pure engine needs to be reproducible. Every field has a documented default. */
export interface MatchingConfig {
  readonly weights: MatchingWeights;
  readonly thresholds: MatchingThresholds;
  readonly preferences: MatchingPreferences;
}

/* ------------------------------------------------------------------ */
/* outputs                                                             */
/* ------------------------------------------------------------------ */

/** A named deduction, so a low score can always name the thing that lowered it. */
export interface Penalty {
  readonly reason: string;
  /** How much was subtracted from the weighted blend, in [0, 1]. */
  readonly amount: number;
}

/**
 * One line of a candidate's tracklist fit: which video would land on which of its tracks.
 *
 * The fit is already what decides between two pressings of the same album, and the card
 * already prints it as "13/13" — this is the same arithmetic with its working shown, so the
 * question "why is that release better than this one?" has an answer on the card rather than
 * three steps later. Deliberately narrower than `MappingLine`: no signals, no reasons, nothing
 * that would multiply by twelve candidates into a payload nobody reads.
 */
export interface FitLine {
  readonly videoIndex: number;
  readonly videoTitle: string;
  /** Position within the medium, or `null` when the video binds to nothing. */
  readonly trackPosition: number | null;
  /** Which medium (disc) the bound track is on, or `null` when nothing was bound. */
  readonly mediumPosition: number | null;
  /**
   * The identifiers the assignment already computed.
   *
   * They are here because an agent confirming this candidate over the API has to *send* them
   * back (`confirm_mapping.bindings[].recordingMbid`), and without them its only honest option
   * was `null` — which then made every AcoustID check disagree with the mapping it had just
   * been given. The system knew the answer and did not say it; now it does.
   */
  readonly recordingMbid: string | null;
  readonly trackMbid: string | null;
  readonly trackTitle: string | null;
  /** `video − track` in seconds. */
  readonly delta: number | null;
  readonly status: MappingStatus;
}

/** One scored release candidate — the shape `wizard.releaseCandidates` is drawn from. */
export interface ReleaseCandidate {
  readonly id: string;
  readonly releaseGroupId: string | null;
  readonly title: string;
  readonly artist: string;
  readonly date: string | null;
  readonly year: number | null;
  readonly country: string | null;
  readonly format: string | null;
  readonly label: string | null;
  readonly status: string | null;
  readonly type: string | null;
  readonly secondary: readonly string[];
  readonly disambiguation: string;
  readonly barcode: string | null;
  /**
   * What the Cover Art Archive holds for this pressing, or `null` when it was never looked up.
   *
   * The card draws the real thumbnail when `front` is true and says so explicitly when it is
   * false — the fifth owner review asked for "vignette réelle ou placeholder explicite", and
   * a gradient that means both "no cover" and "not asked yet" is not explicit.
   */
  readonly coverArt: CoverArtInfo | null;
  /** Tracks on the release, across every medium. */
  readonly tracks: number;
  readonly score: number;
  /** Tracks a video landed on, and out of how many — the tracklist fit, as a fraction. */
  readonly fit: number;
  readonly fitOf: number;
  /**
   * Tracks the 1:1 assignment could bind no video to at all — the import outcome, as opposed
   * to `fitOf - fit`, which counts the tracks no video matched *within the tolerance*. A
   * track two seconds and a fraction out still gets bound; it is simply not a clean hit.
   */
  readonly uncovered: number;
  /**
   * Videos the 1:1 assignment could bind to no track of this release, and out of how many.
   *
   * The counterpart of `uncovered`, and the number the third owner review is about: the single
   * that scored 94 % left ten of eleven videos here. A card that prints "fit 1/1" and nothing
   * else is telling half the truth.
   */
  readonly leftOver: number;
  readonly videos: number;
  /** Mean |video − track| over the covered tracks, in seconds. */
  readonly durDelta: number | null;
  /** The fit, line by line. Empty when the tracklist was never looked up. */
  readonly fitLines: readonly FitLine[];
  readonly signals: ReleaseSignals;
  readonly penalties: readonly Penalty[];
  readonly why: readonly string[];
  readonly preselected: boolean;
  readonly safe: boolean;
  /**
   * False when the tracklist was never looked up, so `fit` is unknown rather than zero.
   * Only the first N candidates are looked up (`docs/04`: the fit needs one lookup each).
   */
  readonly detailed: boolean;
}

/**
 * One MusicBrainz **release group** — the album as a work — with the releases of it we scored.
 *
 * Decision 151. The list step 2 draws is a list of groups, not a flat list of pressings: "Bad
 * Ideas the 2019 album" and "Bad Ideas the 2020 single" are two different records that happen
 * to share a name, and the question a person is actually answering is *which record*, not
 * *which barcode*. Once that is settled, the best pressing inside the chosen group is a detail
 * the engine is allowed to have an opinion about, and it does: `releases[0]`.
 */
export interface ReleaseGroupCandidate {
  /** `null` for the bucket of releases MusicBrainz gave us no group for. */
  readonly id: string | null;
  readonly title: string;
  readonly artist: string;
  readonly primaryType: string | null;
  readonly secondaryTypes: readonly string[];
  readonly firstReleaseDate: string | null;
  readonly year: number | null;
  /**
   * The group's score: the score of its best release.
   *
   * A group is worth the best thing you can import from it — anything else would let a group
   * full of mediocre pressings outrank the one holding the right record, or the reverse.
   */
  readonly score: number;
  /** What the group looked like *before* any release of it was looked up. Ordered the search. */
  readonly searchScore: number;
  /** Its releases, best first. `releases[0]` is what selecting the group selects. */
  readonly releases: readonly ReleaseCandidate[];
  /** How many of its releases got a tracklist lookup. */
  readonly detailedCount: number;
  readonly preselected: boolean;
  readonly why: readonly string[];
}

export interface ReleaseGroupRanking {
  readonly groups: readonly ReleaseGroupCandidate[];
  readonly preselected: ReleaseGroupCandidate | null;
  /** Score gap between the best group and the next, or `null` when there is only one. */
  readonly margin: number | null;
}

/** The release a lone recording is imported *as* — album > single > EP > compilation/live. */
export interface BorrowRelease {
  readonly id: string;
  readonly title: string;
  readonly type: string | null;
  readonly secondary: readonly string[];
  readonly date: string | null;
  readonly country: string | null;
  readonly format: string | null;
  readonly trackPosition: number | null;
  readonly trackCount: number | null;
  readonly preferred: boolean;
  readonly why: readonly string[];
}

/** One scored recording candidate — `wizard.single.recordingCandidates`. */
export interface RecordingCandidate {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly disambiguation: string;
  /** Recording length in seconds, as MusicBrainz has it. */
  readonly length: number | null;
  readonly isrc: string | null;
  readonly score: number;
  readonly signals: RecordingSignals;
  readonly penalties: readonly Penalty[];
  readonly why: readonly string[];
  readonly preselected: boolean;
  readonly safe: boolean;
  readonly releases: readonly BorrowRelease[];
  /** The chosen borrow release, or `null` when the recording is on no usable release. */
  readonly borrow: BorrowRelease | null;
}

export type MappingStatus = "confident" | "check" | "unmatched";

/** One line of the proposed mapping — `wizard.mapping`. */
export interface MappingLine {
  readonly videoId: string;
  readonly videoIndex: number;
  readonly videoTitle: string;
  /** The bound track's position inside its medium, or `null` when nothing was bound. */
  readonly trackN: number | null;
  readonly mediumPosition: number | null;
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
  readonly trackTitle: string | null;
  readonly confidence: number;
  readonly signals: MappingSignals | null;
  /** `video − track` in seconds. Negative means the video is shorter. */
  readonly delta: number | null;
  readonly status: MappingStatus;
  readonly why: readonly string[];
}

export interface UncoveredTrack {
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
  readonly title: string;
  readonly position: number;
  readonly mediumPosition: number;
  readonly lengthSeconds: number | null;
}

export interface ExtraVideo {
  readonly videoId: string;
  readonly index: number;
  readonly title: string;
  readonly durationSeconds: number | null;
  /** The best track it *could* have taken, and why that was not enough. */
  readonly why: readonly string[];
}

export interface MappingResult {
  readonly lines: readonly MappingLine[];
  readonly extraVideos: readonly ExtraVideo[];
  readonly uncoveredTracks: readonly UncoveredTrack[];
  /** Bound lines. */
  readonly bound: number;
  /** Tracks covered by a video whose |Δ| is within the tolerance. */
  readonly fit: number;
  readonly fitOf: number;
  /** Mean |Δ| over the bound lines that have both durations, in seconds. */
  readonly meanAbsDelta: number | null;
}

/* ------------------------------------------------------------------ */
/* engine inputs                                                       */
/* ------------------------------------------------------------------ */

/** One candidate handed to the release scorer, with whatever MusicBrainz gave for it. */
export interface ReleaseCandidateInput {
  readonly release: MbRelease;
  /** MusicBrainz's own 0–100 search relevance, when the candidate came from a search. */
  readonly searchScore?: number | null;
  /**
   * True when `release.media[].tracks` was actually fetched. A search result carries track
   * *counts* but no tracklist, so the fit cannot be computed for it.
   */
  readonly detailed?: boolean;
}

export interface ReleaseScoreInput {
  readonly videos: readonly MatchVideo[];
  readonly hints: AlbumHints;
  readonly candidates: readonly ReleaseCandidateInput[];
}

/** A recording candidate plus the releases it appears on, as `inc=releases` returns them. */
export interface RecordingCandidateInput {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly disambiguation?: string;
  /** Length in milliseconds, as MusicBrainz stores it. */
  readonly lengthMs?: number | null;
  readonly isrcs?: readonly string[];
  readonly searchScore?: number | null;
  readonly releases?: readonly MbRelease[];
}

export interface RecordingScoreInput {
  readonly video: MatchVideo;
  readonly candidates: readonly RecordingCandidateInput[];
}
