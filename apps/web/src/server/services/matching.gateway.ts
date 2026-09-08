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
  MUSICBRAINZ_BASE,
  lookupRecording,
  lookupRelease,
  search,
  type MbSearchResult,
} from "#/server/integrations/musicbrainz.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import { sourceHttpError } from "#/server/integrations/http.ts";
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
      /*
       * `recordingBorrow`, not `recordingFull`: the matcher looks a recording up in order to
       * learn **which releases it is on**, and the default preset carries none. See the preset
       * in `integrations/musicbrainz.ts` — this was the whole reason a single's borrow ladder
       * was ranking release stubs with no release group live, while the cassettes had the
       * groups all along (DRIVE-FIX-1).
       */
      return (await lookupRecording(ctx, mbid, "recordingBorrow")).data;
    },
  };
}

/** What a gateway tells the outside world while it works. See `match-progress.ts`. */
export type GatewayReporter = (
  phase: "searching" | "looking-up",
  label: string,
  done: { searches: number; lookups: number },
) => void;

/**
 * A gateway that says what it is about to do.
 *
 * Wrapped rather than built in, so the counting stays in one place and neither implementation
 * has to know that anybody is watching. It reports **before** each call, not after: at one
 * request per second the interesting second is the one being spent, and a progress line that
 * only appears once the answer is back is a progress line that is always a step behind.
 */
export function reportingGateway(inner: MbGateway, report: GatewayReporter): MbGateway {
  return {
    get calls() {
      return inner.calls;
    },
    async search(entity, query, limit) {
      report("searching", `Searching MusicBrainz for a ${entity.replace("-", " ")}…`, inner.calls);
      return await inner.search(entity, query, limit);
    },
    async lookupRelease(mbid) {
      report("looking-up", "Reading a release's tracklist…", inner.calls);
      return await inner.lookupRelease(mbid);
    },
    async lookupRecording(mbid) {
      report("looking-up", "Reading a recording's releases…", inner.calls);
      return await inner.lookupRecording(mbid);
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
      return take<MbRecording>(`recording/${mbid}?inc=recordingBorrow`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* the outage, on purpose                                              */
/* ------------------------------------------------------------------ */

/**
 * How many refusals each simulated outage still owes, keyed by the fixture URL that armed it.
 *
 * The outage is **exhaustible by construction**: it refuses a fixed number of times and then
 * gets out of the way, because the thing worth proving is not that a 503 can be produced — it
 * is that Retry puts the page back. A permanent outage would prove the first half and hide the
 * second.
 *
 * The count is what separates the wizard's two degraded states, and both are worth driving:
 *
 *  - **one** refusal: the live ranking fails, the *offline* one that `fetchCandidates` falls
 *    back to reads the cache and succeeds, and step 2 shows its candidates under "these came
 *    from the cache";
 *  - **two**: both attempts fail, and step 2 shows "MusicBrainz is unavailable — retry" with
 *    the wizard, the URL and the chosen release all still in place.
 */
const outagesOwed = new Map<string, number>();

/** Forget the armed outages. The E2E starts from a clean database; a unit test does not. */
export function resetOutages(): void {
  outagesOwed.clear();
}

/**
 * A gateway that answers one request with a real source failure, then steps aside.
 *
 * This is the offline reproduction of the incident of 2026-09-08: MusicBrainz answered 503
 * mid-import and the whole Console was replaced by the message. `fixture://discovery?mb=503`
 * is the same shape as the toolbox's own `fixture://discovery?fp=mismatch` — a recorded
 * scenario carrying the fault it is meant to exercise — so `e2e/mb-outage.spec.ts` can drive
 * it with no network, no stub server and no mock inside the app.
 *
 * The error is built by `integrations/http.ts` itself, so the code, the hint, the action and
 * the status are byte-for-byte the ones a real 503 produces; there is nothing here for the
 * error screen to accidentally special-case.
 */
export function outageGateway(
  inner: MbGateway,
  key: string,
  status: number,
  times: number,
): MbGateway {
  if (!outagesOwed.has(key)) outagesOwed.set(key, times);

  const armed = (): boolean => (outagesOwed.get(key) ?? 0) > 0;
  const fail = <T>(): Promise<T> => {
    outagesOwed.set(key, (outagesOwed.get(key) ?? 1) - 1);
    return Promise.reject(
      sourceHttpError("musicbrainz", `${MUSICBRAINZ_BASE}/release`, status, true),
    );
  };

  return {
    get calls() {
      return inner.calls;
    },
    async search(entity, query, limit) {
      if (armed()) return await fail<MbSearchResult | null>();
      return await inner.search(entity, query, limit);
    },
    async lookupRelease(mbid) {
      if (armed()) return await fail<MbRelease | null>();
      return await inner.lookupRelease(mbid);
    },
    async lookupRecording(mbid) {
      if (armed()) return await fail<MbRecording | null>();
      return await inner.lookupRecording(mbid);
    },
  };
}
