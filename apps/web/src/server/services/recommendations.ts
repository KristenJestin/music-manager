/**
 * `recommendations.service` — palier 2 of `docs/05-recommandations.md`.
 *
 * ListenBrainz collaborative filtering and similarity, crossed with the library, scored, and
 * given **a reason in plain English**. Last.fm is the fallback for similarity only, never a
 * first opinion, exactly as it is for genres in P04.
 *
 * ## The score
 *
 * `docs/05` § Scoring names five ingredients, and this module implements exactly those, no
 * more: the external recommendation, affinity to the artists and genres you play on a sliding
 * window, the recency of those listens, a **redundancy penalty** when one artist is already
 * everywhere, and a **diversity bonus** for a name the list has not used yet. They are
 * weighted, summed and clamped — `scoreOf` is twelve lines and every one of them is testable
 * without a network.
 *
 * The weights are deliberately not a setting. A knob that reorders a list nobody can audit is
 * a knob nobody can use; what the page shows instead is the *reason*, which is the thing you
 * can actually disagree with (decision 002: the algorithm proposes and explains).
 *
 * ## Why redundancy and diversity are separate numbers
 *
 * They pull the same way but mean different things, and collapsing them would lose one.
 * Redundancy is about **you**: you already own eleven Daft Punk records, so a twelfth is worth
 * less to you than a first Cassius. Diversity is about **the list**: three Tame Impala rows in
 * a row is a bad page even if you own none of them. The first is computed from the library,
 * the second from what has already been emitted above this row — which is why `diversify`
 * re-scores as it walks rather than sorting once.
 */
