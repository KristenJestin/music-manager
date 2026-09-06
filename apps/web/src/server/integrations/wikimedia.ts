/**
 * The artist image (`docs/03-metadonnees.md` §3, §4) — `artist.jpg` next to the artist folder.
 *
 * There is no "artist image API". The path §4 describes is a chain of three hops, each one
 * of which can be the last:
 *
 *   MusicBrainz artist url-rels ──▶ Wikidata entity ──▶ property P18 ──▶ Commons file
 *                               └─▶ a direct "image" relation, when one exists
 *                               └─▶ fanart.tv by artist MBID, when a key is configured
 *
 * Every hop is cached separately, because they change at very different rates: an artist's
 * Wikidata id essentially never moves, the picture chosen for it sometimes does.
 *
 * fanart.tv is last, not first, on purpose: it needs a key, and §3 names Wikimedia as the
 * source with fanart.tv as "repli".
 */
import type { MbArtist, MbRelation } from "@mm/domain";
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const WIKIDATA_BASE = "https://www.wikidata.org/wiki/Special:EntityData";
export const COMMONS_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath";
export const FANART_BASE = "https://webservice.fanart.tv/v3/music";

/** `artistFull` carries url-rels; the shared type does not declare them. */
export interface MbArtistWithRelations extends MbArtist {
  readonly relations?: readonly MbRelation[];
  readonly country?: string;
}

/** The Wikidata id (`Q…`) an artist's url-rels point at, or `null`. */
export function wikidataIdOf(artist: MbArtistWithRelations | null): string | null {
  for (const relation of artist?.relations ?? []) {
    if (relation["target-type"] !== "url") continue;
    const resource = relation.url?.resource ?? "";
    const match = /wikidata\.org\/(?:wiki|entity)\/(Q\d+)/.exec(resource);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** A url-rel that is already an image — MusicBrainz's own "image" relationship. */
export function directImageOf(artist: MbArtistWithRelations | null): string | null {
  for (const relation of artist?.relations ?? []) {
    if (relation["target-type"] === "url" && relation.type === "image") {
      const resource = relation.url?.resource ?? "";
      if (resource !== "") return resource;
    }
  }
  return null;
}

interface WikidataSnak {
  readonly mainsnak?: { readonly datavalue?: { readonly value?: unknown } };
}

interface WikidataEntity {
  readonly claims?: Readonly<Record<string, readonly WikidataSnak[]>>;
}

export interface WikidataResponse {
  readonly entities?: Readonly<Record<string, WikidataEntity>>;
}

/** The Commons file name in property P18 ("image"), or `null`. */
export function commonsFileOf(response: WikidataResponse | null, id: string): string | null {
  const claims = response?.entities?.[id]?.claims ?? {};
  const value = claims["P18"]?.[0]?.mainsnak?.datavalue?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

/** The full-size URL Commons serves a file at, resized to `width`. */
export function commonsUrl(file: string, width = 1000): string {
  return `${COMMONS_FILEPATH}/${encodeURIComponent(file)}?width=${String(width)}`;
}

export async function wikidataEntity(
  ctx: SourceContext,
  id: string,
): Promise<CachedValue<WikidataResponse | null>> {
  return await cached<WikidataResponse>(
    "wikimedia",
    `wikidata/${id}`,
    async () => {
      const answer = await getJson<WikidataResponse>({
        source: "wikimedia",
        url: `${WIKIDATA_BASE}/${id}.json`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 200,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.wikimedia),
  );
}

export interface FanartImage {
  readonly id?: string;
  readonly url?: string;
  readonly likes?: string;
}

export interface FanartArtist {
  readonly name?: string;
  readonly mbid_id?: string;
  readonly artistthumb?: readonly FanartImage[];
  readonly artistbackground?: readonly FanartImage[];
  readonly musiclogo?: readonly FanartImage[];
  readonly error_message?: string;
}

export async function fanartArtist(
  ctx: SourceContext,
  artistMbid: string,
): Promise<CachedValue<FanartArtist | null> | null> {
  if (!ctx.offline && ctx.config.fanartKey === "") return null;
  return await cached<FanartArtist>(
    "wikimedia",
    `fanart/${artistMbid}`,
    async () => {
      const search = new URLSearchParams({ api_key: ctx.config.fanartKey });
      const answer = await getJson<FanartArtist>({
        source: "fanart.tv",
        url: `${FANART_BASE}/${artistMbid}?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 200,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.wikimedia),
  );
}

export interface ArtistImage {
  readonly url: string;
  readonly via: "wikimedia" | "musicbrainz" | "fanarttv";
  readonly fetchedAt: string;
}

/**
 * The best artist image we can reach, or `null` when nobody has one.
 *
 * The order is §3's: Wikimedia through the MusicBrainz url-rels, then a direct MusicBrainz
 * image relation, then fanart.tv. Each hop is skipped rather than retried when it has nothing
 * — a missing image is a fact about the artist, not a failure of the pipeline.
 */
export async function artistImage(
  ctx: SourceContext,
  artist: MbArtistWithRelations | null,
): Promise<ArtistImage | null> {
  const id = wikidataIdOf(artist);
  if (id !== null) {
    const entity = await wikidataEntity(ctx, id);
    const file = commonsFileOf(entity.data, id);
    if (file !== null) {
      return { url: commonsUrl(file), via: "wikimedia", fetchedAt: entity.fetchedAt };
    }
  }

  const direct = directImageOf(artist);
  if (direct !== null) {
    return { url: direct, via: "musicbrainz", fetchedAt: new Date().toISOString() };
  }

  const mbid = artist?.id;
  if (mbid !== undefined && mbid !== "") {
    const fanart = await fanartArtist(ctx, mbid);
    const url = fanart?.data?.artistthumb?.[0]?.url ?? fanart?.data?.artistbackground?.[0]?.url;
    if (url !== undefined && url !== "" && fanart !== null) {
      return { url, via: "fanarttv", fetchedAt: fanart.fetchedAt };
    }
  }

  return null;
}
