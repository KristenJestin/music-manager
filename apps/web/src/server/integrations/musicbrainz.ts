/**
 * MusicBrainz WS/2 (`docs/03-metadonnees.md` §4).
 *
 * Three rules, all of them theirs:
 *
 *  1. **one request per second, per client, globally.** The limiter lives in `./http.ts` and
 *     is keyed by source, so fourteen tracks resolving in parallel still leave one call per
 *     second. This is the only source with a hard published limit, and exceeding it gets the
 *     User-Agent blocked, not throttled.
 *  2. **a User-Agent naming the application and a contact.** Built in `./config.ts`.
 *  3. **`inc=` decides what comes back.** The three presets below are the `inc` lists of §4,
 *     spelled once: asking for less means a second lookup later, asking for more costs
 *     nothing but bytes we keep for ever anyway (§1).
 *
 * Every response goes into the raw cache verbatim under a key that *is* the request — entity,
 * MBID and preset — so a document rebuilt offline reads exactly the bytes the network gave.
 */
import type { MbArtist, MbRecording, MbRelease, MbReleaseGroup, MbWork } from "@mm/domain";
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2";

/** §4's rate limit, in milliseconds between two departures. */
export const MB_MIN_INTERVAL_MS = 1_000;

/**
 * The `inc` lists of §4. `releaseFull` is the one the documentation spells out; the other two
 * are the same idea for the entities a release lookup does not carry in full.
 */
export const INC_PRESETS = {
  releaseFull: [
    "artists",
    "artist-credits",
    "labels",
    "recordings",
    "release-groups",
    "media",
    "isrcs",
    "genres",
    "tags",
    "aliases",
    "artist-rels",
    "recording-rels",
    "work-rels",
    "recording-level-rels",
    "work-level-rels",
    "url-rels",
  ],
  recordingFull: [
    "artists",
    "artist-credits",
    "isrcs",
    "genres",
    "tags",
    "aliases",
    "artist-rels",
    "work-rels",
    "url-rels",
    "work-level-rels",
  ],
  artistFull: ["aliases", "genres", "tags", "url-rels", "artist-rels"],
  releaseGroupFull: ["artists", "artist-credits", "genres", "tags", "aliases", "url-rels"],
  workFull: ["artist-rels", "aliases", "tags", "genres", "url-rels"],
} as const;

export type IncPreset = keyof typeof INC_PRESETS;

/** The `inc=` query value of a preset — the plus-joined list §4 shows. */
export function incOf(preset: IncPreset): string {
  return INC_PRESETS[preset].join("+");
}

function url(path: string, query: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams({ ...query, fmt: "json" });
  return `${MUSICBRAINZ_BASE}/${path}?${search.toString()}`;
}

async function lookup<T>(
  ctx: SourceContext,
  entity: string,
  mbid: string,
  preset: IncPreset,
): Promise<CachedValue<T | null>> {
  const key = `${entity}/${mbid}?inc=${preset}`;
  return await cached<T>(
    "musicbrainz",
    key,
    async () => {
      const answer = await getJson<T>({
        source: "musicbrainz",
        url: url(`${entity}/${mbid}`, { inc: incOf(preset) }),
        headers: { "user-agent": ctx.config.userAgent },
        minIntervalMs: MB_MIN_INTERVAL_MS,
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.musicbrainz),
  );
}

export async function lookupRelease(
  ctx: SourceContext,
  mbid: string,
  preset: IncPreset = "releaseFull",
): Promise<CachedValue<MbRelease | null>> {
  return await lookup<MbRelease>(ctx, "release", mbid, preset);
}

export async function lookupRecording(
  ctx: SourceContext,
  mbid: string,
  preset: IncPreset = "recordingFull",
): Promise<CachedValue<MbRecording | null>> {
  return await lookup<MbRecording>(ctx, "recording", mbid, preset);
}

export async function lookupReleaseGroup(
  ctx: SourceContext,
  mbid: string,
  preset: IncPreset = "releaseGroupFull",
): Promise<CachedValue<MbReleaseGroup | null>> {
  return await lookup<MbReleaseGroup>(ctx, "release-group", mbid, preset);
}

export async function lookupArtist(
  ctx: SourceContext,
  mbid: string,
  preset: IncPreset = "artistFull",
): Promise<CachedValue<MbArtist | null>> {
  return await lookup<MbArtist>(ctx, "artist", mbid, preset);
}

export async function lookupWork(
  ctx: SourceContext,
  mbid: string,
  preset: IncPreset = "workFull",
): Promise<CachedValue<MbWork | null>> {
  return await lookup<MbWork>(ctx, "work", mbid, preset);
}

export interface BrowseReleaseGroups {
  readonly "release-group-count"?: number;
  readonly "release-groups"?: readonly MbReleaseGroup[];
}

/** Every release group credited to an artist — P09's Discover reads this, P04 caches it. */
export async function browseReleaseGroupsByArtist(
  ctx: SourceContext,
  artistMbid: string,
  options: { limit?: number; offset?: number } = {},
): Promise<CachedValue<BrowseReleaseGroups | null>> {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const key = `release-group?artist=${artistMbid}&limit=${String(limit)}&offset=${String(offset)}`;
  return await cached<BrowseReleaseGroups>(
    "musicbrainz",
    key,
    async () => {
      const answer = await getJson<BrowseReleaseGroups>({
        source: "musicbrainz",
        url: url("release-group", {
          artist: artistMbid,
          limit: String(limit),
          offset: String(offset),
        }),
        headers: { "user-agent": ctx.config.userAgent },
        minIntervalMs: MB_MIN_INTERVAL_MS,
        nullOn404: true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.musicbrainz),
  );
}

export interface MbSearchResult {
  readonly count?: number;
  readonly offset?: number;
  readonly releases?: readonly MbRelease[];
  readonly recordings?: readonly MbRecording[];
  readonly "release-groups"?: readonly MbReleaseGroup[];
  readonly artists?: readonly MbArtist[];
}

/**
 * A Lucene search. P05 is the one that will use it in anger; P04 owns the transport, the
 * limiter and the cache key so that the matcher never has to think about any of the three.
 */
export async function search(
  ctx: SourceContext,
  entity: "release" | "recording" | "release-group" | "artist",
  luceneQuery: string,
  options: { limit?: number; offset?: number } = {},
): Promise<CachedValue<MbSearchResult | null>> {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  const key = `search/${entity}?query=${luceneQuery}&limit=${String(limit)}&offset=${String(offset)}`;
  return await cached<MbSearchResult>(
    "musicbrainz",
    key,
    async () => {
      const answer = await getJson<MbSearchResult>({
        source: "musicbrainz",
        url: url(entity, {
          query: luceneQuery,
          limit: String(limit),
          offset: String(offset),
        }),
        headers: { "user-agent": ctx.config.userAgent },
        minIntervalMs: MB_MIN_INTERVAL_MS,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.musicbrainz),
  );
}
