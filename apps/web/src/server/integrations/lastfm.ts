/**
 * Last.fm (`docs/03-metadonnees.md` §4, "repli genres/moods").
 *
 * A fallback, never a first opinion: MusicBrainz genres win by `genrePreference`, and Last.fm
 * only fills a `GENRE` that would otherwise be missing. Its top tags are folksonomy, so they
 * are filtered by vote count (`genreMinCount`) and by the same mood vocabulary the
 * MusicBrainz resolver uses — otherwise `GENRE` fills up with "seen live" and "favourites".
 *
 * The key goes in the query string, so every URL that reaches a log or an error body passes
 * through `redact()` first. The cache key never contains it.
 */
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmTag {
  readonly name?: string;
  readonly count?: number;
  readonly url?: string;
}

export interface LastfmTopTags {
  readonly toptags?: { readonly tag?: readonly LastfmTag[] | LastfmTag };
  readonly error?: number;
  readonly message?: string;
}

export interface LastfmSimilarArtist {
  readonly name?: string;
  readonly mbid?: string;
  readonly match?: string | number;
  readonly url?: string;
}

export interface LastfmSimilar {
  readonly similarartists?: { readonly artist?: readonly LastfmSimilarArtist[] };
  readonly error?: number;
  readonly message?: string;
}

/** Last.fm sends one object instead of a one-element array. Normalise once, here. */
export function tagList(response: LastfmTopTags | null): readonly LastfmTag[] {
  const tag = response?.toptags?.tag;
  if (tag === undefined) return [];
  return Array.isArray(tag) ? (tag as readonly LastfmTag[]) : [tag as LastfmTag];
}

async function call<T>(
  ctx: SourceContext,
  key: string,
  params: Readonly<Record<string, string>>,
): Promise<CachedValue<T | null> | null> {
  if (!ctx.offline && ctx.config.lastfmKey === "") return null;
  return await cached<T>(
    "lastfm",
    key,
    async () => {
      const search = new URLSearchParams({
        ...params,
        api_key: ctx.config.lastfmKey,
        format: "json",
        autocorrect: "1",
      });
      const answer = await getJson<T>({
        source: "lastfm",
        url: `${LASTFM_BASE}?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 250,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.lastfm),
  );
}

export async function trackTopTags(
  ctx: SourceContext,
  artist: string,
  track: string,
): Promise<CachedValue<LastfmTopTags | null> | null> {
  return await call<LastfmTopTags>(
    ctx,
    `track.getTopTags?artist=${artist.toLowerCase()}&track=${track.toLowerCase()}`,
    { method: "track.gettoptags", artist, track },
  );
}

export async function artistTopTags(
  ctx: SourceContext,
  artist: string,
): Promise<CachedValue<LastfmTopTags | null> | null> {
  return await call<LastfmTopTags>(ctx, `artist.getTopTags?artist=${artist.toLowerCase()}`, {
    method: "artist.gettoptags",
    artist,
  });
}

export async function artistSimilar(
  ctx: SourceContext,
  artist: string,
  limit = 20,
): Promise<CachedValue<LastfmSimilar | null> | null> {
  return await call<LastfmSimilar>(
    ctx,
    `artist.getSimilar?artist=${artist.toLowerCase()}&limit=${String(limit)}`,
    { method: "artist.getsimilar", artist, limit: String(limit) },
  );
}
