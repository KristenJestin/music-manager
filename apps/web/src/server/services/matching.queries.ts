/**
 * Read-only matching, for the wizard.
 *
 * The `match` **step** decides and writes: it picks a release, persists a mapping onto the
 * rows and opens Inbox items. The wizard must do neither until you press Start, so it needs
 * the same computation with none of the consequences. That is all this module is — the P05
 * service, called against an import's rows, returning plain data.
 *
 * Additive by construction (`docs/phases/P06-web-coeur.md` scope): nothing here is imported by
 * P03–P05 code, and the step keeps its own copy of the decisions it has to make.
 *
 * Three things the wizard can do that the step cannot, because they are things a *person*
 * does: search MusicBrainz in words, paste an MBID, and ask for the mapping against a release
 * the matcher did not propose. All three go through the same gateway, so they are counted in
 * the same budget and cached in the same place.
 */
import {
  albumHints,
  flattenTracks,
  lucene,
  mapping as mappingEngine,
  recordingCandidates,
  releaseCandidates,
  releaseGroups,
  splitSearchTerms,
  type AlbumHints,
  type MappingResult,
  type MatchTrack,
  type MatchVideo,
  type MbRecording,
  type MbRelease,
  type RecordingCandidate,
  type RecordingCandidateInput,
  type ReleaseCandidate,
  type ReleaseCandidateInput,
  type ReleaseGroupCandidate,
} from "@mm/domain";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, type Import, type ImportTrack } from "#/server/db/schema/index.ts";
import { asc, eq } from "drizzle-orm";
import { toMatchVideo } from "#/server/services/jobs/steps/match.ts";
import {
  cassetteGateway,
  liveGateway,
  withOutage,
  reportingGateway,
  type MbGateway,
} from "#/server/services/matching.gateway.ts";
import { matchReporter, publishProgress } from "#/server/services/match-progress.ts";
import { cassetteNameOf, loadCassette } from "#/server/services/matching.cassettes.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import {
  configFromSettings,
  lookupLimitOf,
  matchAlbum,
  matchSingle,
  plannedBudgetOf,
  type AlbumMatch,
  type SingleMatch,
} from "#/server/services/matching.service.ts";
import type { Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* the gateway                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where a URL's MusicBrainz documents come from.
 *
 * Same rule as the step's own `gatewayFor`, and for the same reason: the choice follows the
 * **URL**, not the global fixtures switch, so a `fixture://` job is offline whatever mode the
 * process is in.
 *
 * `db` is resolved *after* the cassette is looked for, not as a default parameter. A default
 * parameter is evaluated on every call, which would open a database handle — and therefore
 * demand a `DATABASE_URL` — on the one path that is supposed to need neither. That is the
 * difference between "the cassette path is offline" and "the cassette path is offline as long
 * as something else already configured a database".
 */
export async function gatewayForUrl(
  url: string,
  db?: Database,
  signal?: AbortSignal,
  /** No request may leave the process: answer from `source_cache` or fail. */
  offline = false,
): Promise<MbGateway> {
  const name = cassetteNameOf(url);
  const cassette = name === null ? null : loadCassette(name);
  if (cassette !== null) return withOutage(cassetteGateway(cassette), url);
  return liveGateway(await sourceContextFor(db ?? defaultDb(), signal, offline));
}

/** The videos of an import, in source order, as the matcher wants them. */
export async function videosOf(
  importId: string,
  db: Database = defaultDb(),
): Promise<{ rows: ImportTrack[]; videos: MatchVideo[] }> {
  const rows = await db
    .select()
    .from(importTracks)
    .where(eq(importTracks.importId, importId))
    .orderBy(asc(importTracks.position));
  return { rows, videos: rows.map(toMatchVideo) };
}

/** What the source believes the album is — YouTube tags plus the parsed description. */
export function hintsFor(job: Import, videos: readonly MatchVideo[]): AlbumHints {
  return albumHints(videos, { album: job.title, artist: job.artist, year: job.year });
}

/* ------------------------------------------------------------------ */
/* the ranking                                                         */
/* ------------------------------------------------------------------ */

export interface RankingInput {
  readonly job: Import;
  readonly settings: Settings;
  readonly db?: Database;
  readonly signal?: AbortSignal;
  /**
   * Rank from the raw cache alone, making no request.
   *
   * The wizard's fallback when MusicBrainz refuses (decision 165): a second ranking, offline,
   * which succeeds exactly when this import has been looked at before. It is never the first
   * attempt — a stale answer is worth having, not worth preferring.
   */
  readonly offline?: boolean;
}

/** The candidates for an import, computed and thrown away. Nothing is written. */
export async function rankFor(input: RankingInput): Promise<AlbumMatch | SingleMatch> {
  const db = input.db ?? defaultDb();
  const { rows, videos } = await videosOf(input.job.id, db);
  if (rows.length === 0) {
    throw new MMError("INVALID_INPUT", "This import has no videos yet.", {
      hint: "Resolve the source first.",
      action: "Back to step 1",
    });
  }
  const plain = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const single = input.job.kind === "single" || rows.length === 1;

  /*
   * The wait is the feature here (A5 of the owner review).
   *
   * A group search, up to `matchGroupLimit` release searches and up to `matchLookupLimit`
   * lookups, at one request per second, is ten seconds that cannot be made shorter — so the
   * screen is told what is being spent rather than left blank. The planned counts are the
   * budget `matchAlbum` promises (`plannedBudgetOf`), taken from the settings rather than
   * discovered as we go, and narrowed once the group search says how many groups there really
   * were (decision 151).
   */
  const planned = single
    ? { searches: 2, lookups: lookupLimitOf(input.settings) }
    : plannedBudgetOf(input.settings);
  const report = matchReporter(input.job.id, planned);
  report("starting", "Asking MusicBrainz about this release…", { searches: 0, lookups: 0 });
  const gateway = reportingGateway(plain, report);

  try {
    if (single) {
      const video = videos[0];
      if (video === undefined) throw new MMError("INVALID_INPUT", "This import has no videos yet.");
      return await matchSingle(gateway, { video }, input.settings);
    }
    return await matchAlbum(
      gateway,
      { videos, hints: hintsFor(input.job, videos) },
      input.settings,
      {
        onPlan: (revised) => {
          report.revise(revised);
        },
      },
    );
  } finally {
    // Always: a subscriber must not be left watching a match that failed half-way.
    publishProgress({
      importId: input.job.id,
      phase: "done",
      label: "Scoring the candidates…",
      searches: gateway.calls.searches,
      searchesPlanned: report.plan.searches,
      lookups: gateway.calls.lookups,
      lookupsPlanned: report.plan.lookups,
    });
  }
}

/* ------------------------------------------------------------------ */
/* the two manual paths                                                */
/* ------------------------------------------------------------------ */

const MBID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pull an MBID out of whatever was pasted — a bare id or a musicbrainz.org URL. */
export function parseMbid(input: string): string | null {
  const found = MBID.exec(input.trim());
  return found === null ? null : found[0].toLowerCase();
}

/**
 * How many release groups a hand search resolves down to their releases.
 *
 * Three, because each one costs a second search through the one-per-second gate and the list
 * this feeds is something a person is looking at. `DEFAULT_GROUP_LIMIT` is the matcher's own
 * budget for the same step and is larger; the matcher is not being waited for.
 */
const MANUAL_GROUPS = 3;

export interface SearchInput extends RankingInput {
  /**
   * The title, or — when `artist` is absent — the whole typed string.
   *
   * It used to be the whole typed string *always*, and it went into one field:
   * `releaseQuery({ album: query })`. So `bewitched Laufey` asked MusicBrainz for a release
   * literally titled "bewitched Laufey" and came back empty over a record it obviously has.
   */
  readonly query: string;
  /**
   * The artist, when the caller has one — the wizard's second field, or the split of a
   * `Artist - Title` string. `undefined` means "not stated", which is not the same as "any":
   * the caller that has neither gets `splitSearchTerms` applied to `query` below.
   */
  readonly artist?: string | null;
}

/** What was actually asked of MusicBrainz, so an empty answer can read it back. */
export interface SearchTermsUsed {
  readonly title: string;
  readonly artist: string | null;
  /** True when the artist was guessed out of one string rather than typed into its own field. */
  readonly guessed: boolean;
}

/**
 * The title and the artist this search will use.
 *
 * A stated artist is taken as stated. Only a caller that gave none falls back to splitting the
 * string on the separators people write — and the split travels back to the page, because a
 * guess nobody can see is a guess nobody can correct.
 */
function termsOf(input: SearchInput): SearchTermsUsed {
  const stated = input.artist?.trim() ?? "";
  if (stated !== "") return { title: input.query.trim(), artist: stated, guessed: false };
  const split = splitSearchTerms(input.query);
  return { title: split.title, artist: split.artist, guessed: split.guessed };
}

/**
 * Search MusicBrainz in words and score what comes back against *this* import.
 *
 * The scoring is the point. A plain MusicBrainz search orders by its own relevance, which
 * knows nothing about the fourteen durations sitting in front of you; running the results
 * through the same engine means the number next to a hand-found release means the same thing
 * as the number next to a proposed one.
 *
 * **Two searches, not one.** The list this feeds is made of release *groups* — the banner above
 * it says so, and the ranked list is built that way — while this searched releases, so a
 * well-formed query could still return things that did not belong in the list. It now asks for
 * the group first, exactly as `matchAlbum` does, and falls back to the release search when the
 * group search finds nothing. That is the same two-level resolution a proposed candidate goes
 * through, which is what stops the manual path being a second, weaker matcher.
 */
export async function searchReleases(input: SearchInput): Promise<{
  candidates: readonly ReleaseCandidate[];
  groups: readonly ReleaseGroupCandidate[];
  query: string;
  terms: SearchTermsUsed;
}> {
  const db = input.db ?? defaultDb();
  const { videos } = await videosOf(input.job.id, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const terms = termsOf(input);

  /*
   * The group search first. `releaseGroupQuery` already takes an artist and has since P05;
   * what was missing was a caller that had one to give.
   */
  const groupQuery = lucene.releaseGroupQuery(terms.title, terms.artist);
  const groupFound = await gateway.search("release-group", groupQuery, MANUAL_GROUPS);
  const groupIds = (groupFound?.["release-groups"] ?? [])
    .slice(0, MANUAL_GROUPS)
    .map((group) => group.id)
    .filter((id): id is string => typeof id === "string" && id !== "");

  const releases: MbRelease[] = [];
  const queries: string[] = [groupQuery];
  for (const rgid of groupIds) {
    const byGroup = lucene.releaseQuery({ album: terms.title, releaseGroupId: rgid });
    queries.push(byGroup);
    const inGroup = await gateway.search("release", byGroup, input.settings.matchSearchLimit);
    releases.push(...(inGroup?.releases ?? []));
  }

  /*
   * The release search stays as the fallback, not as the first question. A record whose group
   * MusicBrainz files under another name — the case `releaseGroupQueryWide` exists for in the
   * matcher — still has to be findable by hand.
   */
  if (releases.length === 0) {
    const direct = lucene.releaseQuery({ album: terms.title, artist: terms.artist });
    queries.push(direct);
    const found = await gateway.search("release", direct, input.settings.matchSearchLimit);
    releases.push(...(found?.releases ?? []));
  }

  const query = queries[queries.length - 1] ?? groupQuery;

  const limit = lookupLimitOf(input.settings);
  const config = configFromSettings(input.settings);
  const hints = hintsFor(input.job, videos);

  const shallow: ReleaseCandidateInput[] = releases.map((release) => ({
    release,
    detailed: false,
  }));
  const prescored = releaseCandidates.score({ videos, hints, candidates: shallow }, config);
  const wanted = new Set(prescored.candidates.slice(0, limit).map((candidate) => candidate.id));

  const detailed: ReleaseCandidateInput[] = [];
  for (const release of releases) {
    if (release.id !== undefined && wanted.has(release.id)) {
      const full = await gateway.lookupRelease(release.id);
      detailed.push(
        full === null ? { release, detailed: false } : { release: full, detailed: true },
      );
    } else {
      detailed.push({ release, detailed: false });
    }
  }
  const scored = releaseCandidates.score({ videos, hints, candidates: detailed }, config);
  return {
    candidates: scored.candidates,
    // Grouped too, because step 2 draws groups: a hand-found release has to be able to land in
    // the same shape as a proposed one, or the search box would produce cards of a second kind.
    groups: releaseGroups.group(scored.candidates).groups,
    query,
    terms,
  };
}

export interface PinnedInput extends RankingInput {
  readonly releaseMbid: string;
}

/**
 * One release, looked up by MBID and scored on its own.
 *
 * `docs/04` calls this the escape hatch, and it is the one path that must work when the
 * matcher is simply wrong: you know the answer, you paste it, and the mapping is computed
 * against it rather than against what the search happened to return.
 */
export async function pinnedRelease(input: PinnedInput): Promise<{
  candidate: ReleaseCandidate;
  release: MbRelease;
}> {
  const db = input.db ?? defaultDb();
  const { videos } = await videosOf(input.job.id, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const release = await gateway.lookupRelease(input.releaseMbid);
  if (release === null) {
    throw new MMError("NOT_FOUND", `No MusicBrainz release with id ${input.releaseMbid}.`, {
      hint: "Check the MBID on musicbrainz.org.",
      action: "Check the MBID",
      status: 404,
    });
  }
  const ranking = releaseCandidates.score(
    {
      videos,
      hints: hintsFor(input.job, videos),
      candidates: [{ release, detailed: true }],
    },
    configFromSettings(input.settings),
  );
  const candidate = ranking.candidates[0];
  if (candidate === undefined) {
    throw new MMError("NOT_FOUND", `Release ${input.releaseMbid} could not be scored.`);
  }
  return { candidate, release };
}

/* ------------------------------------------------------------------ */
/* the same two manual paths, for a lone video                         */
/* ------------------------------------------------------------------ */

/**
 * The video a single import is about.
 *
 * A `single` import has exactly one row; a playlist that resolved to one entry is a single as
 * far as the matcher is concerned (`matchStep` says so too). Anything else is a programming
 * error rather than a user one, which is why it is an `INVALID_INPUT` and not a 404.
 */
async function loneVideo(job: Import, db: Database): Promise<MatchVideo> {
  const { videos } = await videosOf(job.id, db);
  const video = videos[0];
  if (video === undefined) {
    throw new MMError("INVALID_INPUT", "This import has no videos yet.", {
      hint: "Resolve the source first.",
      action: "Back to step 1",
    });
  }
  return video;
}

/** One MusicBrainz recording document, as the scorer wants it. */
function toRecordingInput(recording: MbRecording): RecordingCandidateInput {
  const credited = recording["artist-credit"] ?? [];
  return {
    id: recording.id ?? "",
    title: recording.title ?? "",
    artist: credited
      .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
      .join("")
      .trim(),
    disambiguation: recording.disambiguation ?? "",
    lengthMs: recording.length ?? null,
    isrcs: recording.isrcs ?? [],
    searchScore: (recording as { score?: number }).score ?? null,
    releases: (recording as { releases?: readonly MbRelease[] }).releases ?? [],
  };
}

export interface PinnedRecordingInput extends RankingInput {
  readonly recordingMbid: string;
}

/**
 * One recording, looked up by MBID and scored against this import's video.
 *
 * Steps 3 and 4 of the single path go through here rather than through the step-2 ranking,
 * for the same reason the album path re-fetches its release: the recording you are importing
 * may have come from the search box or from a pasted MBID, and neither of those survives a
 * reload. Looking it up means the last two steps are a function of the URL, like every other
 * screen in the wizard.
 */
export async function pinnedRecording(
  input: PinnedRecordingInput,
): Promise<{ candidate: RecordingCandidate }> {
  const db = input.db ?? defaultDb();
  const video = await loneVideo(input.job, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const recording = await gateway.lookupRecording(input.recordingMbid);
  if (recording === null) {
    throw new MMError("NOT_FOUND", `No MusicBrainz recording with id ${input.recordingMbid}.`, {
      hint: "Check the MBID on musicbrainz.org.",
      action: "Back to step 2",
      status: 404,
    });
  }
  const ranking = recordingCandidates.score(
    { video, candidates: [toRecordingInput(recording)] },
    configFromSettings(input.settings),
  );
  const candidate = ranking.candidates[0];
  if (candidate === undefined) {
    throw new MMError("NOT_FOUND", `Recording ${input.recordingMbid} could not be scored.`);
  }
  return { candidate };
}

/**
 * Search MusicBrainz for recordings and score them against *this* video.
 *
 * The album path has had this since P06; the single path shipped the same search box wired to
 * a release search, so typing in it returned releases that step 2 then declined to render
 * (DRIVE-1 §B2). One entity per import kind, one scorer, same numbers.
 */
export async function searchRecordings(
  input: SearchInput,
): Promise<{ candidates: readonly RecordingCandidate[]; query: string; terms: SearchTermsUsed }> {
  const db = input.db ?? defaultDb();
  const video = await loneVideo(input.job, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const terms = termsOf(input);
  // Same defect as the album side, one field along: the whole typed string went into
  // `recording:` and an artist folded into a title finds nothing.
  const query = lucene.recordingQuery({ title: terms.title, artist: terms.artist });
  const found = await gateway.search("recording", query, input.settings.matchSearchLimit);
  const recordings = found?.recordings ?? [];

  const limit = lookupLimitOf(input.settings);
  const candidates: RecordingCandidateInput[] = [];
  for (const [index, recording] of recordings.entries()) {
    const base = toRecordingInput(recording);
    // The release groups only come with a lookup, and the borrow ladder cannot be applied
    // without them — same cap, and for the same reason, as `matchSingle`.
    if (index < limit && recording.id !== undefined) {
      const full = await gateway.lookupRecording(recording.id);
      const fullReleases = (full as { releases?: readonly MbRelease[] } | null)?.releases;
      if (fullReleases !== undefined) candidates.push({ ...base, releases: fullReleases });
      else candidates.push(base);
    } else {
      candidates.push(base);
    }
  }

  return {
    candidates: recordingCandidates.score({ video, candidates }, configFromSettings(input.settings))
      .candidates,
    query,
    terms,
  };
}

/* ------------------------------------------------------------------ */
/* the mapping                                                         */
/* ------------------------------------------------------------------ */

export interface MappingInput extends RankingInput {
  readonly releaseMbid: string;
}

export interface MappingView {
  readonly releaseMbid: string;
  readonly releaseTitle: string;
  readonly releaseArtist: string;
  readonly releaseYear: number | null;
  readonly releaseGroupMbid: string | null;
  /** Every track of the release, flattened across media — the per-line selector's options. */
  readonly tracks: readonly MatchTrack[];
  readonly proposal: MappingResult;
}

/**
 * The 1:1 proposal against one release, plus that release's tracklist.
 *
 * Both halves are needed by step 3 and neither is derivable from the other: the proposal says
 * what the engine would bind, the tracklist is what the per-line selector offers when you
 * disagree with it.
 */
export async function mappingFor(input: MappingInput): Promise<MappingView> {
  const db = input.db ?? defaultDb();
  const { videos } = await videosOf(input.job.id, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal, input.offline ?? false);
  const release = await gateway.lookupRelease(input.releaseMbid);
  if (release === null) {
    throw new MMError("NOT_FOUND", `No MusicBrainz release with id ${input.releaseMbid}.`, {
      hint: "Pick another candidate, or paste a different MBID.",
      action: "Back to step 2",
      status: 404,
    });
  }
  const tracks = flattenTracks(release);
  const proposal = mappingEngine.assign(videos, tracks, configFromSettings(input.settings));
  const credited = release["artist-credit"] ?? [];
  const artist = credited
    .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
    .join("")
    .trim();
  const year = Number.parseInt((release.date ?? "").slice(0, 4), 10);

  return {
    releaseMbid: input.releaseMbid,
    releaseTitle: release.title ?? "",
    releaseArtist: artist,
    releaseYear: Number.isNaN(year) ? null : year,
    releaseGroupMbid: release["release-group"]?.id ?? null,
    tracks,
    proposal,
  };
}
