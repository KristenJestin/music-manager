/**
 * The matching service: turn a resolved import into scored MusicBrainz candidates
 * (`docs/04-pipeline-et-matching.md` § Algorithme de présélection).
 *
 * The pure engine lives in `@mm/domain/matching` and knows nothing about the network. This
 * module is the half that does: it decides **which** MusicBrainz documents are worth fetching,
 * in what order, and how many. That decision is the whole cost of a match, so it is bounded
 * and counted rather than left to grow with the size of the answer:
 *
 *  - **one search for the release groups, then one per group kept** (`matchGroupLimit`,
 *    default 3), so `1 + G` — four by default. The old budget was a flat two, and the second
 *    of them was scoped to a *single* group: that is the whole of the owner's D3, because
 *    "Bad Ideas" is two release groups, an eleven-track album and a one-track single, and the
 *    version that kept one group never proposed the album at all. A group search that comes
 *    back empty is retried once without the artist clause, and a match with no usable group
 *    falls back to a direct release search — the ceiling is `1 + G` either way.
 *  - **N lookups at most** (default 6, `matchLookupLimit`). The tracklist fit is the signal
 *    that separates two pressings of one album, and it needs the actual tracklist, which the
 *    search results do not carry. So the candidates are pre-scored *without* the fit, the best
 *    N are looked up, and the ranking is recomputed with the fit for those. The **first**
 *    lookup of each kept group is reserved before the rest are handed out by pre-score:
 *    a group cannot be compared on a fit nobody read, and spending all six inside one group
 *    would rebuild, one level up, exactly the tunnel vision this replaced.
 *
 * Both halves of that budget are returned in `budget`, which is what the test asserts on —
 * a promise about request counts that nothing measures is not a promise.
 *
 * Every call goes through P04's `integrations/musicbrainz.ts`, hence through the one-request-
 * per-second limiter and the raw cache. In fixtures mode the context is `offline`, the cache
 * has been seeded from the cassettes, and a request that tried to leave would throw.
 */
