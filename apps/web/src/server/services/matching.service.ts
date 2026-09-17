/**
 * The matching service: turn a resolved import into scored MusicBrainz candidates
 * (`docs/04-pipeline-et-matching.md` § Algorithme de présélection).
 *
 * The pure engine lives in `@mm/domain/matching` and knows nothing about the network. This
 * module is the half that does: it decides **which** MusicBrainz documents are worth fetching,
 * in what order, and how many. That decision is the whole cost of a match, so it is bounded
 * and counted rather than left to grow with the size of the answer:
 *
 *  - **a ladder of release-group searches, then one per group kept** (`matchGroupLimit`,
 *    default 3). Every rung carries the artist, and that is the rule the sixth owner review
 *    turned into a hard one: the rung that dropped it — `releasegroup:"Bewitched"` on its own —
 *    returned a hundred and forty-two homonyms and is why Laura Fygi's 1993 record was imported
 *    for a Laufey playlist. The ladder is `first credited artist` → `whole credit` →
 *    `base title` (the edition qualifier stripped) → **the recordings**, and it stops at the
 *    first rung with an answer. See `findReleaseGroups`.
 *  - **lookups by branch and bound, under a ceiling** (`matchLookupLimit`, default 14). The
 *    tracklist fit is the signal that separates two pressings of one album, and it needs the
 *    actual tracklist, which the search results do not carry. The old plan spent a flat six
 *    from the top of the pre-score, and *Appeal to Reason*'s fourteen-track edition ranked
 *    twelfth: a number decided, on its own, whether the right album was ever examined. What
 *    replaces it opens candidates while an unopened one's `ceiling` — the best it could still
 *    reach — is strictly above the best complete score, and stops early only on a leader that
 *    is `safe`, unambiguous **and exact**. The **first** lookup of each kept group is still
 *    reserved: a group cannot be compared on a fit nobody read.
 *
 * Both halves of that budget are returned in `budget`, which is what the test asserts on —
 * a promise about request counts that nothing measures is not a promise.
 *
 * Every call goes through P04's `integrations/musicbrainz.ts`, hence through the one-request-
 * per-second limiter and the raw cache. In fixtures mode the context is `offline`, the cache
 * has been seeded from the cassettes, and a request that tried to leave would throw.
 */
import {
  creditCarriesArtist,
  DEFAULT_GROUP_LIMIT,
  DEFAULT_LOOKUP_LIMIT,
  DEFAULT_RECORDING_LOOKUP_LIMIT,
  flattenTracks,
  lucene,
  mapping as mappingEngine,
  primaryArtist,
  recordingCandidates,
  releaseCandidates,
  releaseGroups,
  stripArtistPrefix,
  stripEditionQualifier,
  titleScore,
  type AlbumHints,
  type DeepPartialConfig,
  type GroupSearchScore,
  type MappingResult,
  type MatchVideo,
  type MbRecording,
  type MbRelease,
  type MbReleaseGroup,
  type RecordingCandidate,
  type RecordingCandidateInput,
  type RecordingRanking,
  type ReleaseCandidate,
  type ReleaseCandidateInput,
  type ReleaseGroupRanking,
  type ReleaseRanking,
} from "@mm/domain";
import type { MbSearchResult } from "#/server/integrations/musicbrainz.ts";
import type { Settings } from "#/server/services/settings.ts";
import type { MbGateway } from "#/server/services/matching.gateway.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The engine configuration, assembled from the settings.
 *
 * The weights are settings too (`matchWeights*`), so a library that keeps disagreeing with the
 * defaults can be corrected without a release — which is the point of `docs/04` calling them
 * "poids et seuils en paramètres".
 */
export function configFromSettings(settings: Settings): DeepPartialConfig {
  return {
    weights: {
      release: settings.matchReleaseWeights,
      recording: settings.matchRecordingWeights,
      mapping: settings.matchMappingWeights,
    },
    thresholds: {
      safe: settings.safeThreshold,
      ambiguityMargin: settings.matchAmbiguityMargin,
      bindingFloor: settings.matchBindingFloor,
      durationToleranceSeconds: settings.matchDurationTolerance,
      titleMatch: settings.titleMatchThreshold,
      coveragePenalty: settings.matchCoveragePenalty,
    },
    preferences: {
      countries: settings.preferredCountries,
      format: settings.preferredFormat,
      explicit: settings.explicitPreference,
    },
  };
}

