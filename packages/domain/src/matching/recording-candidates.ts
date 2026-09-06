/**
 * `recordingCandidates.score` — rank the MusicBrainz recordings that could be a lone video,
 * and choose the release it is imported *as* (`docs/04-pipeline-et-matching.md`
 * § Recording (vidéo seule)).
 *
 * A single video has no tracklist to fit, so the evidence is thinner and the signals matter
 * more individually: the normalised title, the artist against the uploader (`- Topic`
 * stripped), the duration, the YouTube Music tags, and the ISRC when there is one.
 *
 * Then the **borrow release**. A track has to be filed somewhere, and `docs/04` fixes the
 * order: album > single > EP > compilation/live, same artist, coherent year. That choice is
 * not cosmetic — it decides the album folder, the album tags and the track number the file
 * ends up with, so it is reported with its own `why` and its own alternatives rather than
 * being an implementation detail of the score.
 */

import { withDefaults, type DeepPartialConfig } from "./config.ts";
import {
  artistScore,
  disambiguationPenalties,
  durationScore,
  mainFormat,
  round3,
  secondaryTypePenalties,
  titleScore,
  totalPenalty,
  trackTotal,
  unit,
  yearOf,
} from "./signals.ts";
import { normalizeTitle } from "../normalize/title.ts";
import type { MbRelease } from "../metadata/resolvers/musicbrainz-types.ts";
import type {
  BorrowRelease,
  MatchVideo,
  MatchingConfig,
  Penalty,
  RecordingCandidate,
  RecordingCandidateInput,
  RecordingScoreInput,
  RecordingSignals,
} from "./types.ts";

export interface RecordingRanking {
  readonly candidates: readonly RecordingCandidate[];
  readonly preselected: RecordingCandidate | null;
  /** True when the top two are within the margin — the `ambiguous_recording` Inbox case. */
  readonly ambiguous: boolean;
  readonly margin: number | null;
}

/* ------------------------------------------------------------------ */
/* the borrow release                                                  */
/* ------------------------------------------------------------------ */

/**
 * How much we want to file a track under a release of this kind.
 *
 * v1's ladder (album +300, EP +150, single +100, compilation −250, live −150, soundtrack −100)
 * rescaled and re-ordered to the one `docs/04` states: **album > single > EP >
 * compilation/live**. The difference from v1 is deliberate — v1 was choosing what a *release*
 * was worth in general, whereas this is choosing where a single downloaded track should live,
 * and a single is a better home for a standalone song than an EP it happens to also appear on.
 */
function borrowRank(primary: string | null, secondary: readonly string[]): number {
  const lowered = new Set(secondary.map((s) => s.trim().toLowerCase()));
  if (lowered.has("live")) return 0.2;
  if (lowered.has("compilation")) return 0.25;
  if (lowered.has("soundtrack")) return 0.45;
  if (lowered.has("remix")) return 0.35;
  switch ((primary ?? "").trim().toLowerCase()) {
    case "album":
      return 1;
    case "single":
      return 0.8;
    case "ep":
      return 0.65;
    case "broadcast":
      return 0.3;
    case "other":
      return 0.4;
    default:
      return 0.5;
  }
}

/** Where the recording sits on one of its releases, when MusicBrainz says. */
function trackPositionOn(release: MbRelease, recordingId: string): number | null {
  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) {
      if (track.recording?.id === recordingId) return track.position ?? null;
    }
  }
  // `inc=releases+media` on a recording search returns the medium carrying it with a
  // `track-offset`; the tracks array is often a single element with the right position.
  const only = release.media?.[0]?.tracks?.[0];
  return only?.position ?? null;
}

function describeBorrow(
  release: MbRelease,
  recordingId: string,
  config: MatchingConfig,
  sourceYear: number | null,
): { borrow: BorrowRelease; rank: number } {
  const group = release["release-group"];
  const primary = group?.["primary-type"] ?? null;
  const secondary = [...(group?.["secondary-types"] ?? [])];
  const year = yearOf(release.date) ?? yearOf(group?.["first-release-date"]);
  const kindRank = borrowRank(primary, secondary);

  const why: string[] = [];
  if (primary !== null)
    why.push(`${primary}${secondary.length === 0 ? "" : ` (${secondary.join(", ")})`}`);
  if (release.country !== undefined) why.push(`Country ${release.country}`);

  // A year far from the source's is a reissue or a later compilation, not the release the
  // video came from.
  let yearRank = 1;
  if (sourceYear !== null && year !== null) {
    const distance = Math.abs(sourceYear - year);
    yearRank = unit(1 - distance * 0.1);
    if (distance === 0) why.push(`Year ${String(year)} matches the source`);
    else if (distance > 2)
      why.push(`Year ${String(year)} is ${String(distance)} years from the source`);
  }

  const statusRank = (release.status ?? "").trim().toLowerCase() === "official" ? 1 : 0.6;
  if (statusRank < 1 && release.status !== undefined) why.push(`Status ${release.status}`);

  const formatRank =
    (mainFormat(release) ?? "").trim().toLowerCase() ===
    config.preferences.format.trim().toLowerCase()
      ? 1
      : 0.85;

  return {
    borrow: {
      id: release.id ?? "",
      title: release.title ?? "",
      type: primary,
      secondary,
      date: release.date ?? null,
      country: release.country ?? null,
      format: mainFormat(release),
      trackPosition: trackPositionOn(release, recordingId),
      trackCount: trackTotal(release) || null,
      preferred: false,
      why,
    },
    rank: kindRank * yearRank * statusRank * formatRank,
  };
}

