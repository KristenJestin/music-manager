/**
 * `signals.service` — what you actually listen to (`docs/05-recommandations.md` § Signaux).
 *
 * Navidrome is the only place that knows this: Feishin and Symfonium scrobble into it, so its
 * play counts, its stars and its ratings are the union of every player in the house. This
 * module reads four Subsonic views over a **sliding window** and turns them into two lists —
 * top artists (with MBIDs, so a recommendation can be crossed with the library) and top
 * genres. Nothing here talks to MusicBrainz or ListenBrainz; it only says what you play.
 *
 * Three deliberate choices:
 *
 *  - **A play is weighted, not counted.** `getAlbumList2?type=frequent` returns a lifetime
 *    counter, and a lifetime counter is not "what you listen to now" — it is what you listened
 *    to in 2019. So a counter is multiplied by how recently it last moved (`recencyWeight`),
 *    which halves once per window past the window's edge. An album played 200 times and last
 *    touched three years ago loses to one played 30 times last week, which is the whole point.
 *  - **A star and a rating are signals, not filters.** They multiply, they never exclude:
 *    somebody who has never starred anything must still get recommendations.
 *  - **The artist MBID comes from `artists_cache`, by name.** That is exactly what
 *    `library.artistList` does, and for the same reason: the library is named by its folders,
 *    and Navidrome names artists the same way because it reads those folders. An artist with
 *    no cached MBID is kept — it still counts towards genres and towards the strip — but it
 *    cannot produce a discography gap, and `discography.service` says so rather than guessing.
 *
 * In fixtures mode the four views come from the recorded cassette
 * (`integrations/navidrome/cassettes/discover.json`), so `MM_FIXTURES=1` is fully offline and
 * the e2e run sees the same numbers on every machine.
 */
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { artistsCache, libraryAlbums } from "#/server/db/schema/index.ts";
import { serverEnv } from "#/server/env.ts";
import type { NavidromeClient } from "#/server/integrations/navidrome/client.ts";
import type { SubsonicAlbum, SubsonicSong } from "#/server/integrations/navidrome/types.ts";
import { cassetteFetch, loadCassette } from "#/server/integrations/navidrome/cassettes.ts";
import { navidromeClient, navidromeConfig } from "#/server/services/navidrome.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* the shape the page and the recommender both read                    */
/* ------------------------------------------------------------------ */

/** One row of the "listening signals" strip: is this source speaking, and what did it say? */
export interface SourceSignal {
  readonly name: string;
  readonly detail: string;
  readonly status: "ok" | "fallback" | "off" | "error";
  /** Already-formatted, because "4 128 plays" and "62 recommendations" are not the same unit. */
  readonly metric: string;
}

export interface ArtistSignal {
  readonly name: string;
  readonly mbid: string | null;
  /** Weighted plays over the window — see `recencyWeight`. Rounded for display. */
  readonly plays: number;
  /** How many of this artist's albums the signals touched. */
  readonly albums: number;
  readonly starred: boolean;
  /** Albums of this artist already in the library, for the "you have 2 of 6" badge. */
  readonly inLibrary: number;
}

export interface GenreSignal {
  readonly name: string;
  readonly plays: number;
}

export interface ListeningSignals {
  readonly observedAt: string;
  readonly windowDays: number;
  readonly totalPlays: number;
  readonly sources: readonly SourceSignal[];
  readonly topArtists: readonly ArtistSignal[];
  readonly topGenres: readonly GenreSignal[];
  /** Set when Navidrome could not be read; the page shows it instead of pretending. */
  readonly error: string | null;
}

/* ------------------------------------------------------------------ */
/* the pure part: weighting and aggregation                            */
/* ------------------------------------------------------------------ */

/** What one album or song contributes, stripped of Subsonic's spelling. */
export interface Observation {
  /**
   * The Subsonic entity this came from, namespaced by kind.
   *
   * It exists for one reason: **the four views overlap**. Discovery is in `frequent`, in
   * `recent`, in `starred` and in `getStarred2`, and adding its 128 plays four times would
   * report 512 — a number that is not wrong by a little, it is a different number. Every
   * observation is therefore deduplicated on this key before anything is summed.
   */
  readonly id: string;
  readonly artist: string;
  readonly album: string | null;
  readonly genres: readonly string[];
  readonly playCount: number;
  /** ISO date of the last play, or null when the server never recorded one. */
  readonly played: string | null;
  readonly starred: boolean;
  /** 1–5, or null. */
  readonly rating: number | null;
}

const DAY_MS = 86_400_000;

