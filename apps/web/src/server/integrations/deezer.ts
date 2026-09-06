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
import { cached, optionsFor, type CachedValue } from "./cached.ts";
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