/**
 * Choose the release a lone recording is imported as, and return every alternative in order.
 *
 * Deterministic, and it never invents: with no releases at all the answer is an empty list and
 * a `null` borrow, which the service turns into "this recording cannot be filed" rather than
 * into a folder called `Unknown Album`.
 */
export function chooseBorrowRelease(
  candidate: RecordingCandidateInput,
  config: MatchingConfig,
  sourceYear: number | null,
): { releases: BorrowRelease[]; borrow: BorrowRelease | null } {
  const described = (candidate.releases ?? []).map((release) =>
    describeBorrow(release, candidate.id, config, sourceYear),
  );
  described.sort((a, b) => b.rank - a.rank || a.borrow.id.localeCompare(b.borrow.id));

  const releases = described.map((entry, index) => ({ ...entry.borrow, preferred: index === 0 }));
  return { releases, borrow: releases[0] ?? null };
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * The YouTube Music tags against the candidate: `track` against the recording's title,
 * `artist` against the credit, `album` against the chosen borrow release.
 *
 * The album comparison is what separates Stromae's album version of "Formidable" from the
 * single edit: both have the right title, artist and length, but only one of them lives on the
 * record the video's `album` tag names.
 */
function ytTagScore(
  video: MatchVideo,
  candidate: RecordingCandidateInput,
  borrow: BorrowRelease | null,
): number | null {
  const parts: number[] = [];
  if (video.ytTrack != null && video.ytTrack.trim() !== "") {
    parts.push(
      normalizeTitle(video.ytTrack) === normalizeTitle(candidate.title)
        ? 1
        : titleScore(video.ytTrack, candidate.title),
    );
  }
  if (video.ytArtist != null && video.ytArtist.trim() !== "") {
    parts.push(artistScore([video.ytArtist], candidate.artist));
  }
  if (video.ytAlbum != null && video.ytAlbum.trim() !== "") {
    parts.push(borrow === null ? 0 : titleScore(video.ytAlbum, borrow.title));
  }
  if (parts.length === 0) return null;
  return unit(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** ISRC agreement. Absent on both sides means "no evidence", which is not a disagreement. */
function isrcScore(video: MatchVideo, candidate: RecordingCandidateInput): number | null {
  const raw = video.isrc;
  if (raw == null || raw.trim() === "") return null;
  const wanted = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const known = (candidate.isrcs ?? []).map((i) => i.replace(/[^A-Za-z0-9]/g, "").toUpperCase());
  if (known.length === 0) return null;
  return known.includes(wanted) ? 1 : 0;
}

function explain(
  video: MatchVideo,
  candidate: RecordingCandidate,
  penalties: readonly Penalty[],
  config: MatchingConfig,
): string[] {
  const why: string[] = [];

  if (candidate.signals.title >= 0.99) why.push("Title matches once the video noise is stripped");
  else if (candidate.signals.title >= config.thresholds.titleMatch)
    why.push("Title matches closely");
  else if (candidate.signals.title >= 0.6)
    why.push("Title matches, with extra words in the video's");
  else why.push("Title does not match");

  if (candidate.signals.artist >= 0.99) {
    why.push(`Uploader “${video.uploader ?? video.ytArtist ?? "?"}” matches the artist credit`);
  } else if (candidate.signals.artist < 0.5) {
    why.push(`Artist mismatch (credited to ${candidate.artist})`);
  }

  if (video.durationSeconds != null && candidate.length != null) {
    const delta = Math.round((video.durationSeconds - candidate.length) * 10) / 10;
    const sign = delta > 0 ? "+" : "";
    why.push(
      Math.abs(delta) <= config.thresholds.durationToleranceSeconds
        ? `Duration ${formatClock(video.durationSeconds)} vs ${formatClock(candidate.length)}`
        : `Duration ${sign}${String(delta)}s`,
    );
  }

  if (candidate.signals.ytTags >= 0.99) why.push("Every YouTube tag agrees (track, artist, album)");
  else if (candidate.signals.ytTags <= 0.4) why.push("The YouTube tags point elsewhere");

  // Only worth a line when the source actually carried one: an absent ISRC is no evidence,
  // and reporting it as a mismatch would read as an argument against the right answer.
  if (video.isrc != null && video.isrc.trim() !== "" && (candidate.isrc ?? "") !== "") {
    why.push(candidate.signals.isrc === 1 ? "The ISRC matches" : "The ISRC does not match");
  }

  if (candidate.borrow !== null) {
    const position =
      candidate.borrow.trackPosition === null
        ? ""
        : ` (track ${String(candidate.borrow.trackPosition)}${candidate.borrow.trackCount === null ? "" : `/${String(candidate.borrow.trackCount)}`})`;
    why.push(
      `Filed under “${candidate.borrow.title}”, ${candidate.borrow.type ?? "release"}${position}`,
    );
  } else {
    why.push("No usable release to file it under");
  }

  for (const penalty of penalties)
    why.push(`${penalty.reason} (−${String(round3(penalty.amount))})`);
  return why;
}

function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Score and rank recording candidates for one video.
 *
 * `ambiguous` is the signal the service turns into an `ambiguous_recording` Inbox item: two
 * recordings within the margin — an album version at 3:34 and a single edit at 3:33 — are
 * genuinely indistinguishable from the outside, and the honest answer is a question.
 */
export function score(
  input: RecordingScoreInput,
  options: DeepPartialConfig = {},
): RecordingRanking {
  const config = withDefaults(options);
  const video = input.video;
  const weights = config.weights.recording;
  const sourceYear = video.ytReleaseYear ?? null;

  const scored = input.candidates.map((candidate) => {
    const { releases, borrow } = chooseBorrowRelease(candidate, config, sourceYear);
    const lengthSeconds = candidate.lengthMs == null ? null : candidate.lengthMs / 1000;

    const title = titleScore(video.title, candidate.title);
    const artist = artistScore([video.uploader, video.ytArtist], candidate.artist);
    const duration = durationScore(video.durationSeconds, lengthSeconds, config.thresholds);
    const ytTags = ytTagScore(video, candidate, borrow);
    const isrc = isrcScore(video, candidate);

    const parts: readonly (readonly [number, number | null])[] = [
      [weights.title, title],
      [weights.artist, artist],
      [weights.duration, duration],
      [weights.ytTags, ytTags],
      [weights.isrc, isrc],
    ];
    let weighted = 0;
    let total = 0;
    for (const [weight, value] of parts) {
      if (value === null) continue;
      weighted += weight * value;
      total += weight;
    }
    const blended = total === 0 ? 0 : unit(weighted / total);

    const penalties: Penalty[] = [
      ...disambiguationPenalties(candidate.disambiguation, config.preferences),
      ...(borrow === null
        ? [{ reason: "No release to file this recording under", amount: 0.1 }]
        : secondaryTypePenalties(borrow.secondary, borrow.type)),
    ];
    // The borrow ladder as a tie-break, small enough to leave two close candidates inside the
    // ambiguity margin: an album version should win over a single edit, but not silently.
    const borrowBias = borrow === null ? 0 : (1 - borrowRank(borrow.type, borrow.secondary)) * 0.05;
    if (borrowBias > 0.001 && borrow !== null) {
      penalties.push({
        reason: `Only available on a ${(borrow.type ?? "release").toLowerCase()}`,
        amount: round3(borrowBias),
      });
    }

    const signals: RecordingSignals = {
      title: round3(title),
      artist: round3(artist),
      duration: round3(duration),
      ytTags: round3(ytTags ?? 0),
      isrc: round3(isrc ?? 0),
    };

    const finalScore = unit(blended - totalPenalty(penalties));
    const base: RecordingCandidate = {
      id: candidate.id,
      title: candidate.title,
      artist: candidate.artist,
      disambiguation: candidate.disambiguation ?? "",
      length: lengthSeconds === null ? null : round3(lengthSeconds),
      isrc: candidate.isrcs?.[0] ?? null,
      score: round3(finalScore),
      signals,
      penalties,
      why: [],
      preselected: false,
      safe: false,
      releases,
      borrow,
    };
    return { ...base, why: explain(video, base, penalties, config) };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
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
    ambiguous: margin !== null && margin < config.thresholds.ambiguityMargin,
    margin,
  };
}
