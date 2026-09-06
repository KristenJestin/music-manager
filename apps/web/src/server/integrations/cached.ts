/**
 * The rule that every source call obeys: go through the raw cache (§1), or not at all.
 *
 * `cache.service` of P03 has no expiry on purpose — "on ne jette rien" — and this module does
 * not change that. It adds the two things P04 needs on top of a store that never forgets:
 *
 *  - **a TTL per source**, which is a *revalidation* policy, not an eviction one. Past the
 *    age, the row is overwritten with a fresh answer; it is never deleted, and offline it is
 *    still served, stale, because a stale document beats no document.
 *  - **offline mode**, where a key that is not in the cache is an error rather than a request.
 *    That is what `mm doc rebuild --offline` and the background re-tag of §8 need: a promise
 *    that no byte leaves the machine, provable by the request counter.
 *
 * An absence is cached too. "The Cover Art Archive has nothing for this release" is a fact
 * worth remembering; re-asking every rebuild would be both slower and ruder.
 */
import { MMError } from "@mm/contracts";
import type { Database } from "#/server/db/client.ts";
import { get as cacheGet, put as cachePut } from "#/server/services/cache.ts";
import type { SourceContext } from "./config.ts";

/**
 * Where cached bodies live.
 *
 * Postgres in production, a `Map` in the tests. The indirection exists for one reason: the
 * cassette suite exercises the **real clients** — the real URLs, the real limiter, the real
 * retry policy — and a client should not need a database container to prove it parses a
 * MusicBrainz release correctly.
 */
export interface CacheStore {
  get(source: string, key: string): Promise<{ data: unknown; fetchedAt: string } | null>;
  put(source: string, key: string, payload: unknown): Promise<{ fetchedAt: string }>;
}

export function databaseStore(db: Database): CacheStore {
  return {
    async get(source, key) {
      const hit = await cacheGet<unknown>(source, key, db);
      return hit === null ? null : { data: hit.data, fetchedAt: hit.fetchedAt };
    },
    async put(source, key, payload) {
      const stored = await cachePut(source, key, payload, { db });
      return { fetchedAt: stored.fetchedAt };
    },
  };
}

/** An in-memory store. `seed` pre-fills it, which is how the offline tests are written. */
export function memoryStore(
  seed: Iterable<[string, unknown]> = [],
  clock: () => Date = () => new Date(),
): CacheStore & { readonly rows: Map<string, { data: unknown; fetchedAt: string }> } {
  const rows = new Map<string, { data: unknown; fetchedAt: string }>();
  for (const [id, data] of seed) rows.set(id, { data, fetchedAt: clock().toISOString() });
  return {
    rows,
    get(source, key) {
      return Promise.resolve(rows.get(`${source} ${key}`) ?? null);
    },
    put(source, key, payload) {
      const fetchedAt = clock().toISOString();
      rows.set(`${source} ${key}`, { data: payload, fetchedAt });
      return Promise.resolve({ fetchedAt });
    },
  };
}

/** What a source answered, and when — the shape the resolvers stamp onto every field. */
export interface CachedValue<T> {
  readonly data: T;
  readonly fetchedAt: string;
  /** False when it came out of the database rather than off the wire. */
  readonly fresh: boolean;
  /** True when the cached answer is past its TTL and could not be refreshed. */
  readonly stale: boolean;
}

/** The marker stored in place of a body when a source says "there is nothing here". */
const ABSENT = "mm:absent";

interface AbsentPayload {
  readonly [ABSENT]: true;
  readonly reason: string;
}

function isAbsent(payload: unknown): payload is AbsentPayload {
  return typeof payload === "object" && payload !== null && ABSENT in payload;
}

/** The payload that means "asked, and the source had nothing". Used by the fixture seeder. */
export function absentPayload(reason = "the source has no such entry"): AbsentPayload {
  return { [ABSENT]: true, reason };
}

export interface CacheOptions {
  readonly store: CacheStore;
  /** No request may leave the process; a cache miss throws. */
  readonly offline: boolean;
  /** Milliseconds after which a stored answer is refreshed. 0 means "never expires". */
  readonly ttlMs?: number;
  /** Refetch and overwrite even when the row is young. `mm doc build --refresh`. */
  readonly refresh?: boolean;
}

/** The cache options a client call uses: the context's store, its offline flag, its TTL. */
export function optionsFor(ctx: SourceContext, ttlMs: number): CacheOptions {
  return {
    store: ctx.store ?? databaseStore(ctx.db),
    offline: ctx.offline,
    ttlMs,
    refresh: ctx.refresh,
  };
}

/**
 * Read `(source, key)` out of the cache, or call `fetcher` once and keep what it answered.
 *
 * `fetcher` returns `null` to mean "the source has nothing for this key"; the absence is
 * stored and later reads get `data: null` without a request.
 */
export async function cached<T>(
  source: string,
  key: string,
  fetcher: () => Promise<T | null>,
  options: CacheOptions,
): Promise<CachedValue<T | null>> {
  const hit = await options.store.get(source, key);
  const ttl = options.ttlMs ?? 0;
  const age = hit === null ? Infinity : Date.now() - Date.parse(hit.fetchedAt);
  const expired = ttl > 0 && age > ttl;

  if (hit !== null && !expired && options.refresh !== true) {
    return unwrap<T>(hit.data, hit.fetchedAt, false, false);
  }

  if (options.offline) {
    // Stale beats absent: offline, an old answer is the best answer there is.
    if (hit !== null) return unwrap<T>(hit.data, hit.fetchedAt, false, expired);
    throw offlineMiss(source, key);
  }

  const answered = await fetcher();
  const payload: unknown = answered === null ? absentPayload() : answered;
  const stored = await options.store.put(source, key, payload);
  return { data: answered, fetchedAt: stored.fetchedAt, fresh: true, stale: false };
}

function unwrap<T>(
  payload: unknown,
  fetchedAt: string,
  fresh: boolean,
  stale: boolean,
): CachedValue<T | null> {
  return { data: isAbsent(payload) ? null : (payload as T), fetchedAt, fresh, stale };
}

/** True when the cache already holds this key. Used by `doc show` and the offline reports. */
export async function isCached(source: string, key: string, store: CacheStore): Promise<boolean> {
  return (await store.get(source, key)) !== null;
}

export function offlineMiss(source: string, key: string): MMError {
  return new MMError("OFFLINE_CACHE_MISS", `Offline: ${source} "${key}" has never been fetched.`, {
    hint: "Run the same command without --offline once, or `bun run cache:seed-fixtures` for the recorded set.",
    action: "Fetch it once",
    details: { source, key },
  });
}
