/**
 * `releaseCandidates.score` — rank the MusicBrainz releases that could be the album behind a
 * playlist (`docs/04-pipeline-et-matching.md` § Release (album)).
 *
 * Nine signals, all in [0, 1], blended with the weights of `config.ts`, then reduced by named
 * penalties. The one that decides between two pressings of the same record is the **tracklist
 * fit**: how many of the release's tracks a video actually lands on, and by how much on
 * average. Title and artist put a candidate in the list; the fit is what tells a fourteen-track
 * European edition from the fifteen-track Japanese one with a bonus track, and nothing else in
 * the list can.
 *
 * The fit costs one lookup per candidate, so only the first N candidates get one (the service
 * decides N, default 6). A candidate without a tracklist is marked `detailed: false` and its
 * fit signal is dropped from the denominator rather than counted as zero — an un-looked-up
 * release must rank *below* the examined ones without being slandered.
 */

import { assign } from "./mapping.ts";
import { withDefaults, type DeepPartialConfig } from "./config.ts";
import {
  artistScore,
  countryScore,
  creditName,
  disambiguationPenalties,
  flattenTracks,
  formatScore,
  labelScore,
  mainFormat,
  mainLabel,
  round3,
  secondaryTypePenalties,
  statusScore,
  titleKeywordPenalties,
  titleScore,
  totalPenalty,
  trackTotal,
  unit,
  yearOf,
  yearScore,
} from "./signals.ts";
import type {
  FitLine,
  MatchingConfig,
  Penalty,
  ReleaseCandidate,
  ReleaseCandidateInput,
  ReleaseScoreInput,
  ReleaseSignals,
} from "./types.ts";

export interface ReleaseRanking {
  readonly candidates: readonly ReleaseCandidate[];
  /** The top candidate, or `null` when nothing was proposed at all. */
  readonly preselected: ReleaseCandidate | null;
  /**
   * True when the top two are closer than the ambiguity margin, i.e. the engine has no
   * business preferring one — the `ambiguous_release` case of the Inbox.
   */
  readonly ambiguous: boolean;
  /** Score gap between the first and the second, or `null` when there is only one. */
  readonly margin: number | null;
}

/**
 * The share of the *release's* tracks that some video covers within the tolerance.
 *
 * Note the denominator: it is the tracklist, not the video list. That is the whole point.
 * Fifteen videos over a fourteen-track edition cover 14/14 — the extra video is a separate
 * problem, reported as `extra_videos`, and must not lower the release's score. The same
 * fifteen videos over the fifteen-track Japanese edition cover 14/15, because the bonus track
 * has no video, and *that* is a genuine mark against the candidate.
 */
function tracklistFit(
  input: ReleaseScoreInput,
  candidate: ReleaseCandidateInput,
  config: MatchingConfig,
): {
  fit: number;
  fitOf: number;
  uncovered: number;
  signal: number | null;
  meanAbsDelta: number | null;
  lines: readonly FitLine[];
} {
  const detailed =
    candidate.detailed ?? (candidate.release.media ?? []).some((m) => (m.tracks ?? []).length > 0);
  const tracks = detailed ? flattenTracks(candidate.release) : [];
  if (tracks.length === 0) {
    const total = trackTotal(candidate.release);
    return { fit: 0, fitOf: total, uncovered: total, signal: null, meanAbsDelta: null, lines: [] };
  }
  const result = assign(input.videos, tracks, config);
  return {
    fit: result.fit,
    fitOf: result.fitOf,
    uncovered: result.uncoveredTracks.length,
    signal: result.fitOf === 0 ? null : unit(result.fit / result.fitOf),
    meanAbsDelta: result.meanAbsDelta,
    // The same assignment, narrowed to what a card can show without a second lookup.
    lines: result.lines.map((line) => ({
      videoIndex: line.videoIndex,
      videoTitle: line.videoTitle,
      trackPosition: line.trackN,
      mediumPosition: line.mediumPosition,
      recordingMbid: line.recordingMbid,
      trackMbid: line.trackMbid,
      trackTitle: line.trackTitle,
      delta: line.delta,
      status: line.status,
    })),
  };
}

/**
 * Track-count agreement between the release and the source listing.
 *
 * Tolerant on the "more videos than tracks" side and strict on the other: a playlist that
 * carries a radio edit alongside the album is ordinary, whereas a release with tracks the
 * playlist does not have at all means the import will be incomplete. So a surplus video costs
 * a third of what a missing one does.
 */
function trackCountScore(videos: number, tracks: number): number {
  if (tracks === 0) return 0;
  const span = Math.max(videos, tracks);
  const surplus = Math.max(0, videos - tracks);
  const missing = Math.max(0, tracks - videos);
  return unit(1 - (surplus / span) * 0.35 - missing / span);
}