/**
 * The **ceiling** on tracklist lookups for one album match, not the number it will spend.
 *
 * Since the sixth owner review this is a bound on a branch and bound, and the ordinary album
 * comes nowhere near it: see `exploreReleases`, and `DEFAULT_LOOKUP_LIMIT` in the engine for
 * why the default rose from six to fourteen when it stopped being a plan.
 */
export function lookupLimitOf(settings: Settings): number {
  return settings.matchLookupLimit > 0 ? settings.matchLookupLimit : DEFAULT_LOOKUP_LIMIT;
}

/**
 * How many recordings get a lookup on the **single** path.
 *
 * Capped apart from the album ceiling and never above it: a recording lookup buys the borrow
 * ladder, there is no bound to stop early on, and every one of them is spent. Lowering
 * `matchLookupLimit` still lowers this; raising it to reach a buried pressing does not make a
 * lone video cost fourteen seconds.
 */
export function recordingLookupLimitOf(settings: Settings): number {
  return Math.min(lookupLimitOf(settings), DEFAULT_RECORDING_LOOKUP_LIMIT);
}

/** How many release groups get a release search of their own (decision 151). */
export function groupLimitOf(settings: Settings): number {
  return settings.matchGroupLimit > 0 ? settings.matchGroupLimit : DEFAULT_GROUP_LIMIT;
}

/**
 * The budget an album match is allowed to spend, before it spends any of it.
 *
 * Read by the progress screen, so the person waiting eight seconds is told what the eight
 * seconds are for. It is a *ceiling*: a match that finds one release group spends two searches
 * of the four, and says so when it revises the plan.
 */
export function plannedBudgetOf(settings: Settings): MatchBudget {
  return { searches: 1 + groupLimitOf(settings), lookups: lookupLimitOf(settings) };
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

/** What one match cost, in MusicBrainz documents. Asserted by `matching.budget.test.ts`. */
export interface MatchBudget {
  readonly searches: number;
  readonly lookups: number;
}

/** Whether the ranking contains anything actually credited to the artist the source names. */
export interface ArtistVerdict {
  /** The credit the source carries, or `null` when it names nobody. */
  readonly wanted: string | null;
  /** True when at least one candidate carries it — or when there was nothing to carry. */
  readonly carried: boolean;
  readonly carriedBy: number;
}

export interface AlbumMatch {
  readonly kind: "album";
  readonly ranking: ReleaseRanking;
  /** The same candidates, folded back into their release groups — what step 2 draws. */
  readonly groups: ReleaseGroupRanking;
  /** The proposed 1:1 mapping against the preselected release. */
  readonly mapping: MappingResult | null;
  /** The preselected release, fully looked up. */
  readonly release: MbRelease | null;
  readonly budget: MatchBudget;
  /** The ceiling this match was allowed, so a screen can show spent against planned. */
  readonly planned: MatchBudget;
  readonly queries: readonly string[];
  /** Which rung of the search ladder answered, when it was not the first. */
  readonly fallback: MatchFallback | null;
  /** The artist gate: `carried: false` means nothing here is by the artist the source names. */
  readonly artist: ArtistVerdict;
  /** Why the adaptive exploration stopped. */
  readonly stoppedBecause: Exploration["stoppedBecause"];
}

export interface SingleMatch {
  readonly kind: "single";
  readonly ranking: RecordingRanking;
  readonly budget: MatchBudget;
  readonly planned: MatchBudget;
  readonly queries: readonly string[];
  /** The same gate as the album path: nothing here is by the artist the video names. */
  readonly artist: ArtistVerdict;
}

/* ------------------------------------------------------------------ */
/* album                                                               */
/* ------------------------------------------------------------------ */

export interface AlbumMatchInput {
  readonly videos: readonly MatchVideo[];
  readonly hints: AlbumHints;
}

function releasesOf(result: MbSearchResult | null): readonly MbRelease[] {
  return result?.releases ?? [];
}

/**
 * Which rung of the search ladder produced the candidates, when it was not the first.
 *
 * Carried out of the match and written to the import's journal, because a fallback that only
 * shows up as "it worked this time" is a fallback nobody can audit: the person reading a
 * questionable import has to be able to see that MusicBrainz was asked a different question
 * from the one the playlist's title implies.
 */
export type MatchFallback =
  | { readonly kind: "primary-artist"; readonly from: string; readonly to: string }
  | { readonly kind: "base-title"; readonly from: string; readonly to: string }
  | {
      readonly kind: "recordings";
      readonly sampled: number;
      readonly titles: readonly string[];
      readonly groups: readonly string[];
    };

/** One line of English per fallback, for `ctx.say` and for the wizard. */
export function describeFallback(fallback: MatchFallback): string {
  switch (fallback.kind) {
    case "primary-artist":
      return `The credit “${fallback.from}” names more than one artist, so MusicBrainz was asked for the first of them, “${fallback.to}” — a composite credit is almost never one it publishes.`;
    case "base-title":
      return `The search came back empty for “${fallback.from}”, so it fell back to the base title, “${fallback.to}” — the edition qualifier was treated as noise.`;
    case "recordings":
      return (
        `The album search came back empty, so ${String(fallback.sampled)} track${fallback.sampled === 1 ? "" : "s"} ` +
        `(${fallback.titles.join(", ")}) were searched as recordings; they converge on ` +
        `${String(fallback.groups.length)} release group${fallback.groups.length === 1 ? "" : "s"}.`
      );
  }
}

/**
 * How many tracks the recording fallback searches before it gives up on converging.
 *
 * Four, and the number is a budget decision as much as a statistical one. Each one is a search
 * through the one-request-per-second gate, so fourteen tracks would be fourteen seconds spent
 * on a question three of them already answer: a release group named by **two** independent
 * tracks of the same playlist, by the same artist, at the same lengths, is not a coincidence
 * any homonym produces. Four samples leave room for two of them to find nothing at all — a
 * track MusicBrainz spells differently, a duration YouTube rounds the other way — and still
 * reach the two agreeing votes the convergence asks for.
 */
const CONVERGENCE_SAMPLE = 4;

/** How many of the sampled tracks must name a release group before it is believed. */
const CONVERGENCE_VOTES = 2;

/**
 * Which videos to send through the recording fallback.
 *
 * The **longest** ones, tie broken by their position in the listing. A ninety-second interlude
 * called "Prelude" names half of MusicBrainz; a four-minute song called "Wishful Drinking"
 * names one record. Length is the cheapest available proxy for "this title is a real song",
 * and the duration window of the query itself is a second discriminator that a short track
 * would not survive either.
 */
function convergenceSample(videos: readonly MatchVideo[]): MatchVideo[] {
  const usable = videos.filter((video) => (video.ytTrack ?? video.title).trim() !== "");
  return [...usable]
    .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0) || a.index - b.index)
    .slice(0, CONVERGENCE_SAMPLE);
}