/**
 * How much a lifetime play counter still counts, given when it last moved.
 *
 * 1 inside the window; halving once per window beyond it. Never zero: an artist you played
 * daily for a year and stopped six months ago is still more yours than one you never played,
 * and a hard cut-off would make the whole list flip on the day an album crossed the edge.
 */
export function recencyWeight(played: string | null, now: Date, windowDays: number): number {
  if (played === null) return 0.5; // never recorded: half a voice, not none.
  const at = Date.parse(played);
  if (Number.isNaN(at)) return 0.5;
  const ageDays = (now.getTime() - at) / DAY_MS;
  if (ageDays <= windowDays) return 1;
  return 2 ** (-(ageDays - windowDays) / windowDays);
}

/** A star is worth a quarter more; a rating moves it by ±20%. Both multiply, neither filters. */
export function affectionWeight(starred: boolean, rating: number | null): number {
  const star = starred ? 1.25 : 1;
  const rated = rating === null || rating <= 0 ? 1 : 0.8 + rating * 0.08;
  return star * rated;
}

export interface Aggregate {
  readonly artists: readonly {
    name: string;
    plays: number;
    albums: number;
    starred: boolean;
  }[];
  readonly genres: readonly GenreSignal[];
  readonly totalPlays: number;
}

/**
 * Fold observations into artists and genres.
 *
 * Exported and pure so the weighting can be proven without a Navidrome anywhere near it —
 * which is what `signals.test.ts` does.
 */
export function aggregate(
  observations: readonly Observation[],
  options: {
    now: Date;
    windowDays: number;
    /**
     * Per artist (lower-cased), the most recent play `getTopSongs` knows about.
     *
     * An album's `played` is when the *album* was last touched; its top track may have been
     * played since, on shuffle, without the album row moving. Taking the newer of the two is
     * the whole reason `getTopSongs` is called: it refines recency without adding a single
     * play to the total, which is what would happen if its counters were summed on top of the
     * album counters that already contain them.
     */
    latestPlayed?: ReadonlyMap<string, string>;
  },
): Aggregate {
  const artists = new Map<
    string,
    { name: string; plays: number; albums: Set<string>; starred: boolean }
  >();
  const genres = new Map<string, { name: string; plays: number }>();
  const seen = new Set<string>();
  let total = 0;

  for (const item of observations) {
    const name = item.artist.trim();
    if (name === "") continue;
    // The four views overlap; an entity counts once. See `Observation.id`.
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const key0 = name.toLowerCase();
    const refined = options.latestPlayed?.get(key0);
    const played =
      refined !== undefined &&
      (item.played === null || Date.parse(refined) > Date.parse(item.played))
        ? refined
        : item.played;
    const weight =
      Math.max(item.playCount, 0) *
      recencyWeight(played, options.now, options.windowDays) *
      affectionWeight(item.starred, item.rating);
    if (weight <= 0) continue;
    total += weight;

    const key = name.toLowerCase();
    const entry = artists.get(key) ?? { name, plays: 0, albums: new Set<string>(), starred: false };
    entry.plays += weight;
    if (item.album !== null && item.album.trim() !== "") entry.albums.add(item.album.trim());
    entry.starred = entry.starred || item.starred;
    artists.set(key, entry);

    // One observation contributes its weight **once per distinct genre**. `genresOf` already
    // folds the duplicate Navidrome sends, but the guard belongs here too: `aggregate` takes
    // observations from anywhere, and a repeated name would otherwise inflate exactly one
    // genre — the one the server considers primary — which is the ranking's first row.
    const counted = new Set<string>();
    for (const raw of item.genres) {
      const genre = raw.trim().toLowerCase();
      if (genre === "" || counted.has(genre)) continue;
      counted.add(genre);
      const found = genres.get(genre) ?? { name: genre, plays: 0 };
      found.plays += weight;
      genres.set(genre, found);
    }
  }

  const byPlays = <T extends { plays: number; name: string }>(a: T, b: T): number =>
    b.plays - a.plays || a.name.localeCompare(b.name);

  return {
    artists: [...artists.values()]
      .map((entry) => ({
        name: entry.name,
        plays: Math.round(entry.plays),
        albums: entry.albums.size,
        starred: entry.starred,
      }))
      .sort(byPlays),
    genres: [...genres.values()]
      .map((entry) => ({ name: entry.name, plays: Math.round(entry.plays) }))
      .sort(byPlays),
    totalPlays: Math.round(total),
  };
}

/* ------------------------------------------------------------------ */
/* reading Navidrome                                                   */
/* ------------------------------------------------------------------ */