import {
  DEFAULT_GROUP_LIMIT,
  DEFAULT_LOOKUP_LIMIT,
  flattenTracks,
  lucene,
  mapping as mappingEngine,
  recordingCandidates,
  releaseCandidates,
  releaseGroups,
  stripArtistPrefix,
  type AlbumHints,
  type DeepPartialConfig,
  type GroupSearchScore,
  type MappingResult,
  type MatchVideo,
  type MbRecording,
  type MbRelease,
  type MbReleaseGroup,
  type RecordingCandidateInput,
  type RecordingRanking,
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

/** How many candidates get a tracklist lookup. */
export function lookupLimitOf(settings: Settings): number {
  return settings.matchLookupLimit > 0 ? settings.matchLookupLimit : DEFAULT_LOOKUP_LIMIT;
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
}

export interface SingleMatch {
  readonly kind: "single";
  readonly ranking: RecordingRanking;
  readonly budget: MatchBudget;
  readonly planned: MatchBudget;
  readonly queries: readonly string[];
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
 * The `release-group` search: every group the album title could name, scored and ordered.
 *
 * Groups are ranked by the engine's own title/artist agreement plus a lean on the primary
 * type, not by MusicBrainz's relevance: MB scores a query, we score a hypothesis, and on a
 * common album title ("Discovery" is also a Mr. Children record; "Bad Ideas" is an album and a
 * single by the same artist) that is the difference between one candidate and the right one.
 *
 * Two searches at most, and the second only when the first found nothing: an artist clause
 * that disagrees with MusicBrainz's credit is the ordinary way for this search to come back
 * empty, and one wider question is cheaper than an empty step 2.
 */
async function searchReleaseGroups(
  mb: MbGateway,
  hints: AlbumHints,
  videoCount: number,
  limit: number,
  queries: string[],
): Promise<GroupSearchScore[]> {
  const album = (hints.album ?? "").trim();
  if (album === "") return [];

  const narrow = lucene.releaseGroupQuery(album, hints.artist ?? null);
  queries.push(narrow);
  const answer = await mb.search("release-group", narrow, limit);
  let found: readonly MbReleaseGroup[] = answer?.["release-groups"] ?? [];

  if (found.length === 0 && (hints.artist ?? "").trim() !== "") {
    const wide = lucene.releaseGroupQueryWide(album);
    queries.push(wide);
    const second = await mb.search("release-group", wide, limit);
    found = second?.["release-groups"] ?? [];
  }

  return releaseGroups.searchScore(found, hints, videoCount);
}

/**
 * Hand out the lookup budget across the groups.
 *
 * One reserved for the best pre-scored release of every group first, then the rest in
 * pre-score order. Reserving is the point: a group whose releases were never looked up has no
 * fit, so it cannot be compared with one that was, and the flat pre-score — which is title,
 * artist and track counts, exactly the signals that made a single look like an album — would
 * happily spend all six lookups inside the wrong group and call the question settled.
 */
function allocateLookups(
  prescored: readonly { id: string; releaseGroupId: string | null }[],
  limit: number,
): string[] {
  const chosen: string[] = [];
  const taken = new Set<string>();
  const seenGroups = new Set<string>();

  for (const candidate of prescored) {
    if (candidate.id === "" || chosen.length >= limit) break;
    const key = candidate.releaseGroupId ?? "";
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    taken.add(candidate.id);
    chosen.push(candidate.id);
  }
  for (const candidate of prescored) {
    if (chosen.length >= limit) break;
    if (candidate.id === "" || taken.has(candidate.id)) continue;
    taken.add(candidate.id);
    chosen.push(candidate.id);
  }
  return chosen;
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

  // 1 — the release groups. A miss is not fatal: the direct release search below still works,
  // it is just less precise.
  const groupScores = await searchReleaseGroups(
    mb,
    input.hints,
    input.videos.length,
    settings.matchSearchLimit,
    queries,
  );
  const kept = groupScores.slice(0, groupLimit);
  hooks.onPlan?.({
    searches: queries.length + (kept.length === 0 ? 1 : kept.length),
    lookups: lookupLimit,
  });

  // 2 — the releases of each kept group. One search each, so no group is judged on a pressing
  // it does not have; a match that found no group asks the old direct question instead.
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
    const direct = lucene.releaseQuery({
      album: input.hints.album ?? "",
      artist: input.hints.artist ?? null,
      year: input.hints.year ?? null,
    });
    queries.push(direct);
    collect(releasesOf(await mb.search("release", direct, settings.matchSearchLimit)));
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

  // 3 — pre-score without the fit, so the lookups go to the candidates that deserve them.
  const shallow: ReleaseCandidateInput[] = searchResults.map((release) => ({
    release,
    detailed: false,
  }));
  const prescored = releaseCandidates.score(
    { videos: input.videos, hints: input.hints, candidates: shallow },
    config,
  );

  const wanted = allocateLookups(prescored.candidates, lookupLimit);
  const detailedById = new Map<string, MbRelease>();
  for (const mbid of wanted) {
    const full = await mb.lookupRelease(mbid);
    if (full !== null) detailedById.set(mbid, full);
  }

  // 4 — rank again, now with a real tracklist for the ones we looked up.
  const candidates: ReleaseCandidateInput[] = searchResults.map((release) => {
    const full = release.id === undefined ? undefined : detailedById.get(release.id);
    return full === undefined ? { release, detailed: false } : { release: full, detailed: true };
  });
  const ranking = releaseCandidates.score(
    { videos: input.videos, hints: input.hints, candidates },
    config,
  );

  // 5 — fold the flat ranking back into the groups the screen shows.
  const index = new Map(groupScores.map((group) => [group.id, group]));
  const grouped = releaseGroups.group(ranking.candidates, index);

  // 6 — the mapping, against the preselected release.
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
  };
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
  const lookupLimit = lookupLimitOf(settings);
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
  };
}
