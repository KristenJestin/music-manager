/**
 * The raw source cache — layer 1 of `docs/03-metadonnees.md` §1.
 *
 * "Chaque réponse de source est stockée telle quelle […] On ne jette rien." So this module
 * has no eviction, no TTL and no purge: it stores what a source answered, verbatim, with the
 * instant it was fetched. Everything downstream — the document, the completeness score, the
 * background re-tag of §8 — is recomputable from it without touching the network, which is
 * the whole reason decision 022 exists.
 *
 * `getOrFetch` is therefore not a performance trick. It is the rule that a source is called
 * at most once for a given key, ever, unless someone explicitly asks for a refresh.
 */
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { sourceCache } from "#/server/db/schema/index.ts";

export interface CacheEntry<T> {
  readonly data: T;
  /** ISO-8601, the stamp every resolver copies onto the fields it produces. */
  readonly fetchedAt: string;
  readonly etag: string | null;
  /** False when the value came out of the database rather than from the source. */
  readonly fresh: boolean;
}

export interface FetchResult<T> {
  readonly data: T;
  readonly etag?: string | null;
}

/** Read one entry, or `null`. */
export async function get<T>(
  source: string,
  key: string,
  db: Database = defaultDb(),
): Promise<CacheEntry<T> | null> {
  const [row] = await db
    .select()
    .from(sourceCache)
    .where(and(eq(sourceCache.source, source), eq(sourceCache.key, key)))
    .limit(1);
  if (row === undefined) return null;
  return {
    data: row.payload as T,
    fetchedAt: row.fetchedAt.toISOString(),
    etag: row.etag,
    fresh: false,
  };
}

/** Write one entry, replacing whatever was there. */
export async function put<T>(
  source: string,
  key: string,
  data: T,
  options: { etag?: string | null; fetchedAt?: Date; db?: Database } = {},
): Promise<CacheEntry<T>> {
  const db = options.db ?? defaultDb();
  const fetchedAt = options.fetchedAt ?? new Date();
  await db
    .insert(sourceCache)
    .values({
      source,
      key,
      payload: data as never,
      etag: options.etag ?? null,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: [sourceCache.source, sourceCache.key],
      set: { payload: data as never, etag: options.etag ?? null, fetchedAt },
    });
  return { data, fetchedAt: fetchedAt.toISOString(), etag: options.etag ?? null, fresh: true };
}

/**
 * The one accessor the rest of the app uses: return the cached response, or call `fetcher`
 * once and keep what it answered.
 *
 * `refresh` forces the call and overwrites the row — the "revalidate" of P04, and the only
 * way a stored response is ever replaced.
 */
export async function getOrFetch<T>(
  source: string,
  key: string,
  fetcher: () => Promise<T | FetchResult<T>>,
  options: { refresh?: boolean; db?: Database } = {},
): Promise<CacheEntry<T>> {
  const db = options.db ?? defaultDb();
  if (options.refresh !== true) {
    const hit = await get<T>(source, key, db);
    if (hit !== null) return hit;
  }
  const answered = await fetcher();
  const { data, etag } = isFetchResult<T>(answered)
    ? { data: answered.data, etag: answered.etag ?? null }
    : { data: answered, etag: null };
  return await put(source, key, data, { etag, db });
}

function isFetchResult<T>(value: T | FetchResult<T>): value is FetchResult<T> {
  return typeof value === "object" && value !== null && "data" in value && !Array.isArray(value);
}

/** Delete one entry. Exists for the tests and for a future "re-fetch this" button. */
export async function forget(
  source: string,
  key: string,
  db: Database = defaultDb(),
): Promise<void> {
  await db.delete(sourceCache).where(and(eq(sourceCache.source, source), eq(sourceCache.key, key)));
}
