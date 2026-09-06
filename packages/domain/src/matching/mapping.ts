/**
 * `mapping.assign` — the global 1:1 assignment of videos to tracks
 * (`docs/04-pipeline-et-matching.md` § Mapping vidéo ↔ piste).
 *
 * The shape is taken from `_archive/music-manager-v2/src/matching/engine.ts`, which solved the
 * same problem: score the whole (video × track) matrix once, then commit the highest-scoring
 * still-free pair, repeatedly, until nothing clears the floor. What survives from it is the
 * property that matters — the assignment is **global**, so a strong pair claims its track
 * before a weak one can steal it, and a fingerprint hit therefore overrides playlist order.
 * What changed is that the signals are named and reported (`signals`, `why`) instead of being
 * an opaque breakdown, and that AcoustID is one weighted input among four rather than a
 * dominance tier — because at `match` time nothing has been downloaded yet, so the normal
 * case is that no fingerprint exists at all. The tier logic would then be dead code guarding
 * a case P03's `fingerprint` step already handles, after the fact, by disagreeing.
 *
 * Best-first is not the optimal assignment (that would be Hungarian), and that is deliberate:
 * it is stable, explainable line by line, and it never trades a near-certain binding for a
 * better *total*. A user who sees line 7 bound to track 7 must not have to reason about
 * line 12 to understand why.
 */

import { durationScore, round3, titleScore, unit, withinTolerance } from "./signals.ts";
import { withDefaults, type DeepPartialConfig } from "./config.ts";
import { normalizeTitle } from "../normalize/title.ts";
import type {
  ExtraVideo,
  MappingLine,
  MappingResult,
  MappingSignals,
  MappingStatus,
  MatchTrack,
  MatchVideo,
  MatchingConfig,
  UncoveredTrack,
} from "./types.ts";

/** One scored cell of the matrix, kept until the assignment consumes it. */
interface Cell {
  readonly videoIndex: number;
  readonly trackIndex: number;
  readonly confidence: number;
  readonly signals: MappingSignals;
  readonly delta: number | null;
}

/**
 * Position agreement in [0, 1]: 1 when the video sits where the track does, decaying with the
 * distance and bounded by the length of the release so it stays meaningful on a two-track EP.
 */
function positionScore(videoIndex: number, absoluteIndex: number, trackCount: number): number {
  const distance = Math.abs(videoIndex - absoluteIndex);
  const span = Math.max(trackCount - 1, 1);
  return unit(1 - distance / span);
}

/**
 * The YouTube Music `track` tag against the track's title.
 *
 * Separate from the title signal because it is a different witness: the tag is what YouTube's
 * metadata says the song is called, stripped of whatever the video's title added. When there
 * is no tag the signal is dropped from the denominator rather than counted as zero.
 */
function ytTrackTagScore(video: MatchVideo, track: MatchTrack): number | null {
  const tag = video.ytTrack;
  if (tag == null || tag.trim() === "") return null;
  const normalisedTag = normalizeTitle(tag);
  const normalisedTrack = normalizeTitle(track.title);
  if (normalisedTag === "" || normalisedTrack === "") return null;
  return normalisedTag === normalisedTrack ? 1 : titleScore(tag, track.title);
}

/** The best AcoustID score this video reported for this track's recording, if any. */
function acoustidScore(video: MatchVideo, track: MatchTrack): number | null {
  if (video.acoustid === undefined || video.acoustid.length === 0) return null;
  if (track.recordingMbid === null) return 0;
  let best: number | null = null;
  for (const hint of video.acoustid) {
    if (hint.recordingMbid !== track.recordingMbid) continue;
    best = best === null ? hint.score : Math.max(best, hint.score);
  }
  // The fingerprint spoke and did not name this recording: that is evidence against, not the
  // absence of evidence, so a zero rather than a dropped signal.
  return best ?? 0;
}

/**
 * Blend the available signals, renormalising over the ones that exist.
 *
 * A missing signal must not be a zero. `ytTrackTag` is absent on a hand-uploaded video and
 * `acoustid` is absent before `download` has run; counting either as a disagreement would
 * make every ordinary album score badly for a reason that has nothing to do with the album.
 */