/**
 * The last rung: find the album through its **tracks** rather than through its name.
 *
 * The second and third defects of the sixth owner review are one defect. `release:"Bewitched"
 * AND artist:"Laufey, Spencer Stewart"` returns nothing — YouTube credits the artist *and* the
 * producer, and that composite credit exists nowhere in MusicBrainz — and the answer used to
 * be `release:"Bewitched"` on its own, a hundred and forty-two records by everybody who ever
 * used the word. Dropping the artist is never the right widening.
 *
 * Widening the *title* is. A handful of track titles, each with the artist and a ±5 s duration
 * window, are far more discriminating than one album title: "Bewitched", "Puzzle", "Listen"
 * and "Gemini" are common words, and "From The Start" by Laufey at 3:19 is not. The recordings
 * come back carrying the releases they appear on, and those carry their release groups, so the
 * votes are counted off the search results themselves — no lookup, no second request.
 *
 * A group is only believed when `CONVERGENCE_VOTES` distinct sampled tracks name it **and** it
 * bears the album's name, so the fallback cannot wander off to the artist's other records.
 * From there the match resumes exactly where the first rung would have left it: these are
 * release groups, and the edition selection that follows is unchanged.
 */
async function convergeThroughRecordings(
  mb: MbGateway,
  hints: AlbumHints,
  videos: readonly MatchVideo[],
  limit: number,
  queries: string[],
  config: DeepPartialConfig,
): Promise<{ groups: readonly MbReleaseGroup[]; fallback: MatchFallback | null }> {
  const album = (hints.album ?? "").trim();
  const base = stripEditionQualifier(album);
  const credit = (hints.artist ?? "").trim();
  const artist = primaryArtist(credit) ?? credit;
  if (album === "" || artist === "") return { groups: [], fallback: null };

  const titleFloor = config.thresholds?.titleMatch ?? 0.87;
  const sample = convergenceSample(videos);
  /** group id → the sampled track indices that named it, and the group document. */
  const votes = new Map<string, { voters: Set<number>; group: MbReleaseGroup }>();

  for (const video of sample) {
    const query = lucene.recordingQuery({
      title: stripArtistPrefix(video.ytTrack ?? video.title, artist),
      artist,
      durationSeconds: video.durationSeconds,
    });
    queries.push(query);
    const answer = await mb.search("recording", query, limit);
    const seenHere = new Set<string>();

    for (const recording of answer?.recordings ?? []) {
      const credited = recording["artist-credit"] ?? [];
      const name = credited
        .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
        .join("")
        .trim();
      // A recording by somebody else is exactly what this fallback must not vote on: the
      // search is forgiving, and "Bewitched" by Laura Fygi comes back for a Laufey query too.
      if (!creditCarriesArtist(credit, name)) continue;

      for (const release of (recording as { releases?: readonly MbRelease[] }).releases ?? []) {
        const group = release["release-group"];
        const id = group?.id;
        if (group === undefined || id === undefined || id === "" || seenHere.has(id)) continue;
        const title = group.title ?? release.title ?? "";
        if (titleScore(album, title) < titleFloor && titleScore(base, title) < titleFloor) continue;
        seenHere.add(id);
        const entry = votes.get(id) ?? {
          voters: new Set<number>(),
          // The group stub a release carries has no artist credit of its own; borrowing the
          // recording's is honest — this vote exists *because* that credit matched — and it
          // keeps `releaseGroups.searchScore` from marking every converged group down to zero
          // on a field the search never sends.
          group: { ...group, "artist-credit": credited } as MbReleaseGroup,
        };
        entry.voters.add(video.index);
        votes.set(id, entry);
      }
    }
  }

  const converged = [...votes.values()]
    .filter((entry) => entry.voters.size >= CONVERGENCE_VOTES)
    .sort((a, b) => b.voters.size - a.voters.size)
    .map((entry) => entry.group);

  if (converged.length === 0) return { groups: [], fallback: null };
  return {
    groups: converged,
    fallback: {
      kind: "recordings",
      sampled: sample.length,
      titles: sample.map((video) => video.ytTrack ?? video.title),
      groups: converged.map((group) => group.id ?? ""),
    },
  };
}

