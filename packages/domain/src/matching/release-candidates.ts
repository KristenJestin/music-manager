/**
 * `releaseCandidates.score` — rank the MusicBrainz releases that could be the album behind a
 * playlist (`docs/04-pipeline-et-matching.md` § Release (album)).
 *
 * Thirteen signals, all in [0, 1], blended with the weights of `config.ts`, then reduced by named
 * penalties. The one that decides between two pressings of the same record is the **tracklist
 * fit**: how many of the release's tracks a video actually lands on, and by how much on
 * average. Title and artist put a candidate in the list; the fit is what tells a fourteen-track
 * European edition from the fifteen-track Japanese one with a bonus track, and nothing else in
 * the list can.
 *
 * The one that decides whether the record is the right record *at all* is **coverage**: how
 * many of your videos it would give a track to. The fit cannot answer that — a one-track single
 * fits its own tracklist 1/1 while dropping ten of your eleven videos, which is how one came to
 * be preselected at 94 % (decision 152).
 *
 * The fit costs one lookup per candidate, so not every candidate gets one: the service opens
 * them while an unopened one could still win and stops on its own (`exploreReleases`, and
 * `ceiling` below, which is the bound it branches on). A candidate without a tracklist is
 * marked `detailed: false` and its fit signal is dropped from the denominator rather than
 * counted as zero — an un-looked-up release must rank *below* the examined ones without being
 * slandered.
 *
 * That same lookup answers a second question for free, and decision 167 is about spending it:
 * a release lookup carries `cover-art-archive`, so **whether this pressing has a front cover**
 * is known for exactly the candidates whose fit is known, at no extra request. It is a light
 * signal (0.03) because it settles a tie rather than picks a record — the fifth owner review's
 * *Pure Heroine*, where a 2013 US pressing with no image at all sat one point in front of a
 * 2014 worldwide one with a cover.
 */

import { assign } from "./mapping.ts";
import { withDefaults, type DeepPartialConfig } from "./config.ts";
import {
  artistScore,
  countryScore,
  coverArtOf,
  coverArtScore,
  creditName,
  disambiguationPenalties,
  exactnessScore,
  flattenTracks,
  formatScore,
  labelScore,
  mainCatalogNumber,
  mainFormat,
  mainLabel,
  mediaOf,
  round3,
  secondaryTypePenalties,
  statusScore,
  titleKeywordPenalties,
  titleScore,
  totalPenalty,
  trackTotal,
  typeScore,
  unit,
  releaseYearScore,
  yearOf,
  yearScore,
} from "./signals.ts";
import { sourceEdition } from "../normalize/title.ts";
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
 * The two directions of the fit, from one assignment.
 *
 * `signal` is the share of the *release's* tracks that some video covers within the tolerance.
 * Its denominator is the tracklist, and deliberately so: fifteen videos over a fourteen-track
 * edition cover 14/14 — the extra video is a separate problem — while the same fifteen videos
 * over the fifteen-track Japanese edition cover 14/15, because the bonus track has no video,
 * and *that* is a genuine mark against the candidate. Changing this denominator to
 * `max(videos, tracks)`, the other option the third owner review offers, would flatten those
 * two to the same number and lose the one comparison the fit exists to make.
 *
 * `coverage` is the direction that was missing (D3, decision 152): the share of the **source
 * videos** the assignment binds to anything at all. A one-track single scores `signal` 1.0 and
 * `coverage` 1/11. Between them there is no longer a way for a candidate to look perfect while
 * importing one eleventh of the playlist.
 */