/**
 * Subsonic sends `genre` (one) and `genres` (many). Take the union, keep the order.
 *
 * A **union**, not a concatenation, and the difference is not academic: Navidrome puts the
 * primary genre in `genre` *and* repeats it inside `genres`, so an album tagged
 * `electronic; house; french house` arrives with `electronic` twice. Concatenating gave that
 * one genre double the weight of every other genre on the same record — on a library of one
 * album, `electronic 126` against `house 63` — which is the same class of bug as counting an
 * album once per Subsonic view, one level further down. The first spelling wins, because
 * `genre` is the one Navidrome considers primary.
 */
function genresOf(item: SubsonicAlbum | SubsonicSong): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: unknown): void => {
    if (typeof name !== "string" || name.trim() === "") return;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  add(item.genre);
  for (const entry of item.genres ?? []) add(entry.name);
  return out;
}

export function observationOfAlbum(album: SubsonicAlbum): Observation {
  return {
    id: `album:${album.id}`,
    artist: album.artist ?? album.artists?.[0]?.name ?? "",
    album: album.name ?? null,
    genres: genresOf(album),
    playCount: album.playCount ?? 0,
    played: album.played ?? null,
    starred: typeof album.starred === "string" && album.starred !== "",
    rating: album.userRating ?? null,
  };
}

export function observationOfSong(song: SubsonicSong): Observation {
  return {
    id: `song:${song.id}`,
    artist: song.artist ?? song.artists?.[0]?.name ?? "",
    album: song.album ?? null,
    genres: genresOf(song),
    playCount: song.playCount ?? 0,
    played: song.played ?? null,
    starred: typeof song.starred === "string" && song.starred !== "",
    rating: song.userRating ?? null,
  };
}

/**
 * The client `signals` reads through.
 *
 * In fixtures mode it is the recorded cassette, injected through the client's own `fetch`
 * seam — the same seam `navidrome.test.ts` uses. That is why `MM_FIXTURES=1 mm discover sync`
 * needs no server, no container and no network, and still exercises the real Subsonic parsing.
 */
export function signalsClient(
  settings: Settings,
  options: { client?: NavidromeClient; fixtures?: boolean } = {},
): { client: NavidromeClient; fixtures: boolean } {
  if (options.client !== undefined) return { client: options.client, fixtures: false };
  const fixtures = options.fixtures ?? serverEnv().MM_FIXTURES;
  if (fixtures) {
    return {
      fixtures: true,
      client: navidromeClient(
        { ...settings, navidromeUrl: "http://fixtures.invalid", navidromeUser: "fixtures" },
        { fetch: cassetteFetch(loadCassette("discover")), env: {} },
      ),
    };
  }
  return { client: navidromeClient(settings), fixtures: false };
}

/** How many albums each of the three views brings back. Enough to rank, small enough to be one call. */
export const VIEW_SIZE = 50;

/** How many artists get a `getTopSongs` round trip. The rest are ranked on albums alone. */
const TOP_SONGS_FOR = 6;

export interface CollectOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly client?: NavidromeClient;
  readonly fixtures?: boolean;
  readonly now?: Date;
}

/**
 * Read the four views, weight them, and name the artists.
 *
 * It never throws on Navidrome: an unreachable server produces empty signals with `error` set,
 * because Discover with no signals is a page that says why, and a Discover that 500s is a page
 * that says nothing.
 */
