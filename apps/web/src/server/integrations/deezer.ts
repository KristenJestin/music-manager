/**
 * Deezer, public and keyless (`docs/03-metadonnees.md` §2.6, §4).
 *
 * Queried **by ISRC**, which is the entire reason it is trustworthy here: the ISRC comes from
 * MusicBrainz, so the join is exact and no fuzzy title matching is involved. What it gives
 * that nothing else free does: `explicit_lyrics` (→ `ITUNESADVISORY`) and `bpm` (→ `BPM`);
 * `gain` and `release_date` are read only as a cross-check, because ReplayGain comes from the
 * file we downloaded and the date from the release we chose.
 *
 * Deezer answers **HTTP 200 with an `error` body** for an unknown ISRC. That is not an
 * exception here: `fromDeezerTrack` already treats an `error` field as "no data", so the body
 * is cached as-is and the document simply carries no `BPM` and no `ITUNESADVISORY` — which is
 * precisely the acceptance case "Deezer unavailable → the document is still valid".
 */
import { MMError } from "@mm/contracts";
import type { DeezerTrack } from "@mm/domain";
import { cached, optionsFor, type CacheOptions, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const DEEZER_BASE = "https://api.deezer.com";

/** True when Deezer's 200 actually means "I have nothing". */
export function isDeezerMiss(track: DeezerTrack | null): boolean {
  return track === null || track.error !== undefined || track.id === undefined;
}

export async function byIsrc(
  ctx: SourceContext,
  isrc: string,
): Promise<CachedValue<DeezerTrack | null>> {
  const normalised = isrc.trim().toUpperCase().replace(/-/g, "");
  return await cached<DeezerTrack>(
    "deezer",
    `track/isrc:${normalised}`,
    async () => {
      const answer = await getJson<DeezerTrack>({
        source: "deezer",
        url: `${DEEZER_BASE}/track/isrc:${normalised}`,
        headers: { "user-agent": ctx.config.userAgent },
        nullOn404: true,
        // Deezer's public quota is 50 requests per 5 seconds; a tenth of a second between
        // calls keeps a fourteen-track album a long way under it.
        minIntervalMs: 100,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
      });
      return answer?.data ?? null;
    },
    optionsFor(ctx, ctx.config.ttlMs.deezer),
  );
}

/**
 * The first ISRC Deezer actually answers for.
 *
 * A recording often carries several ISRCs (one per territory or per re-issue) and Deezer only
 * knows some of them, so trying them in order is the difference between a BPM and no BPM.
 * Every attempt is cached, misses included, so the second run asks nothing.
 */
export async function firstKnownIsrc(
  ctx: SourceContext,
  isrcs: readonly string[],
): Promise<{ isrc: string; track: DeezerTrack; fetchedAt: string; fresh: boolean } | null> {
  for (const isrc of isrcs) {
    let answer;
    try {
      answer = await byIsrc(ctx, isrc);
    } catch (error) {
      // Offline, an ISRC nobody ever asked about is unknown, not fatal: try the next one.
      if (error instanceof MMError && error.code === "OFFLINE_CACHE_MISS") continue;
      throw error;
    }
    if (!isDeezerMiss(answer.data) && answer.data !== null) {
      return { isrc, track: answer.data, fetchedAt: answer.fetchedAt, fresh: answer.fresh };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* previews: the 30-second MP3 the Console plays                       */
/* ------------------------------------------------------------------ */

/**
 * A track as Deezer's *search* and *tracklist* endpoints describe it.
 *
 * A superset of `DeezerTrack` in practice, but a separate type on purpose: `DeezerTrack` is
 * the tagging resolver's view (BPM, explicit flag) and has no business growing a `preview`
 * field that only the player reads.
 */
export interface DeezerPreviewTrack {
  readonly id?: number;
  readonly title?: string;
  readonly title_short?: string;
  readonly duration?: number;
  readonly track_position?: number;
  readonly disk_number?: number;
  readonly rank?: number;
  /** The 30-second MP3. An empty string when Deezer has no preview for this track. */
  readonly preview?: string;
  readonly artist?: { readonly id?: number; readonly name?: string };
  readonly album?: {
    readonly id?: number;
    readonly title?: string;
    readonly cover_medium?: string;
  };
  readonly error?: { readonly type?: string; readonly message?: string };
}

export interface DeezerAlbumHit {
  readonly id?: number;
  readonly title?: string;
  readonly nb_tracks?: number;
  readonly cover_medium?: string;
  readonly artist?: { readonly id?: number; readonly name?: string };
}

export interface DeezerArtistHit {
  readonly id?: number;
  readonly name?: string;
  readonly picture_medium?: string;
}

interface DeezerList<T> {
  readonly data?: readonly T[];
  readonly total?: number;
  readonly error?: { readonly type?: string; readonly message?: string };
}

/**
 * How long a preview lookup stays good. **One hour, not the ninety days of `sourceTtlDays`.**
 *
 * A `preview` URL is signed and expiring: it carries `hdnea=exp=<unix>` and the CDN answers
 * 403 once that instant has passed — measured at roughly four hours after it was issued. The
 * ISRC lookups above cache a *fact* (this track has 122 BPM) and may be kept for a season; a
 * preview URL is a *ticket*, and a cached ticket is a silent dead player. So preview keys get
 * their own short TTL, and the search cost is still paid once per hour rather than per click.
 */
export const PREVIEW_TTL_MS = 3_600_000;

/** Deezer's public quota is 50 requests per 5 seconds; a tenth of a second is far under it. */
const MIN_INTERVAL_MS = 100;

function previewOptions(ctx: SourceContext): CacheOptions {
  return { ...optionsFor(ctx, PREVIEW_TTL_MS), ttlMs: PREVIEW_TTL_MS };
}

async function getList<T>(ctx: SourceContext, path: string): Promise<readonly T[]> {
  const answer = await getJson<DeezerList<T>>({
    source: "deezer",
    url: `${DEEZER_BASE}/${path}`,
    headers: { "user-agent": ctx.config.userAgent },
    nullOn404: true,
    minIntervalMs: MIN_INTERVAL_MS,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
  });
  const body = answer?.data;
  if (body === undefined || body.error !== undefined) return [];
  return body.data ?? [];
}

/**
 * Free-text track search.
 *
 * **Free text, not `artist:"…" track:"…"`.** Deezer documents an advanced syntax and it does
 * not survive a multi-word value: `artist:"Queen"` answers, `artist:"Daft Punk"` answers
 * `{"data":[],"total":0}`, and so does every encoding of the space we tried (`%20`, `+`, a
 * doubled escape). Verified against the live API on the day this was written. A plain
 * `q=<artist> <title>` returns the same records, ranked, so the discrimination moves to where
 * it can be inspected and tested: `bestTrackMatch` below scores the candidates on artist,
 * title and duration rather than trusting a query language that quietly answers "nothing".
 */
export async function searchTracks(
  ctx: SourceContext,
  query: string,
  limit = 10,
): Promise<CachedValue<readonly DeezerPreviewTrack[] | null>> {
  const clean = query.trim();
  return await cached<readonly DeezerPreviewTrack[]>(
    "deezer",
    `search/track:${clean.toLowerCase()}|${String(limit)}`,
    async () => {
      const hits = await getList<DeezerPreviewTrack>(
        ctx,
        `search?q=${encodeURIComponent(clean)}&limit=${String(limit)}`,
      );
      return hits.length === 0 ? null : hits;
    },
    previewOptions(ctx),
  );
}

export async function searchAlbums(
  ctx: SourceContext,
  query: string,
  limit = 5,
): Promise<CachedValue<readonly DeezerAlbumHit[] | null>> {
  const clean = query.trim();
  return await cached<readonly DeezerAlbumHit[]>(
    "deezer",
    `search/album:${clean.toLowerCase()}|${String(limit)}`,
    async () => {
      const hits = await getList<DeezerAlbumHit>(
        ctx,
        `search/album?q=${encodeURIComponent(clean)}&limit=${String(limit)}`,
      );
      return hits.length === 0 ? null : hits;
    },
    previewOptions(ctx),
  );
}

export async function searchArtists(
  ctx: SourceContext,
  query: string,
  limit = 5,
): Promise<CachedValue<readonly DeezerArtistHit[] | null>> {
  const clean = query.trim();
  return await cached<readonly DeezerArtistHit[]>(
    "deezer",
    `search/artist:${clean.toLowerCase()}|${String(limit)}`,
    async () => {
      const hits = await getList<DeezerArtistHit>(
        ctx,
        `search/artist?q=${encodeURIComponent(clean)}&limit=${String(limit)}`,
      );
      return hits.length === 0 ? null : hits;
    },
    previewOptions(ctx),
  );
}

/** `album/{id}/tracks` — the whole tracklist, each with its own preview. */
export async function albumTracks(
  ctx: SourceContext,
  albumId: number,
  limit = 60,
): Promise<CachedValue<readonly DeezerPreviewTrack[] | null>> {
  return await cached<readonly DeezerPreviewTrack[]>(
    "deezer",
    `album/${String(albumId)}/tracks|${String(limit)}`,
    async () => {
      const hits = await getList<DeezerPreviewTrack>(
        ctx,
        `album/${String(albumId)}/tracks?limit=${String(limit)}`,
      );
      return hits.length === 0 ? null : hits;
    },
    previewOptions(ctx),
  );
}

/** `artist/{id}/top` — what Deezer thinks this artist is known for. */
export async function artistTopTracks(
  ctx: SourceContext,
  artistId: number,
  limit = 10,
): Promise<CachedValue<readonly DeezerPreviewTrack[] | null>> {
  return await cached<readonly DeezerPreviewTrack[]>(
    "deezer",
    `artist/${String(artistId)}/top|${String(limit)}`,
    async () => {
      const hits = await getList<DeezerPreviewTrack>(
        ctx,
        `artist/${String(artistId)}/top?limit=${String(limit)}`,
      );
      return hits.length === 0 ? null : hits;
    },
    previewOptions(ctx),
  );
}