/** Blend the nine signals, dropping the ones that do not exist for this candidate. */
function blendRelease(
  signals: ReleaseSignals,
  fitSignal: number | null,
  config: MatchingConfig,
): number {
  const w = config.weights.release;
  const parts: readonly (readonly [number, number | null])[] = [
    [w.title, signals.title],
    [w.artist, signals.artist],
    [w.durations, fitSignal],
    [w.trackCount, signals.trackCount],
    [w.year, signals.year],
    [w.label, signals.label],
    [w.format, signals.format],
    [w.status, signals.status],
    [w.country, signals.country],
  ];
  let weighted = 0;
  let total = 0;
  for (const [weight, value] of parts) {
    if (value === null) continue;
    weighted += weight * value;
    total += weight;
  }
  return total === 0 ? 0 : unit(weighted / total);
}

/** The plain-English case for (and against) one candidate. */
function explain(
  candidate: ReleaseCandidate,
  fitSignal: number | null,
  penalties: readonly Penalty[],
  config: MatchingConfig,
  videoCount: number,
): string[] {
  const why: string[] = [];
  const tolerance = config.thresholds.durationToleranceSeconds;

  if (candidate.signals.title >= 0.99 && candidate.signals.artist >= 0.99) {
    why.push("Album title and artist match exactly");
  } else {
    if (candidate.signals.title >= 0.99) why.push("Album title matches exactly");
    else if (candidate.signals.title < 0.5) why.push("Title does not match");
    if (candidate.signals.artist >= 0.99) why.push("Artist matches exactly");
    else if (candidate.signals.artist < 0.5) why.push("Artist mismatch");
  }

  if (fitSignal === null) {
    why.push(
      "Tracklist not fetched, so the fit is unknown (only the first candidates are looked up)",
    );
  } else {
    why.push(
      `${String(candidate.fit)}/${String(candidate.fitOf)} tracks are covered by a video within ±${String(tolerance)}s` +
        (candidate.durDelta === null ? "" : ` (mean Δ ${String(candidate.durDelta)}s)`),
    );
    if (candidate.uncovered > 0) {
      why.push(
        `${String(candidate.uncovered)} release track${candidate.uncovered === 1 ? "" : "s"} would stay uncovered`,
      );
    }
  }

  const surplus = videoCount - candidate.tracks;
  if (surplus > 0) {
    why.push(
      `${String(surplus)} video${surplus === 1 ? "" : "s"} more than the tracklist has tracks`,
    );
  }

  if (candidate.signals.year >= 0.99) {
    why.push(`Year ${String(candidate.year ?? "?")} matches the source`);
  } else if (candidate.signals.year <= 0.4 && candidate.year !== null) {
    why.push(`Year ${String(candidate.year)} does not match the source`);
  }

  if (candidate.signals.format >= 0.99 && candidate.format !== null) {
    why.push(`${candidate.format} is the preferred format for a YouTube source`);
  } else if (candidate.signals.format <= 0.35 && candidate.format !== null) {
    why.push(`${candidate.format} is a less likely source for a digital rip`);
  }

  if (candidate.signals.country >= 0.99 && candidate.country !== null) {
    why.push(`Country ${candidate.country} is the first preference`);
  } else if (candidate.signals.country <= 0.35) {
    why.push(`Country ${candidate.country ?? "unknown"} is outside the preferences`);
  }

  if (candidate.signals.status < 1 && candidate.status !== null) {
    why.push(`Status ${candidate.status} rather than Official`);
  }

  if (candidate.signals.label >= 0.99 && candidate.label !== null) {
    why.push(`Label ${candidate.label} matches the “Provided to YouTube by” line`);
  } else if (candidate.signals.label <= 0.6 && candidate.label !== null) {
    why.push(`Label ${candidate.label} differs from the “Provided to YouTube by” line — minor`);
  }

  for (const penalty of penalties)
    why.push(`${penalty.reason} (−${String(round3(penalty.amount))})`);
  return why;
}

/**
 * Score and rank release candidates.
 *
 * The result is ordered, `preselected` is the first, and `safe` says whether the first cleared
 * the threshold. Neither skips `confirm`: `docs/04` is explicit that the threshold marks a
 * candidate and nothing more.
 */
