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
  releaseCandidates,
  type AlbumHints,
  type MappingResult,
  type MatchTrack,
  type MatchVideo,
  type MbRelease,
  type ReleaseCandidate,
  type ReleaseCandidateInput,
} from "@mm/domain";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, type Import, type ImportTrack } from "#/server/db/schema/index.ts";
import { asc, eq } from "drizzle-orm";
import { toMatchVideo } from "#/server/services/jobs/steps/match.ts";
import {
  cassetteGateway,
  liveGateway,
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
): Promise<MbGateway> {
  const name = cassetteNameOf(url);
  const cassette = name === null ? null : loadCassette(name);
  if (cassette !== null) return cassetteGateway(cassette);
  return liveGateway(await sourceContextFor(db ?? defaultDb(), signal));
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
  const plain = await gatewayForUrl(input.job.url, db, input.signal);
  const single = input.job.kind === "single" || rows.length === 1;

  /*
   * The wait is the feature here (A5 of the owner review).
   *
   * Two searches and up to `matchLookupLimit` lookups at one request per second is eight to
   * ten seconds that cannot be made shorter, so the screen is told what is being spent rather
   * than left blank. The planned counts are the same budget `matchAlbum` promises, taken from
   * the settings rather than discovered as we go.
   */
  const report = matchReporter(input.job.id, {
    searches: 2,
    lookups: lookupLimitOf(input.settings),
  });
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
    );
  } finally {
    // Always: a subscriber must not be left watching a match that failed half-way.
    publishProgress({
      importId: input.job.id,
      phase: "done",
      label: "Scoring the candidates…",
      searches: gateway.calls.searches,
      searchesPlanned: 2,
      lookups: gateway.calls.lookups,
      lookupsPlanned: lookupLimitOf(input.settings),
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

export interface SearchInput extends RankingInput {
  /** Free text, as typed. Escaped into a Lucene query before it leaves. */
  readonly query: string;
}

/**
 * Search MusicBrainz in words and score what comes back against *this* import.
 *
 * The scoring is the point. A plain MusicBrainz search orders by its own relevance, which
 * knows nothing about the fourteen durations sitting in front of you; running the results
 * through the same engine means the number next to a hand-found release means the same thing
 * as the number next to a proposed one.
 */
export async function searchReleases(
  input: SearchInput,
): Promise<{ candidates: readonly ReleaseCandidate[]; query: string }> {
  const db = input.db ?? defaultDb();
  const { videos } = await videosOf(input.job.id, db);
  const gateway = await gatewayForUrl(input.job.url, db, input.signal);
  const query = lucene.releaseQuery({ album: input.query.trim() });
  const found = await gateway.search("release", query, input.settings.matchSearchLimit);
  const releases = found?.releases ?? [];

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
  return {
    candidates: releaseCandidates.score({ videos, hints, candidates: detailed }, config).candidates,
    query,
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
  const gateway = await gatewayForUrl(input.job.url, db, input.signal);
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
  const gateway = await gatewayForUrl(input.job.url, db, input.signal);
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