/**
 * The `release-group` search: every group the album title could name, scored and ordered.
 *
 * Groups are ranked by the engine's own title/artist agreement plus a lean on the primary
 * type, not by MusicBrainz's relevance: MB scores a query, we score a hypothesis, and on a
 * common album title ("Discovery" is also a Mr. Children record; "Bad Ideas" is an album and a
 * single by the same artist) that is the difference between one candidate and the right one.
 *
 * **Four rungs, and every one of them names an artist.** Each is asked only when the one above
 * it came back empty, so the ordinary album still costs exactly one search:
 *
 *  1. the album title and the **first credited artist** — "Laufey" out of "Laufey, Spencer
 *     Stewart". YouTube credits whoever the label listed, producers included, and a composite
 *     credit exists in MusicBrainz almost never. The narrowest *plausible* question first.
 *  2. the album title and the **whole credit**, when there is more than one name in it: some
 *     records really are credited to a pair, and "Macklemore & Ryan Lewis" is one of them.
 *  3. the **base title** and the first credited artist, the edition qualifier treated as noise:
 *     "Let Go (Expanded Edition)" is a name MusicBrainz does not publish, and forty of the
 *     owner's imports were stuck on that alone.
 *  4. the **recordings**, in `convergeThroughRecordings` — the album found through its tracks.
 *
 * What is deliberately *not* a rung, at any point, is the title on its own. That question was
 * the cause of the worst class of failure this matcher has: an album by a different artist,
 * imported silently, under a plausible name.
 */