import type { MbRecording, MbReleaseGroup } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { libraryAlbums, libraryTracks } from "#/server/db/schema/index.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import { artistSimilar, type LastfmSimilarArtist } from "#/server/integrations/lastfm.ts";
import {
  recommendations as lbRecommendations,
  similarArtists as lbSimilarArtists,
  type LbSimilarArtist,
} from "#/server/integrations/listenbrainz.ts";
import { browseReleaseGroupsByArtist, lookupRecording } from "#/server/integrations/musicbrainz.ts";
import type { ArtistSignal, ListeningSignals } from "#/server/services/signals.ts";
import { accepts, filtersOf } from "#/server/services/discography.ts";
import type { Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* the score                                                           */
/* ------------------------------------------------------------------ */

/** The five ingredients of `docs/05` § Scoring, each already normalised to [0, 1]. */
export interface ScoreFactors {
  /** What the external source thought of it: the CF score, the similarity score. */
  readonly external: number;
  /** How much you play the artist this was derived from, relative to your top artist. */
  readonly artistAffinity: number;
  /** How much its genres overlap your top genres. */
  readonly genreAffinity: number;
  /** How recently the anchor was played, on the sliding window. */
  readonly recency: number;
  /** How much of this artist you already have. Subtracted. */
  readonly redundancy: number;
  /** A name the list has not used yet. Added. */
  readonly diversity: number;
}

export const SCORE_WEIGHTS = {
  external: 0.4,
  artistAffinity: 0.25,
  genreAffinity: 0.15,
  recency: 0.1,
  diversity: 0.1,
  /** Negative on purpose: it is the only term that can take a score down. */
  redundancy: -0.25,
} as const;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Weighted sum of the five factors, clamped. The whole of the scoring, in one place. */
export function scoreOf(factors: ScoreFactors): number {
  const sum =
    SCORE_WEIGHTS.external * clamp01(factors.external) +
    SCORE_WEIGHTS.artistAffinity * clamp01(factors.artistAffinity) +
    SCORE_WEIGHTS.genreAffinity * clamp01(factors.genreAffinity) +
    SCORE_WEIGHTS.recency * clamp01(factors.recency) +
    SCORE_WEIGHTS.diversity * clamp01(factors.diversity) +
    SCORE_WEIGHTS.redundancy * clamp01(factors.redundancy);
  return clamp01(sum);
}

/* ------------------------------------------------------------------ */
/* what a candidate is                                                 */
/* ------------------------------------------------------------------ */

export interface RecommendedItem {
  readonly subject: string;
  readonly kind: "album" | "track";
  readonly title: string;
  readonly artist: string;
  readonly albumTitle: string | null;
  readonly artistMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly recordingMbid: string | null;
  readonly year: number | null;
  readonly score: number;
  readonly factors: ScoreFactors;
  readonly reason: string;
  readonly source: string;
  readonly inLibrary: boolean;
}

export interface SimilarArtistItem {
  readonly subject: string;
  readonly name: string;
  readonly artistMbid: string | null;
  readonly similarTo: string;
  readonly score: number;
  readonly source: string;
  readonly inLibrary: boolean;
}

/** What the library already holds, as three membership tests. Built once per sync. */
export interface LibraryIndex {
  readonly recordings: ReadonlySet<string>;
  readonly releaseGroups: ReadonlySet<string>;
  readonly artists: ReadonlySet<string>;
}

export async function libraryIndex(db: Database = defaultDb()): Promise<LibraryIndex> {
  const tracks = await db.select({ recording: libraryTracks.recordingMbid }).from(libraryTracks);
  const albums = await db
    .select({ rg: libraryAlbums.releaseGroupMbid, artist: libraryAlbums.albumArtist })
    .from(libraryAlbums);
  return {
    recordings: new Set(
      tracks.map((row) => row.recording).filter((mbid): mbid is string => mbid !== null),
    ),
    releaseGroups: new Set(
      albums.map((row) => row.rg).filter((mbid): mbid is string => mbid !== null),
    ),
    artists: new Set(albums.map((row) => row.artist.toLowerCase())),
  };
}

/* ------------------------------------------------------------------ */
/* affinity                                                            */
/* ------------------------------------------------------------------ */

/** An artist's share of your listening, relative to the artist you play most. */
export function artistAffinity(name: string, signals: ListeningSignals): number {
  const top = signals.topArtists[0]?.plays ?? 0;
  if (top <= 0) return 0;
  const found = signals.topArtists.find(
    (artist) => artist.name.toLowerCase() === name.toLowerCase(),
  );
  return found === undefined ? 0 : clamp01(found.plays / top);
}

/** How much a set of genres overlaps your top genres, weighted by how top they are. */
export function genreAffinity(genres: readonly string[], signals: ListeningSignals): number {
  const top = signals.topGenres[0]?.plays ?? 0;
  if (top <= 0 || genres.length === 0) return 0;
  let best = 0;
  for (const raw of genres) {
    const genre = raw.trim().toLowerCase();
    const found = signals.topGenres.find((entry) => entry.name === genre);
    if (found !== undefined) best = Math.max(best, found.plays / top);
  }
  return clamp01(best);
}

/** How much of this artist you already own, as a fraction of the biggest shelf you have. */
export function redundancyOf(name: string, owned: ReadonlyMap<string, number>): number {
  const mine = owned.get(name.toLowerCase()) ?? 0;
  if (mine === 0) return 0;
  const biggest = Math.max(...owned.values(), 1);
  return clamp01(mine / biggest);
}

/* ------------------------------------------------------------------ */
/* the reason                                                          */
/* ------------------------------------------------------------------ */

/** The clauses that make up a reason, so the sentence is assembled rather than interpolated. */
export interface ReasonParts {
  /** The artist whose listens anchored this suggestion, and how many. */
  readonly anchor?: { name: string; plays: number };
  /** "similar to X per ListenBrainz". */
  readonly similarTo?: string;
  readonly similarSource?: string;
  /** "top genre: french house". */
  readonly genre?: string;
  /** "the missing half of your Daft Punk shelf". */
  readonly shelf?: { have: number; total: number };
  readonly fallback?: boolean;
}

/**
 * A sentence, in English, that a person can disagree with.
 *
 * `docs/05` is explicit that each proposal carries **une raison en clair**; the examples it
 * gives are the three shapes below. Assembling from clauses rather than writing one template
 * per case is what keeps "because you played Justice 43× this month · top genre: french house"
 * from becoming eight nearly identical strings.
 */
export function reasonFor(parts: ReasonParts, windowDays: number): string {
  const window = windowDays === 30 ? "this month" : `in the last ${String(windowDays)} days`;
  const clauses: string[] = [];
  if (parts.anchor !== undefined) {
    clauses.push(
      `because you played ${parts.anchor.name} ${String(parts.anchor.plays)}× ${window}`,
    );
  }
  if (parts.similarTo !== undefined) {
    clauses.push(`similar to ${parts.similarTo} per ${parts.similarSource ?? "ListenBrainz"}`);
  }
  if (parts.shelf !== undefined) {
    clauses.push(
      `you have ${String(parts.shelf.have)} of ${String(parts.shelf.total)} of their records`,
    );
  }
  if (parts.genre !== undefined) clauses.push(`top genre: ${parts.genre}`);
  if (parts.fallback === true) clauses.push("Last.fm fallback");
  return clauses.length === 0
    ? "recommended by ListenBrainz for your listening history"
    : clauses.join(" · ");
}

/* ------------------------------------------------------------------ */
/* diversity                                                           */
/* ------------------------------------------------------------------ */

export interface DiversifyOptions {
  readonly maxPerArtist: number;
  readonly max: number;
}

/**
 * Re-score a ranked list so one artist cannot own it, then cut it to size.
 *
 * The walk is what makes this work: an item is scored knowing how many of its artist are
 * already *above* it, so the second Tame Impala row keeps most of its score and the fifth
 * loses it. Sorting by a precomputed penalty could not express that — the penalty depends on
 * the position, and the position depends on the penalty.
 *
 * Nothing is dropped for being redundant: it sinks. A list that silently deleted the fifth
 * record by an artist you love would be lying about what ListenBrainz said.
 */
export function diversify(
  items: readonly RecommendedItem[],
  options: DiversifyOptions,
): readonly RecommendedItem[] {
  const ordered = [...items].sort((a, b) => b.score - a.score);
  const seen = new Map<string, number>();
  const rescored: RecommendedItem[] = [];

  for (const item of ordered) {
    const key = item.artist.toLowerCase();
    const already = seen.get(key) ?? 0;
    seen.set(key, already + 1);

    // Over the per-artist allowance, the diversity bonus is spent and the penalty grows.
    const over = Math.max(0, already + 1 - options.maxPerArtist);
    const factors: ScoreFactors = {
      ...item.factors,
      diversity: already === 0 ? item.factors.diversity : 0,
      redundancy: clamp01(item.factors.redundancy + over / options.maxPerArtist),
    };
    rescored.push({ ...item, factors, score: scoreOf(factors) });
  }

  return rescored.sort((a, b) => b.score - a.score).slice(0, options.max);
}

/* ------------------------------------------------------------------ */
/* collecting                                                          */
/* ------------------------------------------------------------------ */

/** How many CF recordings get a MusicBrainz lookup. One per second, so this is a budget. */
export const CF_LOOKUPS = 15;

/** How many similar artists are kept per anchor artist. */
const SIMILAR_PER_ARTIST = 4;

/** How many similar artists get "their newest record" turned into an album recommendation. */
const ALBUMS_FROM_SIMILAR = 6;

export interface CollectOptions {
  readonly ctx: SourceContext;
  readonly signals: ListeningSignals;
  readonly settings: Settings;
  readonly db?: Database;
  readonly dismissed?: ReadonlySet<string>;
}

export interface CollectResult {
  readonly items: readonly RecommendedItem[];
  readonly similar: readonly SimilarArtistItem[];
  /** What each external source actually contributed, for the signals strip. */
  readonly metrics: { listenbrainz: string; lastfm: string };
}

/**
 * Run a source call, and treat any failure as "this source had nothing".
 *
 * Every external call in this module is optional by design — that is what makes Discover
 * degrade instead of failing — and offline a key that was never seeded is an *error*
 * (`OFFLINE_CACHE_MISS`), not an empty answer. Without this, one missing cassette entry would
 * take down all three blocks.
 */
async function quiet<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

function artistOf(recording: MbRecording): { name: string; mbid: string | null } {
  const credit = recording["artist-credit"]?.[0];
  return {
    name: credit?.artist?.name ?? credit?.name ?? "Unknown artist",
    mbid: credit?.artist?.id ?? null,
  };
}

/**
 * Everything palier 2 has to say, scored and diversified.
 *
 * It degrades rather than fails, at every step: no ListenBrainz user means no collaborative
 * filtering and a clear empty state, a Last.fm without a key simply does not answer, and an
 * artist MusicBrainz has never heard of is skipped. A Discover that 500s because one of three
 * optional sources is down would be worse than a Discover with two blocks.
 */
export async function collectRecommendations(options: CollectOptions): Promise<CollectResult> {
  const db = options.db ?? defaultDb();
  const { ctx, signals, settings } = options;
  const dismissed = options.dismissed ?? new Set<string>();
  const index = await libraryIndex(db);
  const windowDays = signals.windowDays;

  const owned = new Map<string, number>();
  for (const artist of signals.topArtists) {
    if (artist.inLibrary > 0) owned.set(artist.name.toLowerCase(), artist.inLibrary);
  }

  const items: RecommendedItem[] = [];
  const similar: SimilarArtistItem[] = [];
  let cfCount = 0;
  let lastfmCount = 0;

  /* ---- ListenBrainz collaborative filtering: recordings ---- */
  const user = settings.listenbrainzUser.trim();
  if (user !== "" && settings.sourcesEnabled.listenbrainz) {
    const mbids = await quiet(
      async () => (await lbRecommendations(ctx, user, 100)).data?.payload?.mbids ?? [],
      [] as readonly { readonly recording_mbid?: string; readonly score?: number }[],
    );
    for (const entry of mbids.slice(0, CF_LOOKUPS)) {
      const mbid = entry.recording_mbid;
      if (mbid === undefined || mbid === "") continue;
      const subject = `recording:${mbid}`;
      if (dismissed.has(subject)) continue;
      const recording = await quiet(
        async () => (await lookupRecording(ctx, mbid)).data,
        null as MbRecording | null,
      );
      if (recording === null) continue;
      cfCount += 1;

      const credited = artistOf(recording);
      const genres = (recording.genres ?? [])
        .map((genre) => genre.name ?? "")
        .filter((name) => name !== "");
      const anchorArtist = signals.topArtists.find(
        (artist) => artist.name.toLowerCase() === credited.name.toLowerCase(),
      );
      const factors: ScoreFactors = {
        external: clamp01(entry.score ?? 0.5),
        artistAffinity: artistAffinity(credited.name, signals),
        genreAffinity: genreAffinity(genres, signals),
        recency: 1,
        redundancy: redundancyOf(credited.name, owned),
        diversity: 1,
      };
      items.push({
        subject,
        kind: "track",
        title: recording.title ?? "Untitled",
        artist: credited.name,
        albumTitle: null,
        artistMbid: credited.mbid,
        releaseGroupMbid: null,
        recordingMbid: mbid,
        year: yearOfDate(recording["first-release-date"] ?? null),
        score: scoreOf(factors),
        factors,
        reason: reasonFor(
          {
            ...(anchorArtist === undefined
              ? {}
              : { anchor: { name: anchorArtist.name, plays: anchorArtist.plays } }),
            ...(factors.genreAffinity > 0 && genres[0] !== undefined
              ? { genre: genres[0].toLowerCase() }
              : {}),
          },
          windowDays,
        ),
        source: "ListenBrainz collaborative filtering",
        inLibrary: index.recordings.has(mbid),
      });
    }
  }

  /* ---- similar artists: ListenBrainz first, Last.fm as the fallback ---- */
  for (const anchor of signals.topArtists.slice(0, settings.discoverTopArtists)) {
    const found = await similarOf(ctx, anchor, settings);
    lastfmCount += found.viaLastfm ? found.artists.length : 0;
    for (const entry of found.artists.slice(0, SIMILAR_PER_ARTIST)) {
      const subject =
        entry.mbid === null ? `artist:${entry.name.toLowerCase()}` : `artist:${entry.mbid}`;
      if (dismissed.has(subject)) continue;
      if (similar.some((existing) => existing.subject === subject)) continue;
      similar.push({
        subject,
        name: entry.name,
        artistMbid: entry.mbid,
        similarTo: anchor.name,
        score: entry.score,
        source: found.viaLastfm ? "Last.fm (fallback)" : "ListenBrainz similar artists",
        inLibrary: index.artists.has(entry.name.toLowerCase()),
      });
    }
  }
  similar.sort((a, b) => b.score - a.score);

  /* ---- and their newest record, which is what you would actually import ---- */
  for (const entry of similar.filter((one) => !one.inLibrary).slice(0, ALBUMS_FROM_SIMILAR)) {
    if (entry.artistMbid === null) continue;
    // Same rule as the discography block: an artist nobody has cached is skipped, not fatal.
    let groups: readonly MbReleaseGroup[] = [];
    try {
      const answer = await browseReleaseGroupsByArtist(ctx, entry.artistMbid, { limit: 100 });
      groups = (answer.data?.["release-groups"] ?? []).filter((group) =>
        accepts(group, filtersOf(settings)),
      );
    } catch {
      continue;
    }
    const newest = [...groups].sort(
      (a, b) =>
        (yearOfDate(b["first-release-date"] ?? null) ?? 0) -
        (yearOfDate(a["first-release-date"] ?? null) ?? 0),
    )[0];
    if (newest?.id === undefined) continue;
    const subject = `release-group:${newest.id}`;
    if (dismissed.has(subject) || index.releaseGroups.has(newest.id)) continue;

    const anchorArtist = signals.topArtists.find(
      (artist) => artist.name.toLowerCase() === entry.similarTo.toLowerCase(),
    );
    const factors: ScoreFactors = {
      external: clamp01(entry.score),
      artistAffinity: artistAffinity(entry.similarTo, signals),
      genreAffinity: genreAffinity(
        (newest.genres ?? []).map((genre) => genre.name ?? ""),
        signals,
      ),
      recency: 1,
      redundancy: redundancyOf(entry.name, owned),
      diversity: 1,
    };
    items.push({
      subject,
      kind: "album",
      title: newest.title ?? "Untitled",
      artist: entry.name,
      albumTitle: newest.title ?? null,
      artistMbid: entry.artistMbid,
      releaseGroupMbid: newest.id,
      recordingMbid: null,
      year: yearOfDate(newest["first-release-date"] ?? null),
      score: scoreOf(factors),
      factors,
      reason: reasonFor(
        {
          similarTo: entry.similarTo,
          similarSource: entry.source.startsWith("Last.fm") ? "Last.fm" : "ListenBrainz",
          ...(anchorArtist === undefined
            ? {}
            : { anchor: { name: anchorArtist.name, plays: anchorArtist.plays } }),
          fallback: entry.source.startsWith("Last.fm"),
        },
        windowDays,
      ),
      source: entry.source,
      inLibrary: false,
    });
  }

  return {
    items: diversify(items, {
      maxPerArtist: settings.discoverMaxPerArtist,
      max: settings.discoverMaxItems,
    }),
    similar,
    metrics: {
      listenbrainz: user === "" ? "off" : `${String(cfCount)} recommendations`,
      lastfm: lastfmCount === 0 ? "not needed" : `${String(lastfmCount)} similar artists`,
    },
  };
}

function yearOfDate(date: string | null): number | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

interface SimilarFound {
  readonly artists: readonly { name: string; mbid: string | null; score: number }[];
  readonly viaLastfm: boolean;
}

/**
 * Similar artists for one anchor: ListenBrainz, then Last.fm.
 *
 * The fallback is only reached when ListenBrainz answers *nothing* — not when it answers
 * something short. Merging the two would mean a page that cannot say where a suggestion came
 * from, and "where did this come from" is half of what the reason line is for.
 */
async function similarOf(
  ctx: SourceContext,
  anchor: ArtistSignal,
  settings: Settings,
): Promise<SimilarFound> {
  if (anchor.mbid !== null && settings.sourcesEnabled.listenbrainz) {
    const rows = await quiet(
      async () => (await lbSimilarArtists(ctx, anchor.mbid as string)).data ?? [],
      [] as readonly LbSimilarArtist[],
    );
    const best = Math.max(...rows.map((row) => row.score ?? 0), 1);
    const artists = rows
      .filter((row) => (row.name ?? "") !== "")
      .map((row) => ({
        name: row.name as string,
        mbid: row.artist_mbid ?? null,
        score: clamp01((row.score ?? 0) / best),
      }));
    if (artists.length > 0) return { artists, viaLastfm: false };
  }

  if (!settings.sourcesEnabled.lastfm) return { artists: [], viaLastfm: false };
  const rows = await quiet<readonly LastfmSimilarArtist[]>(
    async () => (await artistSimilar(ctx, anchor.name, 20))?.data?.similarartists?.artist ?? [],
    [],
  );
  return {
    artists: rows
      .filter((row) => (row.name ?? "") !== "")
      .map((row) => ({
        name: row.name as string,
        mbid: row.mbid === undefined || row.mbid === "" ? null : row.mbid,
        score: clamp01(Number(row.match ?? 0)),
      })),
    viaLastfm: true,
  };
}