function blend(parts: readonly (readonly [number, number | null])[]): number {
  let weighted = 0;
  let total = 0;
  for (const [weight, value] of parts) {
    if (value === null) continue;
    weighted += weight * value;
    total += weight;
  }
  return total === 0 ? 0 : unit(weighted / total);
}

/** Score one (video, track) pair. */
function scorePair(
  video: MatchVideo,
  track: MatchTrack,
  trackCount: number,
  config: MatchingConfig,
): Cell {
  const weights = config.weights.mapping;
  const duration = durationScore(video.durationSeconds, track.lengthSeconds, config.thresholds);
  const title = titleScore(video.title, track.title);
  const position = positionScore(video.index, track.absoluteIndex, trackCount);
  const ytTag = ytTrackTagScore(video, track);
  const acoustid = acoustidScore(video, track);

  const confidence = blend([
    [weights.acoustid, acoustid],
    [weights.duration, duration],
    [weights.title, title],
    [weights.position, position],
    [weights.ytTrackTag, ytTag],
  ]);

  const signals: MappingSignals = {
    title: round3(title),
    duration: round3(duration),
    position: round3(position),
    ytTrackTag: round3(ytTag ?? 0),
    ...(acoustid === null ? {} : { acoustid: round3(acoustid) }),
  };

  const delta =
    video.durationSeconds == null || track.lengthSeconds == null
      ? null
      : round3(video.durationSeconds - track.lengthSeconds);

  return { videoIndex: video.index, trackIndex: track.absoluteIndex, confidence, signals, delta };
}

/** Plain-English reasons for one bound line. */
function explainLine(
  video: MatchVideo,
  track: MatchTrack,
  cell: Cell,
  config: MatchingConfig,
): string[] {
  const why: string[] = [];
  const tolerance = config.thresholds.durationToleranceSeconds;

  if (cell.delta === null) {
    why.push("No duration on one side, so the lengths could not be compared");
  } else if (Math.abs(cell.delta) <= tolerance) {
    why.push(`Duration matches within ±${String(tolerance)}s (${formatDelta(cell.delta)})`);
  } else {
    why.push(`Duration differs by ${formatDelta(cell.delta)}`);
  }

  if (cell.signals.title >= 0.99) why.push("Title matches exactly once normalised");
  else if (cell.signals.title >= config.thresholds.titleMatch) why.push("Title matches closely");
  else if (cell.signals.title < 0.4) why.push("Title does not match");

  if (video.index === track.absoluteIndex)
    why.push("Same position in the listing and the tracklist");
  else if (cell.signals.position < 0.5) why.push("Position in the listing is far from the track's");

  if (cell.signals.ytTrackTag >= 0.99) why.push(`YouTube “track” tag is “${track.title}”`);

  if (cell.signals.acoustid !== undefined) {
    if (cell.signals.acoustid >= 0.5) why.push("The fingerprint names this recording");
    else if (cell.signals.acoustid === 0) why.push("The fingerprint did not name this recording");
  }
  return why;
}

function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  return rounded > 0 ? `+${String(rounded)}s` : `${String(rounded)}s`;
}

/** Why a video ended up bound to nothing. */
function explainExtra(best: Cell | undefined, floor: number): string[] {
  if (best === undefined) return ["The release has no track left to bind it to"];
  if (best.confidence < floor) {
    return [
      `Best candidate track scored ${String(round3(best.confidence))}, under the ${String(floor)} binding floor`,
    ];
  }
  return ["Every track it could fit was already taken by a closer video"];
}

/**
 * Bind videos to tracks, 1:1, best pair first.
 *
 * The result is complete rather than partial: one line per video (bound or not), the videos
 * nobody claimed as `extraVideos`, the tracks nobody covered as `uncoveredTracks`, and the
 * tracklist fit that the release scorer needs. The caller never has to derive one from
 * another and get the arithmetic subtly wrong.
 */