async function findReleaseGroups(
  mb: MbGateway,
  hints: AlbumHints,
  videos: readonly MatchVideo[],
  limit: number,
  queries: string[],
  config: DeepPartialConfig,
): Promise<{ groups: GroupSearchScore[]; fallback: MatchFallback | null }> {
  const album = (hints.album ?? "").trim();
  if (album === "") return { groups: [], fallback: null };
  const credit = (hints.artist ?? "").trim();
  const primary = primaryArtist(credit);
  const base = stripEditionQualifier(album);

  const rungs: { query: string; fallback: MatchFallback | null }[] = [
    { query: lucene.releaseGroupQuery(album, primary ?? credit), fallback: null },
  ];
  if (primary !== null) {
    rungs[0] = {
      query: lucene.releaseGroupQuery(album, primary),
      fallback: { kind: "primary-artist", from: credit, to: primary },
    };
    rungs.push({ query: lucene.releaseGroupQuery(album, credit), fallback: null });
  }
  if (base !== album) {
    rungs.push({
      query: lucene.releaseGroupQuery(base, primary ?? credit),
      fallback: { kind: "base-title", from: album, to: base },
    });
  }

  for (const rung of rungs) {
    if (rung.query === "") continue;
    queries.push(rung.query);
    const answer = await mb.search("release-group", rung.query, limit);
    const found: readonly MbReleaseGroup[] = answer?.["release-groups"] ?? [];
    if (found.length === 0) continue;
    return {
      groups: releaseGroups.searchScore(found, hints, videos.length),
      fallback: rung.fallback,
    };
  }

  const converged = await convergeThroughRecordings(mb, hints, videos, limit, queries, config);
  return {
    groups: releaseGroups.searchScore(converged.groups, hints, videos.length),
    fallback: converged.fallback,
  };
}

/**
 * The lookups reserved before the exploration starts: one for the best release of each group.
 *
 * A group whose releases were never looked up has no fit, so it cannot be compared with one
 * that was, and the flat pre-score — title, artist and track counts, exactly the signals that
 * made a one-track single look like an album — would happily spend everything inside the wrong
 * group and call the question settled.
 */
function reserveOnePerGroup(
  prescored: readonly { id: string; releaseGroupId: string | null }[],
  limit: number,
): string[] {
  const chosen: string[] = [];
  const seenGroups = new Set<string>();
  for (const candidate of prescored) {
    if (candidate.id === "" || chosen.length >= limit) break;
    const key = candidate.releaseGroupId ?? "";
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    chosen.push(candidate.id);
  }
  return chosen;
}

/**
 * The fewest candidates a match opens before the early stop is allowed to fire.
 *
 * Not a scoring rule — a *chooser* rule. Step 2 of the wizard is a list somebody picks from,
 * and a list with one real card and thirteen saying "tracklist not fetched" is worse than the
 * six the flat plan used to leave, even when the one card is right. Three is the smallest
 * number that still shows an alternative and a runner-up next to the preselection, and it costs
 * at most two requests on the easiest album there is. The bound is unaffected: a candidate that
 * cannot win is still never opened once the floor is met.
 */
const MIN_EXPLORED = 3;

/** What one round of exploration produced, and what it cost. */
export interface Exploration {
  readonly ranking: ReleaseRanking;
  readonly detailedById: ReadonlyMap<string, MbRelease>;
  /** Why the loop stopped, in one word — asserted by the tests and shown in the journal. */
  readonly stoppedBecause: "safe" | "bounded" | "ceiling" | "exhausted";
}

/**
 * Open candidates while an unopened one could still win. A branch and bound over the ranking.
 *
 * The second defect of the sixth owner review, in one function. The old code looked up the
 * first six of the pre-score and stopped, so a fourteen-track *Appeal to Reason* that ranked
 * twelfth on metadata alone was never read and stayed at "0 videos matched" — a constant
 * deciding, on its own, whether the right album was ever examined.
 *
 * The rule here decides it instead, and it is the standard one: keep going while the **best
 * attainable** score of some unopened candidate (`ReleaseCandidate.ceiling`) is strictly
 * greater than the best score of a candidate that is already complete. Strictly, because a
 * shelf of pressings identical to the leader has a ceiling *equal* to its score, and equality
 * has to be a stop or an album with two dozen editions costs two dozen seconds to learn
 * nothing. Optimism is what makes it correct — a candidate is never skipped while it could
 * still win — and the track count already in the search result is what makes it tight.
 *
 * Three things bound it beyond that:
 *
 *  - the **ceiling** (`matchLookupLimit`), for the pathological record;
 *  - the **leader being `safe`, unambiguous and exact** — above the threshold, with no
 *    runner-up worth asking about, and with no track of the release and no video of the
 *    playlist left over. *Exact* is doing real work in that sentence and is not decoration:
 *    "safe and unambiguous" on its own would have stopped this very loop on *Appeal to
 *    Reason* after one lookup, because the fifteen-track edition scores 0.967 with nothing
 *    near it and is the wrong answer. Only a **perfect** fit licenses stopping early, and it
 *    licenses it completely: `durations`, `coverage` and `exactness` are all 1, so no unopened
 *    candidate can do better than tie on the three signals worth 0.49 between them, and what
 *    is left to win is a barcode;
 *  - the gate every one of these calls goes through at one request per second, which is not a
 *    rule of this function but is the reason it is written to stop rather than to be thorough.
 */
