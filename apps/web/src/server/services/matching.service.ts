/**
 * The matching service: turn a resolved import into scored MusicBrainz candidates
 * (`docs/04-pipeline-et-matching.md` § Algorithme de présélection).
 *
 * The pure engine lives in `@mm/domain/matching` and knows nothing about the network. This
 * module is the half that does: it decides **which** MusicBrainz documents are worth fetching,
 * in what order, and how many. That decision is the whole cost of a match, so it is bounded
 * and counted rather than left to grow with the size of the answer:
 *
 *  - **two searches at most.** One for the release *group* (the album as a work), one for the
 *    releases of that group. When the group search finds nothing usable the second search is
 *    a direct release search instead — still two, never three.
 *  - **N lookups at most** (default 6, `matchLookupLimit`). The tracklist fit is the signal
 *    that separates two pressings of one album, and it needs the actual tracklist, which the
 *    search results do not carry. So the candidates are pre-scored *without* the fit, the best
 *    N are looked up, and the ranking is recomputed with the fit for those.
 *
 * Both halves of that budget are returned in `budget`, which is what the test asserts on —
 * a promise about request counts that nothing measures is not a promise.
 *
 * Every call goes through P04's `integrations/musicbrainz.ts`, hence through the one-request-
 * per-second limiter and the raw cache. In fixtures mode the context is `offline`, the cache
 * has been seeded from the cassettes, and a request that tried to leave would throw.
 */
import {
  artistScore,
  DEFAULT_LOOKUP_LIMIT,
  flattenTracks,
  lucene,
  mapping as mappingEngine,
  recordingCandidates,
  releaseCandidates,
  titleScore,
  type AlbumHints,
  type DeepPartialConfig,
  type MappingResult,
  type MatchVideo,
  type MbRecording,
  type MbRelease,
  type RecordingCandidateInput,
  type RecordingRanking,
  type ReleaseCandidateInput,
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
  /** The proposed 1:1 mapping against the preselected release. */
  readonly mapping: MappingResult | null;
  /** The preselected release, fully looked up. */
  readonly release: MbRelease | null;
  readonly budget: MatchBudget;
  readonly queries: readonly string[];
}

export interface SingleMatch {
  readonly kind: "single";
  readonly ranking: RecordingRanking;
  readonly budget: MatchBudget;
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
 * The `release-group` search, and the group we believe the playlist belongs to.
 *
 * Groups are ranked by the same title/artist agreement the engine uses, not by MusicBrainz's
 * own relevance: MB scores a query, we score a hypothesis, and on a common album title
 * ("Discovery" is also a Mr. Children record) the artist is what decides.
 */
async function bestReleaseGroup(
  mb: MbGateway,
  hints: AlbumHints,
  limit: number,
): Promise<{ id: string; title: string; score: number } | null> {
  const album = hints.album ?? "";
  if (album.trim() === "") return null;
  const query = lucene.releaseGroupQuery(album, hints.artist ?? null);
  const answer = await mb.search("release-group", query, limit);
  const groups = answer?.["release-groups"] ?? [];

  let best: { id: string; title: string; score: number } | null = null;
  for (const group of groups) {
    if (group.id === undefined) continue;
    const credited = (group as { "artist-credit"?: readonly { name?: string }[] })["artist-credit"];
    const artistName = (credited ?? []).map((entry) => entry.name ?? "").join(" ");
    const titleAgreement = titleScore(album, group.title ?? "");
    const artistAgreement =
      hints.artist == null || hints.artist.trim() === ""
        ? 0.5
        : artistScore([hints.artist], artistName);
    const score = titleAgreement * 0.5 + artistAgreement * 0.5;
    if (best === null || score > best.score) {
      best = { id: group.id, title: group.title ?? "", score };
    }
  }
  return best;
}

/**
 * Match an album: candidates, then the tracklist fit for the best few, then the mapping.
 *
 * Nothing here decides anything. It returns a ranking with a preselection and the reasons for
 * it; `confirm` is still the only thing that commits.
 */
export async function matchAlbum(
  mb: MbGateway,
  input: AlbumMatchInput,
  settings: Settings,
): Promise<AlbumMatch> {
  const config = configFromSettings(settings);
  const lookupLimit = lookupLimitOf(settings);
  const queries: string[] = [];

  // 1 — the release group. A miss is not fatal: the direct release search below still works,
  // it is just less precise.
  const group = await bestReleaseGroup(mb, input.hints, settings.matchSearchLimit);
  queries.push(lucene.releaseGroupQuery(input.hints.album ?? "", input.hints.artist ?? null));

  // 2 — the releases. Of the group when we found one we believe in, by title otherwise.
  const useGroup = group !== null && group.score >= settings.titleMatchThreshold * 0.8;
  const releaseSearchQuery = useGroup
    ? lucene.releaseQuery({ album: input.hints.album ?? "", releaseGroupId: group.id })
    : lucene.releaseQuery({
        album: input.hints.album ?? "",
        artist: input.hints.artist ?? null,
        year: input.hints.year ?? null,
      });
  queries.push(releaseSearchQuery);
  const found = await mb.search("release", releaseSearchQuery, settings.matchSearchLimit);

  const searchResults = releasesOf(found);

  // 3 — pre-score without the fit, so the lookups go to the candidates that deserve them.
  const shallow: ReleaseCandidateInput[] = searchResults.map((release) => ({
    release,
    detailed: false,
  }));
  const prescored = releaseCandidates.score(
    { videos: input.videos, hints: input.hints, candidates: shallow },
    config,
  );

  const wanted = prescored.candidates.slice(0, lookupLimit).map((candidate) => candidate.id);
  const detailedById = new Map<string, MbRelease>();
  for (const mbid of wanted) {
    if (mbid === "") continue;
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

  // 5 — the mapping, against the preselected release.
  const winner = ranking.preselected;
  const release = winner === null ? null : (detailedById.get(winner.id) ?? null);
  const proposal =
    release === null ? null : mappingEngine.assign(input.videos, flattenTracks(release), config);

  return {
    kind: "album",
    ranking,
    mapping: proposal,
    release,
    budget: { ...mb.calls },
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

  const title = video.ytTrack ?? video.title;
  const artist = video.ytArtist ?? video.uploader ?? null;

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
  return { kind: "single", ranking, budget: { ...mb.calls }, queries: [narrow, wide] };
}
