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
 *
 * ## The lookup budget, and the two halves of the list
 *
 * ListenBrainz hands back a hundred recordings ranked by its own score, and a listener whose
 * scrobbles come from their own library naturally gets that library back at the top of it. A
 * MusicBrainz lookup costs a request a second against somebody else's server, so the budget is
 * spent on what is *not* already here: a recording the library holds is skipped before any call
 * is made, and named from its own row instead — it needs no lookup at all, and "In your library"
 * becomes a list you can already play.
 *
 * The two halves are then ranked and cut together, under one ceiling: `discoverMaxItems` is a
 * ceiling on the list, not on a tab. An owned row costs no lookup — that is the whole of the fix
 * — but it takes its place in the same ranking as a new one, and the Console splits the result
 * into its two tabs afterwards.
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

/**
 * What the library already holds: three membership tests, and — for a recording — the row that
 * names it.
 *
 * `recordings` was a `Set` while the only question asked of it was "do I have it?", and the
 * answer arrived *after* a MusicBrainz call. Now that the question is asked *before* one, the
 * same read has to answer a second one — "and what is it called?" — because a recording we own
 * needs no external call at all: its title and artist live in `library_tracks`, which is the
 * source of truth for metadata anyway. A `Map` costs nothing more and removes the round trip.
 */
export interface LibraryIndex {
  /** `recording_mbid` → the row that names this recording. */
  readonly recordings: ReadonlyMap<string, LibraryRecording>;
  readonly releaseGroups: ReadonlySet<string>;
  readonly artists: ReadonlySet<string>;
}

/** One owned recording, as much of it as a card and the playlist search need. */
export interface LibraryRecording {
  readonly title: string;
  readonly artist: string | null;
  /** The album's year, so an owned row keeps the date its card used to show. */
  readonly year: number | null;
}