export async function exploreReleases(
  mb: MbGateway,
  input: AlbumMatchInput,
  releases: readonly MbRelease[],
  config: DeepPartialConfig,
  bounds: { readonly ceiling: number; readonly safe: number },
): Promise<Exploration> {
  const detailedById = new Map<string, MbRelease>();
  const attempted = new Set<string>();

  const rank = (): ReleaseRanking =>
    releaseCandidates.score(
      {
        videos: input.videos,
        hints: input.hints,
        candidates: releases.map((release): ReleaseCandidateInput => {
          const full = release.id === undefined ? undefined : detailedById.get(release.id);
          return full === undefined
            ? { release, detailed: false }
            : { release: full, detailed: true };
        }),
      },
      config,
    );

  const open = async (mbid: string): Promise<void> => {
    attempted.add(mbid);
    const full = await mb.lookupRelease(mbid);
    if (full !== null) detailedById.set(mbid, full);
  };

  let ranking = rank();
  for (const mbid of reserveOnePerGroup(ranking.candidates, bounds.ceiling)) {
    if (attempted.size >= bounds.ceiling) break;
    await open(mbid);
  }
  ranking = rank();

  let stoppedBecause: Exploration["stoppedBecause"] = "exhausted";
  for (;;) {
    const leader = ranking.preselected;
    const exact = leader !== null && leader.uncovered === 0 && leader.leftOver === 0;
    if (
      attempted.size >= MIN_EXPLORED &&
      leader !== null &&
      leader.detailed &&
      exact &&
      leader.score >= bounds.safe &&
      !ranking.ambiguous
    ) {
      stoppedBecause = "safe";
      break;
    }
    if (attempted.size >= bounds.ceiling) {
      stoppedBecause = "ceiling";
      break;
    }

    let best = 0;
    for (const candidate of ranking.candidates) {
      if (candidate.detailed && candidate.score > best) best = candidate.score;
    }
    let next: ReleaseCandidate | null = null;
    for (const candidate of ranking.candidates) {
      if (candidate.detailed || candidate.id === "" || attempted.has(candidate.id)) continue;
      if (next === null || candidate.ceiling > next.ceiling) next = candidate;
    }
    if (next === null) {
      stoppedBecause = "exhausted";
      break;
    }
    if (attempted.size >= MIN_EXPLORED && next.ceiling <= best) {
      stoppedBecause = "bounded";
      break;
    }

    await open(next.id);
    ranking = rank();
  }

  return { ranking, detailedById, stoppedBecause };
}

export interface AlbumMatchHooks {
  /** Called once the real search count is known, so a progress bar can stop guessing. */
  readonly onPlan?: (planned: MatchBudget) => void;
}

/**
 * Match an album: the release groups, then the releases of the best few, then the fit, then
 * the mapping.
 *
 * Nothing here decides anything. It returns a ranking with a preselection and the reasons for
 * it; `confirm` is still the only thing that commits.
 */