function tracklistFit(
  input: ReleaseScoreInput,
  candidate: ReleaseCandidateInput,
  config: MatchingConfig,
): {
  fit: number;
  fitOf: number;
  uncovered: number;
  leftOver: number;
  signal: number | null;
  coverage: number | null;
  exactness: number | null;
  meanAbsDelta: number | null;
  lines: readonly FitLine[];
} {
  const detailed =
    candidate.detailed ?? (candidate.release.media ?? []).some((m) => (m.tracks ?? []).length > 0);
  const tracks = detailed ? flattenTracks(candidate.release) : [];
  if (tracks.length === 0) {
    const total = trackTotal(candidate.release);
    return {
      fit: 0,
      fitOf: total,
      uncovered: total,
      leftOver: 0,
      signal: null,
      coverage: null,
      exactness: null,
      meanAbsDelta: null,
      lines: [],
    };
  }
  const result = assign(input.videos, tracks, config);
  const videoCount = input.videos.length;
  return {
    fit: result.fit,
    fitOf: result.fitOf,
    uncovered: result.uncoveredTracks.length,
    leftOver: result.extraVideos.length,
    signal: result.fitOf === 0 ? null : unit(result.fit / result.fitOf),
    coverage: videoCount === 0 ? null : unit(result.bound / videoCount),
    exactness: exactnessScore(result.bound, videoCount, tracks.length),
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
 * `trackSurplusCost` of what a missing one does — 0.7 since decision 152, where the 0.35 it was
 * before is the “pénalité dérisoire” the third owner review names.
 */
function trackCountScore(videos: number, tracks: number, surplusCost: number): number {
  if (tracks === 0) return 0;
  const span = Math.max(videos, tracks);
  const surplus = Math.max(0, videos - tracks);
  const missing = Math.max(0, tracks - videos);
  return unit(1 - (surplus / span) * surplusCost - missing / span);
}

/**
 * The deduction for the videos a candidate would leave behind.
 *
 * Quadratic in the shortfall, which is what lets one signal serve two cases that look alike on
 * paper and are nothing alike in practice — see `coveragePenalty` in `config.ts`. Returns no
 * penalty at all rather than a zero-amount one, so the card never prints a line about a
 * problem the candidate does not have.
 *
 * A candidate whose tracklist was never fetched gets none of this: its coverage is *unknown*,
 * not bad, and the ranking already keeps unexamined candidates below examined ones.
 */
function coveragePenalties(coverage: number | null, config: MatchingConfig): Penalty[] {
  if (coverage === null) return [];
  const shortfall = unit(1 - coverage);
  if (shortfall <= 0) return [];
  const amount = round3(config.thresholds.coveragePenalty * shortfall * shortfall);
  if (amount < 0.005) return [];
  return [
    {
      reason: `Only ${String(Math.round(coverage * 100))} % of your videos would be imported from this release`,
      amount,
    },
  ];
}

/** The thirteen signals, paired with their weights, `null` where this candidate has none. */
function releaseParts(
  signals: ReleaseSignals,
  unknown: {
    fit: number | null;
    coverage: number | null;
    exactness: number | null;
    coverArt: number | null;
    type: number | null;
  },
  config: MatchingConfig,
): readonly (readonly [number, number | null])[] {
  const w = config.weights.release;
  return [
    [w.title, signals.title],
    [w.artist, signals.artist],
    [w.durations, unknown.fit],
    [w.coverage, unknown.coverage],
    [w.exactness, unknown.exactness],
    [w.trackCount, signals.trackCount],
    [w.year, signals.year],
    [w.label, signals.label],
    [w.format, signals.format],
    [w.status, signals.status],
    [w.country, signals.country],
    [w.coverArt, unknown.coverArt],
    [w.type, unknown.type],
  ];
}

/** Blend the thirteen signals, dropping the ones that do not exist for this candidate. */
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

/**
 * The best score a candidate could still reach, given what is already known about it.
 *
 * The bound the adaptive exploration branches on, and it has to be a bound on **everything a
 * lookup could change**, not merely on the tracklist. Getting that wrong is silent and total:
 * a candidate whose ceiling under-states it is never opened, so it never gets the chance to
 * win, which is the exact bug this machinery exists to fix. *Appeal to Reason* found it the
 * first time — a release search carries no `first-release-date` for the release group, so the
 * 2014 pressing of a 2008 record scored zero on year while unopened, came out at 0.960 against
 * a leader at 0.967, and was bounded away one lookup short of the answer it turns into.
 *
 * So four things are treated as attainable:
 *
 *  - the **fit family** (`durations`, `coverage`, `exactness`), bounded by the track count the
 *    search result *does* carry: `min(videos, tracks)` is the most the 1:1 assignment could
 *    ever bind, so a fifteen-track pressing facing fourteen videos cannot exceed `14/15`
 *    whatever its tracklist turns out to be. That is what keeps the bound tight;
 *  - the **cover**, at 1: a search says nothing about the Cover Art Archive;
 *  - the **year**, at 1 when the release group's first date is missing, because the lookup
 *    supplies it and it may well agree;
 *  - the **label**, at 1 when the search result names none.
 *
 * Everything else — title, artist, country, format, status, type, and every penalty the
 * disambiguation comment already earns — is genuinely known from the search result and enters
 * at its real value. A candidate whose tracklist is already read has nothing left unknown at
 * all, so its ceiling is its score.
 */
function ceilingOf(
  signals: ReleaseSignals,
  typeSignal: number | null,
  videoCount: number,
  trackCount: number,
  attainable: { readonly year: number; readonly label: number },
  knownPenalties: readonly Penalty[],
  config: MatchingConfig,
): number {
  const span = Math.max(videoCount, trackCount);
  const maxBound = Math.min(videoCount, trackCount);
  const bestCoverage = videoCount === 0 ? null : unit(maxBound / videoCount);
  const best = blend(
    releaseParts(
      { ...signals, year: attainable.year, label: attainable.label },
      {
        fit: trackCount === 0 ? null : unit(maxBound / trackCount),
        coverage: bestCoverage,
        exactness: span === 0 ? null : unit(maxBound / span),
        coverArt: 1,
        type: typeSignal,
      },
      config,
    ),
  );
  // The coverage deduction is bounded by the track count too: a one-track single facing eleven
  // videos owes the whole of it before anybody reads its tracklist.
  const penalties = [...coveragePenalties(bestCoverage, config), ...knownPenalties];
  return unit(best - totalPenalty(penalties));
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
      "Tracklist not fetched, so the fit is unknown — nothing it could still score would have won",
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
    /*
     * The line the third owner review asked for, in the terms it asked for them.
     *
     * "10 videos more than the tracklist has tracks" was true, buried among nine other bullets
     * and worth four points of score. What a person needs to read first is the *outcome*: how
     * many of the videos in front of them this candidate would actually import.
     */
    why.push(
      `${String(candidate.videos - candidate.leftOver)} of your ${String(candidate.videos)} video${candidate.videos === 1 ? "" : "s"} would find a track here`,
    );
    if (candidate.leftOver > 0) {
      why.push(
        `${String(candidate.leftOver)} video${candidate.leftOver === 1 ? "" : "s"} would be left over — this release does not have ${candidate.leftOver === 1 ? "that song" : "those songs"}`,
      );
    }
    /*
     * The sentence the sixth owner review is about, and the reason `exactness` exists.
     *
     * "14 of your 14 videos would find a track here" was true of the fifteen-track edition
     * *and* of the fourteen-track one, and a reader comparing two cards had no way to see
     * that one of them left a track behind and the other left nothing anywhere. This says the
     * whole of it in one line, and only when it is true of both directions at once.
     */
    if (candidate.uncovered === 0 && candidate.leftOver === 0) {
      why.push("Exact fit: no track of this release and none of your videos is left over");
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

  /*
   * The primary type, in words, and only when it is *not* an album.
   *
   * An Album is the expected shape and saying so on every card would be noise; an EP or a
   * Single winning is the thing a reader has to be able to question, so that is the case the
   * sentence exists for. It says "weighed against", never "refused", because that is what the
   * signal does — see `typeScore`.
   */
  if (candidate.type !== null && candidate.type !== "" && candidate.signals.type < 1) {
    why.push(`Filed as a ${candidate.type} rather than an Album, which weighs against it`);
  }

  /*
   * The cover, in words (fifth owner review, G1).
   *
   * The owner's case was two pressings of *Pure Heroine* a point apart, the one in front
   * carrying no image at all — and nothing on the card said so. The sentence is printed
   * whenever the answer is *known*: a release that was looked up either has a front or does
   * not, and "no cover art" is a fact about the release, not a gap in what we asked.
   */
  if (candidate.coverArt !== null) {
    if (candidate.coverArt.front) {
      why.push(
        `Cover art available on the Cover Art Archive (${String(candidate.coverArt.count)} image${candidate.coverArt.count === 1 ? "" : "s"})`,
      );
    } else if (candidate.coverArt.available) {
      why.push("The Cover Art Archive has images for this release, but no approved front cover");
    } else {
      why.push(
        "No cover art on MusicBrainz for this release — the cover would come from elsewhere",
      );
    }
  }

  if (candidate.signals.label >= 0.99 && candidate.label !== null) {
    why.push(`Label ${candidate.label} matches the “Provided to YouTube by” line`);
  } else if (candidate.signals.label <= 0.6 && candidate.label !== null) {
    why.push(`Label ${candidate.label} differs from the “Provided to YouTube by” line — minor`);
  }

  /*
   * The penalties, as percentages, because `why` is the *whole* argument.
   *
   * They are printed here and nowhere else. The card used to render `why` and then
   * `penalties` underneath it, so every deduction appeared twice — once as "(−0.2)" and once
   * as "(−20%)" — which is not two reasons, it is one reason and a bug (seen on the Bad Ideas
   * deluxe pressing while checking D3). A percentage, because that is the scale every other
   * number on the card is on.
   */
  for (const penalty of penalties) {
    why.push(`${penalty.reason} (−${String(Math.round(penalty.amount * 100))} %)`);
  }
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
  /*
   * Which edition the source announced — "deluxe", "live", nothing at all.
   *
   * Falls back to reading the album hint here rather than requiring the caller to have run
   * `albumHints`: the wizard's hand search and the pinned-release path build hints of their
   * own, and an edition that is announced in the title must not depend on which door the
   * ranking came through.
   */
  const wantedEdition =
    input.hints.edition ?? (sourceAlbum === "" ? [] : sourceEdition(sourceAlbum));

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
      leftOver,
      signal: fitSignal,
      coverage: coverageSignal,
      exactness: exactnessSignal,
      meanAbsDelta,
      lines: fitLines,
    } = tracklistFit(input, candidate, config);

    const coverArt = coverArtOf(release);
    const coverArtSignal = coverArtScore(coverArt);
    const typeSignal = typeScore(group?.["primary-type"]);

    const signals: ReleaseSignals = {
      title: round3(sourceAlbum === "" ? 0.5 : titleScore(sourceAlbum, release.title ?? "")),
      artist: round3(artistScore(sourceArtists, artist)),
      trackCount: round3(trackCountScore(videoCount, tracks, config.thresholds.trackSurplusCost)),
      durations: round3(fitSignal ?? 0),
      coverage: round3(coverageSignal ?? 0),
      exactness: round3(exactnessSignal ?? 0),
      year: round3(
        releaseYearScore(sourceYear, yearOf(release.date), yearOf(group?.["first-release-date"])),
      ),
      label: round3(labelScore(input.hints.label, label)),
      format: round3(formatScore(format, config.preferences)),
      status: round3(statusScore(release.status ?? null)),
      country: round3(countryScore(country, config.preferences)),
      coverArt: round3(coverArtSignal ?? 0),
      type: round3(typeSignal ?? 0),
    };

    /** The deductions a search result already earns, before any tracklist is read. */
    const knownPenalties: Penalty[] = [
      ...disambiguationPenalties(release.disambiguation, config.preferences, {
        wanted: wantedEdition,
        candidateTitle: release.title ?? "",
      }),
      ...secondaryTypePenalties(group?.["secondary-types"], group?.["primary-type"]),
      ...titleKeywordPenalties(
        release.title ?? "",
        group?.["primary-type"],
        group?.["secondary-types"],
        wantedEdition,
      ),
    ];
    const penalties: Penalty[] = [...coveragePenalties(coverageSignal, config), ...knownPenalties];

    const blended = blend(
      releaseParts(
        signals,
        {
          fit: fitSignal,
          coverage: coverageSignal,
          exactness: exactnessSignal,
          coverArt: coverArtSignal,
          type: typeSignal,
        },
        config,
      ),
    );
    const finalScore = unit(blended - totalPenalty(penalties));
    /*
     * A read tracklist leaves nothing unknown, so its ceiling *is* its score. Saying that here
     * rather than recomputing keeps the two numbers from ever disagreeing by a rounding.
     */
    const ceiling =
      fitSignal === null
        ? ceilingOf(
            signals,
            typeSignal,
            videoCount,
            tracks,
            {
              // A release *search* result carries no `first-release-date` for its group and
              // often no label at all; the lookup supplies both, and both may agree.
              year:
                yearOf(group?.["first-release-date"]) === null && sourceYear != null
                  ? 1
                  : signals.year,
              label: label === null ? 1 : signals.label,
            },
            knownPenalties,
            config,
          )
        : finalScore;

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
      catalogNumber: mainCatalogNumber(release),
      packaging: release.packaging ?? null,
      media: mediaOf(release),
      coverArt,
      tracks,
      score: round3(finalScore),
      fit,
      fitOf,
      uncovered,
      leftOver,
      videos: videoCount,
      ceiling: round3(ceiling),
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
  /*
   * …and, at an exactly equal score and fit, the one that comes with a picture wins.
   *
   * The 0.03 weight already decides the ordinary case; this is the pathological one the fifth
   * owner review's screenshot is a hair away from — two pressings of one album that agree on
   * every signal the engine has. Falling back to `id.localeCompare` there would be choosing an
   * import with no cover over an identical one with a cover, by alphabetical accident.
   */
  const withFront = (candidate: ReleaseCandidate): number =>
    candidate.coverArt === null
      ? 0
      : candidate.coverArt.front
        ? 2
        : candidate.coverArt.available
          ? 1
          : 0;

  /*
   * …and, before the cover, the pressing whose **own date** is the one the source named.
   *
   * `releaseYearScore` deliberately stopped treating a re-pressing as a contradiction — a 2014
   * digital master of a 2008 record is the thing YouTube streams, and scoring it zero on year
   * cost *Appeal to Reason* the edition that fits it exactly. But flattening the signal between
   * pressings of one record threw away something true with it: at an exactly equal score and
   * fit, the pressing dated the year the source announces is the one the source came from.
   * Without this line the deeper exploration of the sixth review reached a 2014 American
   * re-issue of *Discovery*, tied the 2001 French CD to the thousandth, and won the tie on
   * having a picture — which is decision 167 answering a question nobody asked it.
   *
   * It sits *above* `withFront` and leaves decision 167 intact, because that tie-break only
   * ever fires at a strictly equal score, and the 0.03 the cover is worth separates two
   * pressings long before it gets there. *Pure Heroine* still preselects the pressing with the
   * picture; it wins on score, not on a tie.
   */
  const ownYear = (candidate: ReleaseCandidate): number => yearScore(sourceYear, candidate.year);

  const ranked = [...scored].sort(
    (a, b) =>
      Number(b.detailed) - Number(a.detailed) ||
      b.score - a.score ||
      b.fit - a.fit ||
      a.fitOf - b.fitOf ||
      ownYear(b) - ownYear(a) ||
      withFront(b) - withFront(a) ||
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
  if (
    a.tracks === b.tracks &&
    a.fit === b.fit &&
    a.uncovered === b.uncovered &&
    a.leftOver === b.leftOver
  ) {
    return false; // the same import either way — a barcode, not a decision
  }
  // The outcomes differ, but if the preselected one covers at least as much and leaves no more
  // behind, it simply *wins*. A question is only worth asking when the runner-up would gain
  // something: more tracks covered, fewer left uncovered, or fewer of your videos dropped.
  const coversMore = b.fit > a.fit;
  const leavesLessBehind = b.uncovered < a.uncovered;
  const dropsFewerVideos = b.leftOver < a.leftOver;
  return coversMore || leavesLessBehind || dropsFewerVideos;
}