export async function collectSignals(options: CollectOptions = {}): Promise<ListeningSignals> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const now = options.now ?? new Date();
  const windowDays = settings.discoverWindowDays;
  const { client, fixtures } = signalsClient(settings, {
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.fixtures === undefined ? {} : { fixtures: options.fixtures }),
  });
  const config = navidromeConfig(settings);

  const empty = (error: string | null): ListeningSignals => ({
    observedAt: now.toISOString(),
    windowDays,
    totalPlays: 0,
    sources: sourceStrip(settings, { navidrome: error === null ? "off" : "error", metric: "—" }),
    topArtists: [],
    topGenres: [],
    error,
  });

  if (!fixtures && !config.enabled) {
    return empty(null);
  }

  const observations: Observation[] = [];
  try {
    for (const type of ["frequent", "recent", "starred"] as const) {
      const albums = await client.getAlbumList2({ type, size: VIEW_SIZE });
      for (const album of albums) observations.push(observationOfAlbum(album));
    }
    const starred = await client.getStarred2();
    for (const album of starred.album) observations.push(observationOfAlbum(album));

    /*
     * A starred *song* counts only when its artist has no album here at all.
     *
     * Navidrome's album counter already contains its songs' plays, so a starred track from an
     * album that is in one of the three lists would be counted twice — once inside the album
     * and once on its own. What a lone song does add is an artist the album views never
     * mentioned: somebody you only ever play one track by, which is exactly the artist a
     * recommendation engine should not be blind to.
     */
    const withAlbums = new Set(observations.map((one) => one.artist.trim().toLowerCase()));
    for (const song of starred.song) {
      const observation = observationOfSong(song);
      if (withAlbums.has(observation.artist.trim().toLowerCase())) continue;
      observations.push(observation);
    }
  } catch (error) {
    return empty(MMError.from(error).message);
  }

  const first = aggregate(observations, { now, windowDays });

  /*
   * The most-played artists get their top songs read too — for *when*, not for *how many*.
   *
   * Navidrome's album `playCount` is already the sum of its songs', so adding track counters
   * on top would count the same listening twice. What the tracks do know that the album row
   * does not is that one of them was played this morning on shuffle. So only the latest
   * timestamp is taken, and it feeds `recencyWeight`.
   */
  const latestPlayed = new Map<string, string>();
  for (const artist of first.artists.slice(0, TOP_SONGS_FOR)) {
    try {
      const songs = await client.getTopSongs(artist.name, 20);
      for (const song of songs) {
        const played = song.played;
        if (played === undefined || played === "") continue;
        const key = (song.artist ?? artist.name).toLowerCase();
        const current = latestPlayed.get(key);
        if (current === undefined || Date.parse(played) > Date.parse(current)) {
          latestPlayed.set(key, played);
        }
      }
    } catch {
      // A view this server does not implement is not a reason to lose the album signals.
    }
  }

  const folded = aggregate(observations, { now, windowDays, latestPlayed });
  const named = await withMbids(folded.artists, db);

  return {
    observedAt: now.toISOString(),
    windowDays,
    totalPlays: folded.totalPlays,
    sources: sourceStrip(settings, {
      navidrome: "ok",
      metric: `${folded.totalPlays.toLocaleString("en-GB")} weighted plays`,
    }),
    topArtists: named,
    topGenres: folded.genres.slice(0, 12),
    error: null,
  };
}

/** Attach the MBID and the library count to each artist, by name, exactly as `artistList` does. */
async function withMbids(
  artists: Aggregate["artists"],
  db: Database,
): Promise<readonly ArtistSignal[]> {
  const cached = await db
    .select({ mbid: artistsCache.artistMbid, name: artistsCache.name })
    .from(artistsCache);
  const byName = new Map(cached.map((row) => [row.name.toLowerCase(), row.mbid]));

  const owned = await db
    .select({ artist: libraryAlbums.albumArtist, id: libraryAlbums.id })
    .from(libraryAlbums);
  const ownedCount = new Map<string, number>();
  for (const row of owned) {
    const key = row.artist.toLowerCase();
    ownedCount.set(key, (ownedCount.get(key) ?? 0) + 1);
  }

  return artists.map((artist) => ({
    name: artist.name,
    mbid: byName.get(artist.name.toLowerCase()) ?? null,
    plays: artist.plays,
    albums: artist.albums,
    starred: artist.starred,
    inLibrary: ownedCount.get(artist.name.toLowerCase()) ?? 0,
  }));
}

/** The three rows of the strip. What each source is for, and whether it is going to answer. */
export function sourceStrip(
  settings: Settings,
  navidrome: { navidrome: SourceSignal["status"]; metric: string },
  extra: { listenbrainz?: string; lastfm?: string } = {},
): readonly SourceSignal[] {
  const lbUser = settings.listenbrainzUser.trim();
  const lbOn = settings.sourcesEnabled.listenbrainz && lbUser !== "";
  const lastfmOn = settings.sourcesEnabled.lastfm;
  return [
    {
      name: "Navidrome",
      detail:
        navidrome.navidrome === "off"
          ? "not configured — Settings › Integrations"
          : "play counts, stars and ratings, scrobbled by your players",
      status: navidrome.navidrome,
      metric: navidrome.metric,
    },
    {
      name: "ListenBrainz",
      detail: lbOn
        ? `collaborative filtering and similarity · user ${lbUser}`
        : "no ListenBrainz user set — collaborative filtering is skipped",
      status: lbOn ? "ok" : "off",
      metric: extra.listenbrainz ?? (lbOn ? "—" : "off"),
    },
    {
      name: "Last.fm",
      detail: lastfmOn
        ? "fallback for similar artists when ListenBrainz has nothing"
        : "source disabled in Settings › Metadata",
      status: lastfmOn ? "fallback" : "off",
      metric: extra.lastfm ?? (lastfmOn ? "—" : "off"),
    },
  ];
}