export async function matchAlbum(
  mb: MbGateway,
  input: AlbumMatchInput,
  settings: Settings,
  hooks: AlbumMatchHooks = {},
): Promise<AlbumMatch> {
  const config = configFromSettings(settings);
  const lookupLimit = lookupLimitOf(settings);
  const groupLimit = groupLimitOf(settings);
  const queries: string[] = [];

  // 1 — the release groups, down the ladder of `findReleaseGroups`. Every rung names an
  // artist; the one that dropped it is the reason this review exists.
  const { groups: groupScores, fallback } = await findReleaseGroups(
    mb,
    input.hints,
    input.videos,
    settings.matchSearchLimit,
    queries,
    config,
  );
  const kept = groupScores.slice(0, groupLimit);
  hooks.onPlan?.({
    searches: queries.length + (kept.length === 0 ? 1 : kept.length),
    lookups: lookupLimit,
  });

  // 2 — the releases of each kept group. One search each, so no group is judged on a pressing
  // it does not have.
  const searchResults: MbRelease[] = [];
  const seen = new Set<string>();
  const collect = (releases: readonly MbRelease[]): void => {
    for (const release of releases) {
      if (release.id === undefined || seen.has(release.id)) continue;
      seen.add(release.id);
      searchResults.push(release);
    }
  };

  if (kept.length === 0) {
    /*
     * No group at all, after four rungs. The direct release search is the last thing left, and
     * it still carries the artist: an album this repository cannot find by name, by base name
     * or through its own tracks is an album to hand to a person, not an excuse to ask
     * MusicBrainz for every record that ever used the word.
     */
    const direct = lucene.releaseQuery({
      album: stripEditionQualifier(input.hints.album ?? ""),
      artist: primaryArtist(input.hints.artist ?? "") ?? input.hints.artist ?? null,
      year: input.hints.year ?? null,
    });
    if (direct !== "" && (input.hints.artist ?? "").trim() !== "") {
      queries.push(direct);
      collect(releasesOf(await mb.search("release", direct, settings.matchSearchLimit)));
    }
  } else {
    for (const group of kept) {
      const query = lucene.releaseQuery({
        album: input.hints.album ?? "",
        releaseGroupId: group.id,
      });
      queries.push(query);
      collect(releasesOf(await mb.search("release", query, settings.matchSearchLimit)));
    }
  }

  // 3 — open candidates while an unopened one could still win (branch and bound).
  const explored = await exploreReleases(mb, input, searchResults, config, {
    ceiling: lookupLimit,
    safe: settings.safeThreshold,
  });
  const { ranking, detailedById } = explored;

  // 4 — fold the flat ranking back into the groups the screen shows.
  const index = new Map(groupScores.map((group) => [group.id, group]));
  const grouped = releaseGroups.group(ranking.candidates, index);

  // 5 — the mapping, against the preselected release.
  const winner = ranking.preselected;
  const release = winner === null ? null : (detailedById.get(winner.id) ?? null);
  const proposal =
    release === null ? null : mappingEngine.assign(input.videos, flattenTracks(release), config);

  return {
    kind: "album",
    ranking,
    groups: grouped,
    mapping: proposal,
    release,
    budget: { ...mb.calls },
    planned: { searches: queries.length, lookups: lookupLimit },
    queries,
    fallback,
    artist: artistVerdict(input.hints.artist, ranking.candidates),
    stoppedBecause: explored.stoppedBecause,
  };
}

/* ------------------------------------------------------------------ */
/* the artist gate                                                     */
/* ------------------------------------------------------------------ */

/**
 * Whether anything in the ranking is actually **by** the artist the source names.
 *
 * The first and worst defect of the sixth owner review: a fourteen-video *Bewitched* credited
 * "Laufey, Spencer Stewart" was matched to Laura Fygi's 1993 record — twelve tracks, seven of
 * the fourteen videos placed, score 0.537 — and imported. The card said "Artist mismatch" in
 * so many words. Eleven of three hundred and six matched albums are like it, *Listen* filed
 * under Marc Cary for a David Guetta playlist, *The Heist* under Crockett for Macklemore &
 * Ryan Lewis.
 *
 * A penalty could never have stopped that, and raising it until it could would refuse the
 * ordinary case where MusicBrainz credits a record to a name YouTube spells differently. This
 * is a different kind of statement: **a fact about the whole list**. If the source names an
 * artist and not one candidate carries it, the match has not found this record — it has found
 * records with the same title — and the only correct next step is to ask a person. The `match`
 * step turns a `false` here into an `ambiguous_release` Inbox item and `awaiting_review`, so
 * neither `--yes` nor fixtures mode can confirm past it: those open the `confirm` gate, and
 * the job never reaches it.
 *
 * Deliberately **not** a per-candidate veto. One candidate carrying the artist is enough for
 * the ranking to be believed, and the ranking then sorts it out on the fit like always.
 */
export function artistVerdict(
  credit: string | null | undefined,
  candidates: readonly { readonly artist: string }[],
): ArtistVerdict {
  const wanted = (credit ?? "").trim();
  if (wanted === "") return { wanted: null, carried: true, carriedBy: 0 };
  let carriedBy = 0;
  for (const candidate of candidates) {
    if (creditCarriesArtist(wanted, candidate.artist)) carriedBy += 1;
  }
  return { wanted, carried: carriedBy > 0, carriedBy };
}

