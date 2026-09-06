/**
 * ListenBrainz (`docs/03-metadonnees.md` §4, "lecture sans clé").
 *
 * Read-only and unauthenticated, which is why it is here at all: it is the last fallback for
 * genres when neither MusicBrainz nor Last.fm has any, and it is where P09's Discover will
 * come from. Its recording-metadata endpoint answers by MBID, so — like Deezer's ISRC join —
 * there is no fuzzy matching anywhere in this client.
 *
 * `recommendations(user)` is deliberately a stub that fetches and caches, nothing more: P09
 * owns what to *do* with a recommendation list, P04 only owns getting it without a second
 * transport layer being invented for it.
 */
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const LISTENBRAINZ_BASE = "https://api.listenbrainz.org/1";
export const LISTENBRAINZ_LABS = "https://labs.api.listenbrainz.org";

export interface LbTag {
  readonly tag?: string;
  readonly count?: number;
  readonly genre_mbid?: string;
}

export interface LbRecordingMetadata {
  readonly tag?: {
    readonly recording?: readonly LbTag[];
    readonly artist?: readonly LbTag[];
  };
  readonly recording?: { readonly name?: string; readonly length?: number };
}

/** The endpoint answers a map keyed by the MBIDs asked for. */
export type LbRecordingMetadataResponse = Readonly<Record<string, LbRecordingMetadata>>;

export interface LbSimilarArtist {
  readonly artist_mbid?: string;
  readonly name?: string;
  readonly score?: number;
  readonly reference_mbid?: string;
}

/** Community tags on one recording, and on its artist. */
export async function recordingTags(
  ctx: SourceContext,
  recordingMbid: string,
): Promise<CachedValue<LbRecordingMetadataResponse | null>> {
  return await cached<LbRecordingMetadataResponse>(
    "listenbrainz",
    `metadata/recording/${recordingMbid}?inc=tag`,
    async () => {
      const search = new URLSearchParams({ recording_mbids: recordingMbid, inc: "tag" });
      const answer = await getJson<LbRecordingMetadataResponse>({
        source: "listenbrainz",
        url: `${LISTENBRAINZ_BASE}/metadata/recording/?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 250,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.listenbrainz),
  );
}

/** The tags of one recording, flattened and filtered by vote count. */
export function tagsOf(
  response: LbRecordingMetadataResponse | null,
  recordingMbid: string,
  minCount: number,
): readonly string[] {
  const entry = response?.[recordingMbid];
  const tags = [...(entry?.tag?.recording ?? []), ...(entry?.tag?.artist ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    const name = (tag.tag ?? "").trim();
    if (name === "" || (tag.count ?? 0) < minCount || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** The similarity graph of the labs API — P09's "more like this". */
export async function similarArtists(
  ctx: SourceContext,
  artistMbid: string,
): Promise<CachedValue<readonly LbSimilarArtist[] | null>> {
  const algorithm =
    "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";
  return await cached<readonly LbSimilarArtist[]>(
    "listenbrainz",
    `similar-artists/${artistMbid}`,
    async () => {
      const search = new URLSearchParams({ artist_mbids: artistMbid, algorithm });
      const answer = await getJson<readonly LbSimilarArtist[]>({
        source: "listenbrainz",
        url: `${LISTENBRAINZ_LABS}/similar-artists/json?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 250,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.listenbrainz),
  );
}

export interface LbRecommendations {
  readonly payload?: {
    readonly mbids?: readonly { readonly recording_mbid?: string; readonly score?: number }[];
    readonly count?: number;
    readonly user_name?: string;
  };
}

/**
 * A user's raw recommendation list. **Stub for P09**: fetched, cached, and returned as it
 * came. Nothing in P04 reads it; it exists so that Discover inherits the limiter, the cache
 * and the error shape instead of growing its own HTTP layer.
 */
export async function recommendations(
  ctx: SourceContext,
  user: string,
  count = 100,
): Promise<CachedValue<LbRecommendations | null>> {
  return await cached<LbRecommendations>(
    "listenbrainz",
    `cf/recommendation/user/${user}/recording?count=${String(count)}`,
    async () => {
      const search = new URLSearchParams({ count: String(count) });
      const answer = await getJson<LbRecommendations>({
        source: "listenbrainz",
        url: `${LISTENBRAINZ_BASE}/cf/recommendation/user/${encodeURIComponent(user)}/recording?${search.toString()}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        minIntervalMs: 250,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.listenbrainz),
  );
}
