/**
 * The narrow door the matcher speaks to MusicBrainz through.
 *
 * Three methods, and two implementations behind them:
 *
 *  - `liveGateway` delegates to P04's `integrations/musicbrainz.ts`, so it inherits the
 *    one-request-per-second limiter, the User-Agent, the raw cache and the offline mode
 *    without knowing about any of them;
 *  - `cassetteGateway` answers from a recorded scenario, under the **same cache keys** the
 *    live one computes. It needs no database, no network and no Docker, which is what lets
 *    `mm match fixture://discovery` reproduce the acceptance table on a bare checkout — and
 *    what lets the service's own tests run in the unit suite rather than the integration one.
 *
 * Keeping the interface this small is the point. The matcher's whole relationship with the
 * outside world is "two searches and a handful of lookups", and stating that as three methods
 * makes the request budget something you can read off the type rather than audit for.
 */
import type { MbRecording, MbRelease } from "@mm/domain";
import {
  lookupRecording,
  lookupRelease,
  search,
  type MbSearchResult,
} from "#/server/integrations/musicbrainz.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import type { Cassette } from "#/server/services/matching.cassettes.ts";

export type SearchEntity = "release" | "recording" | "release-group";

export interface MbGateway {
  search(entity: SearchEntity, query: string, limit: number): Promise<MbSearchResult | null>;
  lookupRelease(mbid: string): Promise<MbRelease | null>;
  lookupRecording(mbid: string): Promise<MbRecording | null>;
  /** How many documents this gateway has been asked for. The budget test reads it. */
  readonly calls: { searches: number; lookups: number };
}

/** The real thing: P04's client, its limiter and its cache. */
export function liveGateway(ctx: SourceContext): MbGateway {
  const calls = { searches: 0, lookups: 0 };
  return {
    calls,
    async search(entity, query, limit) {
      calls.searches += 1;
      return (await search(ctx, entity, query, { limit })).data;
    },
    async lookupRelease(mbid) {
      calls.lookups += 1;
      return (await lookupRelease(ctx, mbid)).data;
    },
    async lookupRecording(mbid) {
      calls.lookups += 1;
      return (await lookupRecording(ctx, mbid)).data;
    },
  };
}

/**
 * A recorded scenario, replayed.
 *
 * A key that is not on the cassette is an **error**, deliberately. A gateway that quietly
 * answered `null` would let the matcher change which documents it asks for without any test
 * noticing, and the cassette would silently stop being a recording of the algorithm. Missing
 * a key means either the cassette is stale or the request pattern changed; both are things
 * somebody has to look at.
 */
export function cassetteGateway(cassette: Cassette): MbGateway {
  const byKey = new Map(cassette.entries.map((entry) => [entry.key, entry.payload]));
  const calls = { searches: 0, lookups: 0 };

  /**
   * Rejects rather than throwing synchronously: a method that returns a promise has to fail
   * through that promise, or the caller's `await` cannot catch it.
   */
  function take<T>(key: string): Promise<T> {
    if (!byKey.has(key)) {
      return Promise.reject(
        new Error(
          `cassette "${cassette.name}" has no document for "${key}". ` +
            "Re-record it with `bun run scripts/record-matching-cassettes.ts`.",
        ),
      );
    }
    return Promise.resolve(byKey.get(key) as T);
  }

  return {
    calls,
    search(entity, query, limit) {
      calls.searches += 1;
      return take<MbSearchResult>(
        `search/${entity}?query=${query}&limit=${String(limit)}&offset=0`,
      );
    },
    lookupRelease(mbid) {
      calls.lookups += 1;
      return take<MbRelease>(`release/${mbid}?inc=releaseFull`);
    },
    lookupRecording(mbid) {
      calls.lookups += 1;
      return take<MbRecording>(`recording/${mbid}?inc=recordingFull`);
    },
  };
}
