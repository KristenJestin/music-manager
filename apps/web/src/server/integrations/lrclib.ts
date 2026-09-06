/**
 * LRCLIB (`docs/03-metadonnees.md` §2.6, §4).
 *
 * Free, keyless, and the only source of synchronised lyrics we have. Two endpoints matter:
 * `/api/get` answers with one entry when the four fields match exactly, `/api/search` returns
 * candidates ranked by nothing in particular — the choice among them is
 * `chooseLrclibEntry` in `@mm/domain`, which prefers a synchronised entry whose duration is
 * closest to ours.
 *
 * The `instrumental` flag is the reason this source is worth its call: it is what turns
 * `LYRICS` from *missing* into **n/a** (§6), which is the difference between "we failed to
 * find the words" and "this track has none".
 */
import type { LrclibEntry } from "@mm/domain";
import { chooseLrclibEntry } from "@mm/domain";
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const LRCLIB_BASE = "https://lrclib.net/api";

export interface LyricsQuery {
  readonly artist: string;
  readonly track: string;
  readonly album?: string;
  readonly durationSeconds?: number;
}

/** The cache key: the question, normalised, so two spellings of it are one row. */
export function queryKey(prefix: string, query: LyricsQuery): string {
  const parts = [
    `artist=${query.artist.trim().toLowerCase()}`,
    `track=${query.track.trim().toLowerCase()}`,
    ...(query.album === undefined || query.album === ""
      ? []
      : [`album=${query.album.trim().toLowerCase()}`]),
    ...(query.durationSeconds === undefined
      ? []
      : [`duration=${String(Math.round(query.durationSeconds))}`]),
  ];
  return `${prefix}?${parts.join("&")}`;
}

/** Exact lookup. `null` when LRCLIB has no entry for that exact quadruple. */
export async function get(
  ctx: SourceContext,
  query: LyricsQuery,
): Promise<CachedValue<LrclibEntry | null>> {
  return await cached<LrclibEntry>(
    "lrclib",
    queryKey("get", query),
    async () => {
      const search = new URLSearchParams({
        artist_name: query.artist,
        track_name: query.track,
        ...(query.album === undefined ? {} : { album_name: query.album }),
        ...(query.durationSeconds === undefined
          ? {}
          : { duration: String(Math.round(query.durationSeconds)) }),
      });
      const answer = await getJson<LrclibEntry>({
        source: "lrclib",
        url: `${LRCLIB_BASE}/get?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.lrclib),
  );
}

/** Candidate list. Always an array; an empty one is a legitimate answer. */
export async function search(
  ctx: SourceContext,
  query: LyricsQuery,
): Promise<CachedValue<readonly LrclibEntry[] | null>> {
  return await cached<readonly LrclibEntry[]>(
    "lrclib",
    queryKey("search", query),
    async () => {
      const params = new URLSearchParams({
        artist_name: query.artist,
        track_name: query.track,
        ...(query.album === undefined ? {} : { album_name: query.album }),
      });
      const answer = await getJson<readonly LrclibEntry[]>({
        source: "lrclib",
        url: `${LRCLIB_BASE}/search?${params.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.lrclib),
  );
}

export interface ChosenLyrics {
  readonly entry: LrclibEntry | null;
  readonly fetchedAt: string;
  /** Which endpoint answered — shown by `mm doc show`. */
  readonly via: "get" | "search" | "none";
  /** False when the answer came out of the cache rather than off the wire. */
  readonly fresh: boolean;
}

/**
 * The lyrics for one track: the exact lookup first, the search as a fallback.
 *
 * `/api/get` is tried first because when it answers it is unambiguous; `/api/search` is where
 * the durations are approximate and a choice has to be made. Both answers are cached, so the
 * second call for the same track — the offline rebuild — makes no request at all.
 */
export async function lyricsFor(ctx: SourceContext, query: LyricsQuery): Promise<ChosenLyrics> {
  const exact = await get(ctx, query);
  if (exact.data !== null) {
    return { entry: exact.data, fetchedAt: exact.fetchedAt, via: "get", fresh: exact.fresh };
  }

  const results = await search(ctx, query);
  const list = results.data ?? [];
  const chosen = chooseLrclibEntry(list, {
    ...(query.durationSeconds === undefined ? {} : { durationSeconds: query.durationSeconds }),
    toleranceSeconds: ctx.config.lyricsMaxDurationDelta,
  });
  return {
    entry: chosen,
    fetchedAt: results.fetchedAt,
    via: chosen === null ? "none" : "search",
    fresh: results.fresh,
  };
}