export async function libraryIndex(db: Database = defaultDb()): Promise<LibraryIndex> {
  const tracks = await db
    .select({
      recording: libraryTracks.recordingMbid,
      title: libraryTracks.title,
      artist: libraryTracks.artist,
      album: libraryTracks.albumId,
    })
    .from(libraryTracks);
  const albums = await db
    .select({
      id: libraryAlbums.id,
      rg: libraryAlbums.releaseGroupMbid,
      artist: libraryAlbums.albumArtist,
      year: libraryAlbums.year,
    })
    .from(libraryAlbums);

  // The year belongs to the album: `library_tracks` carries no such column, and both reads
  // already walk their whole table, so joining them is a `Map`, not a second query.
  const years = new Map(albums.map((row) => [row.id, row.year] as const));

  // One recording can sit on several rows — a track owned in two releases — and the first one
  // names it. Which album the card links to is `ownedAlbums`' question, not this index's.
  const recordings = new Map<string, LibraryRecording>();
  for (const row of tracks) {
    if (row.recording === null || row.recording === "" || recordings.has(row.recording)) continue;
    recordings.set(row.recording, {
      title: row.title,
      artist: row.artist,
      year: row.album === null ? null : (years.get(row.album) ?? null),
    });
  }

  return {
    recordings,
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

/** One entry of the ListenBrainz collaborative-filtering answer, as the integration types it. */
export interface CfEntry {
  readonly recording_mbid?: string;
  readonly score?: number;
}

/** What the walk spent, for the signals strip: `100 received, 61 in your library, 15 examined`. */
export interface CfCounts {
  /** What ListenBrainz answered. Not "what we could use": the walk filters further down. */
  readonly received: number;
  /** How many of those the library already holds. Costs no lookup. */
  readonly inLibrary: number;
  /** How many MusicBrainz lookups the walk actually made. */
  readonly examined: number;
}

export interface CfWalkOptions {
  readonly entries: readonly CfEntry[];
  readonly index: LibraryIndex;
  readonly dismissed: ReadonlySet<string>;
  /** `discoverCfLookups`. One MusicBrainz request each, so this is the thing to protect. */
  readonly budget: number;
  readonly signals: ListeningSignals;
  readonly windowDays: number;
  /** How many albums the library holds per artist, for the redundancy penalty. */
  readonly owned: ReadonlyMap<string, number>;
  /** One MusicBrainz lookup. Never called for a recording the library already holds. */
  readonly lookup: (mbid: string) => Promise<MbRecording | null>;
}

export interface CfWalk {
  readonly items: readonly RecommendedItem[];
  readonly counts: CfCounts;
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
  let counts: CfCounts = { received: 0, inLibrary: 0, examined: 0 };
  let lastfmCount = 0;

  /* ---- ListenBrainz collaborative filtering: recordings ---- */
  const user = settings.listenbrainzUser.trim();
  if (user !== "" && settings.sourcesEnabled.listenbrainz) {
    const entries = await quiet(
      async () => (await lbRecommendations(ctx, user, 100)).data?.payload?.mbids ?? [],
      [] as readonly CfEntry[],
    );
    const walk = await collectCollaborative({
      entries,
      index,
      dismissed,
      budget: settings.discoverCfLookups,
      signals,
      windowDays,
      owned,
      // A dead MusicBrainz call is one missing row, never a failed page.
      lookup: (mbid) =>
        quiet(async () => (await lookupRecording(ctx, mbid)).data, null as MbRecording | null),
    });
    items.push(...walk.items);
    counts = walk.counts;
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
      listenbrainz: user === "" ? "off" : cfStrip(counts),
      lastfm: lastfmCount === 0 ? "not needed" : `${String(lastfmCount)} similar artists`,
    },
  };
}

/**
 * Walk the collaborative-filtering list, and spend the lookup budget on what is new.
 *
 * The order of the three tests is the whole of the fix, and each one is cheap: a dismissal is a
 * set, "in your library" is a map, and only what survives both costs a MusicBrainz request. A
 * listener whose scrobbles come from their own library gets that library back at the top of
 * ListenBrainz's ranking, so filtering afterwards meant that the larger the library, the fewer
 * of the `discoverCfLookups` calls were left for anything actually new — the opposite of what
 * the budget is for.
 */
export async function collectCollaborative(options: CfWalkOptions): Promise<CfWalk> {
  const { entries, index, dismissed, budget, signals, windowDays, owned, lookup } = options;
  const items: RecommendedItem[] = [];
  let inLibrary = 0;
  let examined = 0;

  for (const entry of entries) {
    const mbid = entry.recording_mbid;
    if (mbid === undefined || mbid === "") continue;
    // Counted before the dismissal test: a recording the library holds is "in your library"
    // whether or not the page has stopped offering it — the strip answers "what did ListenBrainz
    // name that I already have", not "what is still on screen".
    const mine = index.recordings.get(mbid);
    if (mine !== undefined) inLibrary += 1;

    const subject = `recording:${mbid}`;
    if (dismissed.has(subject)) continue;

    if (mine === undefined) {
      if (examined >= budget) continue;
      examined += 1;
      const recording = await lookup(mbid);
      if (recording === null) continue;
      const credited = artistOf(recording);
      items.push(
        recommendation({
          mbid,
          subject,
          title: recording.title ?? "Untitled",
          artistName: credited.name,
          artistMbid: credited.mbid,
          year: yearOfDate(recording["first-release-date"] ?? null),
          genres: (recording.genres ?? [])
            .map((genre) => genre.name ?? "")
            .filter((name) => name !== ""),
          score: entry.score ?? 0.5,
          inLibrary: false,
          signals,
          windowDays,
          owned,
        }),
      );
      continue;
    }

    // Owned, and named by its own row: no MusicBrainz call at all, which is the point of the fix.
    items.push(
      recommendation({
        mbid,
        subject,
        title: mine.title,
        artistName: mine.artist ?? "Unknown artist",
        artistMbid: null,
        year: mine.year,
        genres: [],
        score: entry.score ?? 0.5,
        inLibrary: true,
        signals,
        windowDays,
        owned,
      }),
    );
  }

  return { items, counts: { received: entries.length, inLibrary, examined } };
}

/**
 * The three numbers the strip shows, in the order the question was asked: what arrived, what it
 * named that you already own, and what it cost to find out about the rest.
 */
export function cfStrip(counts: CfCounts): string {
  return (
    `${String(counts.received)} received, ${String(counts.inLibrary)} in your library, ` +
    `${String(counts.examined)} examined`
  );
}

interface RecommendationInput {
  readonly mbid: string;
  readonly subject: string;
  readonly title: string;
  readonly artistName: string;
  readonly artistMbid: string | null;
  readonly year: number | null;
  readonly genres: readonly string[];
  readonly score: number;
  readonly inLibrary: boolean;
  readonly signals: ListeningSignals;
  readonly windowDays: number;
  readonly owned: ReadonlyMap<string, number>;
}

/**
 * One row, scored and explained — the same arithmetic whether it came from a lookup or from a
 * row the library already had.
 *
 * An owned row carries no genres of its own: they live in the metadata document, and reading
 * that per candidate is a query the budget was spent precisely to avoid. Its genre affinity is
 * therefore 0, and the **redundancy** term — which reads the artist, and the artist *is* known —
 * is what sinks it below the new suggestions. That term is why one function can score both
 * halves and still leave them in the right order.
 */
function recommendation(input: RecommendationInput): RecommendedItem {
  const factors: ScoreFactors = {
    external: clamp01(input.score),
    artistAffinity: artistAffinity(input.artistName, input.signals),
    genreAffinity: genreAffinity(input.genres, input.signals),
    recency: 1,
    redundancy: redundancyOf(input.artistName, input.owned),
    diversity: 1,
  };
  const anchorArtist = input.signals.topArtists.find(
    (artist) => artist.name.toLowerCase() === input.artistName.toLowerCase(),
  );
  return {
    subject: input.subject,
    kind: "track",
    title: input.title,
    artist: input.artistName,
    albumTitle: null,
    artistMbid: input.artistMbid,
    releaseGroupMbid: null,
    recordingMbid: input.mbid,
    year: input.year,
    score: scoreOf(factors),
    factors,
    reason: reasonFor(
      {
        ...(anchorArtist === undefined
          ? {}
          : { anchor: { name: anchorArtist.name, plays: anchorArtist.plays } }),
        ...(factors.genreAffinity > 0 && input.genres[0] !== undefined
          ? { genre: input.genres[0].toLowerCase() }
          : {}),
      },
      input.windowDays,
    ),
    source: "ListenBrainz collaborative filtering",
    inLibrary: input.inLibrary,
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