/* ------------------------------------------------------------------ */
/* single                                                              */
/* ------------------------------------------------------------------ */

export interface SingleMatchInput {
  readonly video: MatchVideo;
}

/**
 * Match a lone video: recording candidates, and for each the release it would be filed under.
 *
 * One search plus one lookup per candidate, capped at N like the album path — a recording
 * search returns the recording and its release *stubs*, but the stubs carry no release group,
 * so the album/single/EP ordering `docs/04` asks for cannot be applied to them without asking.
 * Which is exactly why the cap exists.
 */
export async function matchSingle(
  mb: MbGateway,
  input: SingleMatchInput,
  settings: Settings,
): Promise<SingleMatch> {
  const config = configFromSettings(settings);
  const lookupLimit = recordingLookupLimitOf(settings);
  const video = input.video;

  const artist = video.ytArtist ?? video.uploader ?? null;
  /*
   * The video title without its "Artist - " prefix (DRIVE-1 §B1).
   *
   * An official artist channel has no YouTube Music `track` tag, so the query title is the
   * video's own — literally `Radiohead - Creep`. Sent as a Lucene phrase that finds a cover
   * *named* "Radiohead - Creep" and never the original, which is what the first real single
   * import proposed. The artist is a separate clause; repeating it inside the title clause
   * only narrows the search to the recordings that misspell themselves.
   */
  const title = stripArtistPrefix(video.ytTrack ?? video.title, artist);

  /*
   * Two searches, narrow then wide, merged.
   *
   * The narrow one — title, artist and a ±5 s duration window — is the one that finds the
   * right recording. The wide one is title alone, and it exists to surface the *wrong* ones:
   * a video tagged "Birdy" will never make MusicBrainz volunteer Bon Iver's original, yet
   * "Skinny Love" by someone else is exactly the mistake a matcher has to be seen rejecting.
   * A ranking that only ever contains plausible answers cannot demonstrate that it discards
   * implausible ones, and the user reading the list learns nothing from it.
   */
  const narrow = lucene.recordingQuery({
    title,
    artist,
    durationSeconds: video.durationSeconds,
  });
  const wide = lucene.recordingQuery({ title });

  const found = await mb.search("recording", narrow, settings.matchSearchLimit);
  const alternatives = await mb.search("recording", wide, settings.matchSearchLimit);

  const seen = new Set<string>();
  const raw: MbRecording[] = [];
  for (const recording of [...(found?.recordings ?? []), ...(alternatives?.recordings ?? [])]) {
    if (recording.id === undefined || seen.has(recording.id)) continue;
    seen.add(recording.id);
    raw.push(recording);
  }

  const candidates: RecordingCandidateInput[] = [];

  for (const [index, recording] of raw.entries()) {
    if (recording.id === undefined) continue;
    const credited = recording["artist-credit"] ?? [];
    const artistName = credited
      .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
      .join("")
      .trim();

    // The release groups only come with a lookup, and only the first few get one.
    let releases = (recording as { releases?: readonly MbRelease[] }).releases ?? [];
    if (index < lookupLimit) {
      const full = await mb.lookupRecording(recording.id);
      const fullReleases = (full as { releases?: readonly MbRelease[] } | null)?.releases;
      if (fullReleases !== undefined) releases = fullReleases;
    }

    candidates.push({
      id: recording.id,
      title: recording.title ?? "",
      artist: artistName,
      disambiguation: recording.disambiguation ?? "",
      lengthMs: recording.length ?? null,
      isrcs: recording.isrcs ?? [],
      searchScore: (recording as { score?: number }).score ?? null,
      releases,
    });
  }

  const ranking = recordingCandidates.score({ video, candidates }, config);
  return {
    kind: "single",
    ranking,
    budget: { ...mb.calls },
    planned: { searches: 2, lookups: lookupLimit },
    queries: [narrow, wide],
    /*
     * The same gate as the album path, and this is the one place a title-only query survives.
     *
     * The wide recording search deliberately drops the artist — it exists to *surface* the
     * same-titled recordings by other people so the ranking can be seen rejecting them — and
     * that is safe exactly as long as nothing it brings back can be confirmed on its own. If
     * the whole list turns out to be other people's, that is not a ranking problem, it is a
     * question for a person.
     */
    artist: artistVerdict(
      video.ytArtist ?? video.uploader,
      ranking.candidates satisfies readonly RecordingCandidate[],
    ),
  };
}