export function score(input: ReleaseScoreInput, options: DeepPartialConfig = {}): ReleaseRanking {
  const config = withDefaults(options);
  const videoCount = input.videos.length;
  const sourceAlbum = input.hints.album ?? "";
  const sourceArtists = [input.hints.artist, ...input.videos.map((v) => v.ytArtist ?? v.uploader)];
  const sourceYear =
    input.hints.year ?? input.videos.find((v) => v.ytReleaseYear != null)?.ytReleaseYear ?? null;

  const scored = input.candidates.map((candidate) => {
    const release = candidate.release;
    const group = release["release-group"];
    const format = mainFormat(release);
    const label = mainLabel(release);
    const country = release.country ?? null;
    const artist = creditName(release["artist-credit"]) ?? "";
    const tracks = trackTotal(release);
    const {
      fit,
      fitOf,
      uncovered,
      signal: fitSignal,
      meanAbsDelta,
      lines: fitLines,
    } = tracklistFit(input, candidate, config);

    const signals: ReleaseSignals = {
      title: round3(sourceAlbum === "" ? 0.5 : titleScore(sourceAlbum, release.title ?? "")),
      artist: round3(artistScore(sourceArtists, artist)),
      trackCount: round3(trackCountScore(videoCount, tracks)),
      durations: round3(fitSignal ?? 0),
      year: round3(
        yearScore(sourceYear, yearOf(release.date) ?? yearOf(group?.["first-release-date"])),
      ),
      label: round3(labelScore(input.hints.label, label)),
      format: round3(formatScore(format, config.preferences)),
      status: round3(statusScore(release.status ?? null)),
      country: round3(countryScore(country, config.preferences)),
    };

    const penalties: Penalty[] = [
      ...disambiguationPenalties(release.disambiguation, config.preferences),
      ...secondaryTypePenalties(group?.["secondary-types"], group?.["primary-type"]),
      ...titleKeywordPenalties(
        release.title ?? "",
        group?.["primary-type"],
        group?.["secondary-types"],
      ),
    ];

    const blended = blendRelease(signals, fitSignal, config);
    const finalScore = unit(blended - totalPenalty(penalties));

    const candidateOut: ReleaseCandidate = {
      id: release.id ?? "",
      releaseGroupId: group?.id ?? null,
      title: release.title ?? "",
      artist,
      date: release.date ?? null,
      year: yearOf(release.date),
      country,
      format,
      label,
      status: release.status ?? null,
      type: group?.["primary-type"] ?? null,
      secondary: [...(group?.["secondary-types"] ?? [])],
      disambiguation: release.disambiguation ?? "",
      barcode: release.barcode ?? null,
      tracks,
      score: round3(finalScore),
      fit,
      fitOf,
      uncovered,
      durDelta: meanAbsDelta,
      fitLines,
      signals,
      penalties,
      why: [],
      preselected: false,
      safe: false,
      detailed: fitSignal !== null,
    };

    return {
      ...candidateOut,
      why: explain(candidateOut, fitSignal, penalties, config, videoCount),
    };
  });

  /*
   * A candidate whose tracklist was fetched always ranks above one whose was not.
   *
   * Without this rule the budget would punish the candidates it spent itself on: a release
   * that was looked up carries a real fit — 11 covered tracks out of 13, say — while one that
   * was not simply has that signal dropped from its denominator, so it is scored on its good
   * signals alone and floats to the top. The engine would then preselect precisely the
   * candidate it knows least about. Verified first is the only honest order; the unverified
   * ones stay in the list, with `detailed: false` and a `why` saying so, because the Console
   * has to be able to offer them.
   */
  const ranked = [...scored].sort(
    (a, b) =>
      Number(b.detailed) - Number(a.detailed) ||
      b.score - a.score ||
      b.fit - a.fit ||
      a.fitOf - b.fitOf ||
      a.id.localeCompare(b.id),
  );

  const first = ranked[0];
  const second = ranked[1];
  const margin =
    first === undefined || second === undefined ? null : round3(first.score - second.score);

  const candidates = ranked.map((candidate, index) => ({
    ...candidate,
    preselected: index === 0,
    safe: index === 0 && candidate.score >= config.thresholds.safe,
  }));

  return {
    candidates,
    preselected: candidates[0] ?? null,
    ambiguous:
      margin !== null &&
      margin < config.thresholds.ambiguityMargin &&
      first !== undefined &&
      second !== undefined &&
      differsMaterially(first, second),
    margin,
  };
}

/**
 * Would choosing the second candidate instead of the first change what gets imported?
 *
 * A near-tie is only a *question* when the answers differ. Discovery exists on MusicBrainz as
 * two dozen pressings with the same fourteen tracks in the same order: the French CD and the
 * British one score within a thousandth of each other, and asking which to use would be asking
 * the user to pick a barcode — the files, the tags and the folder are identical either way.
 * A fifteen-track Japanese edition is a different matter, and so is an unverified candidate
 * next to a verified one, because there the outcome genuinely changes.
 */
function differsMaterially(a: ReleaseCandidate, b: ReleaseCandidate): boolean {
  if (a.detailed !== b.detailed) return false; // verified beats unverified; not a question
  if (a.tracks === b.tracks && a.fit === b.fit && a.uncovered === b.uncovered) {
    return false; // the same import either way — a barcode, not a decision
  }
  // The outcomes differ, but if the preselected one covers at least as much and leaves no more
  // behind, it simply *wins*. A question is only worth asking when the runner-up would gain
  // something: more tracks covered, or fewer left uncovered.
  const coversMore = b.fit > a.fit;
  const leavesLessBehind = b.uncovered < a.uncovered;
  return coversMore || leavesLessBehind;
}