export function assign(
  videos: readonly MatchVideo[],
  tracks: readonly MatchTrack[],
  options: DeepPartialConfig = {},
): MappingResult {
  const config = withDefaults(options);
  const floor = config.thresholds.bindingFloor;
  const tolerance = config.thresholds.durationToleranceSeconds;

  const byTrackIndex = new Map(tracks.map((track) => [track.absoluteIndex, track]));

  const cells: Cell[] = [];
  for (const video of videos) {
    for (const track of tracks) {
      cells.push(scorePair(video, track, tracks.length, config));
    }
  }

  // Deterministic: confidence first, then the two indices, so an exact tie between two equally
  // plausible pairings always resolves the same way — a mapping that changed between two runs
  // of the same job would make `confirm` meaningless.
  cells.sort(
    (a, b) =>
      b.confidence - a.confidence || a.videoIndex - b.videoIndex || a.trackIndex - b.trackIndex,
  );

  const bestPerVideo = new Map<number, Cell>();
  for (const cell of cells) {
    if (!bestPerVideo.has(cell.videoIndex)) bestPerVideo.set(cell.videoIndex, cell);
  }

  const bound = new Map<number, Cell>();
  const takenTracks = new Set<number>();
  for (const cell of cells) {
    if (cell.confidence < floor) break; // sorted descending: nothing after this clears it
    if (bound.has(cell.videoIndex) || takenTracks.has(cell.trackIndex)) continue;
    bound.set(cell.videoIndex, cell);
    takenTracks.add(cell.trackIndex);
  }

  const lines: MappingLine[] = [];
  const extraVideos: ExtraVideo[] = [];
  let deltaSum = 0;
  let deltaCount = 0;
  let fit = 0;

  for (const video of videos) {
    const cell = bound.get(video.index);
    if (cell === undefined) {
      lines.push({
        videoId: video.id,
        videoIndex: video.index,
        videoTitle: video.title,
        trackN: null,
        mediumPosition: null,
        trackMbid: null,
        recordingMbid: null,
        trackTitle: null,
        confidence: 0,
        signals: null,
        delta: null,
        status: "unmatched",
        why: explainExtra(bestPerVideo.get(video.index), floor),
      });
      extraVideos.push({
        videoId: video.id,
        index: video.index,
        title: video.title,
        durationSeconds: video.durationSeconds,
        why: explainExtra(bestPerVideo.get(video.index), floor),
      });
      continue;
    }

    const track = byTrackIndex.get(cell.trackIndex);
    /* c8 ignore next -- the cell was built from this very map */
    if (track === undefined) continue;

    if (cell.delta !== null) {
      deltaSum += Math.abs(cell.delta);
      deltaCount += 1;
    }
    if (withinTolerance(video.durationSeconds, track.lengthSeconds, tolerance)) fit += 1;

    const status: MappingStatus =
      cell.confidence >= config.thresholds.confidentFloor ? "confident" : "check";

    lines.push({
      videoId: video.id,
      videoIndex: video.index,
      videoTitle: video.title,
      trackN: track.position,
      mediumPosition: track.mediumPosition,
      trackMbid: track.trackMbid,
      recordingMbid: track.recordingMbid,
      trackTitle: track.title,
      confidence: round3(cell.confidence),
      signals: cell.signals,
      delta: cell.delta,
      status,
      why: explainLine(video, track, cell, config),
    });
  }

  const uncoveredTracks: UncoveredTrack[] = tracks
    .filter((track) => !takenTracks.has(track.absoluteIndex))
    .map((track) => ({
      trackMbid: track.trackMbid,
      recordingMbid: track.recordingMbid,
      title: track.title,
      position: track.position,
      mediumPosition: track.mediumPosition,
      lengthSeconds: track.lengthSeconds,
    }));

  return {
    lines,
    extraVideos,
    uncoveredTracks,
    bound: bound.size,
    fit,
    fitOf: tracks.length,
    meanAbsDelta: deltaCount === 0 ? null : round3(deltaSum / deltaCount),
  };
}
