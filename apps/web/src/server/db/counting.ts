/**
 * A `Database` that counts the rows it hands back, per table.
 *
 * Every Drizzle query on `postgres-js` goes through `client.unsafe(text, params)` — see
 * `drizzle-orm/postgres-js/session.js` — so wrapping that one method sees the real SQL and the
 * real result of every statement, whatever builder produced it. Nothing else in the driver is
 * touched, so the counted client behaves exactly like the ordinary one.
 *
 * It exists for the tests that guard the two loaders this repository has already had to fix
 * twice: a comment saying "do not read every document here" is not a guard, and neither is a
 * timing assertion. Counting the rows a loader actually reads is.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";
import type { Database } from "./client.ts";

export interface QueryRecord {
  readonly sql: string;
  readonly rows: number;
}

export interface CountingDatabase {
  readonly db: Database;
  /** Every statement executed since the last `reset()`, in order. */
  readonly queries: readonly QueryRecord[];
  /** Rows returned by statements whose text mentions `table`. */
  rowsFrom(table: string): number;
  reset(): void;
  close(): Promise<void>;
}

export function countingDatabase(url: string): CountingDatabase {
  const client = postgres(url, { max: 4, onnotice: () => undefined });
  const queries: QueryRecord[] = [];

  const unsafe = client.unsafe.bind(client);
  /*
   * `unsafe` returns a thenable query object, not a promise, and Drizzle sometimes chains
   * `.values()` onto it. Returning the original object and recording in a `then` handler would
   * break that chain, so the count is taken by patching the object's own `then`.
   */
  const counting = ((text: string, params?: unknown[], options?: unknown) => {
    const query = unsafe(text, params as never, options as never);
    const originalThen = query.then.bind(query);
    query.then = ((onFulfilled: never, onRejected: never) =>
      originalThen((result: unknown) => {
        queries.push({ sql: text, rows: Array.isArray(result) ? result.length : 0 });
        return (onFulfilled as unknown as ((value: unknown) => unknown) | undefined)?.(result);
      }, onRejected)) as typeof query.then;
    return query;
  }) as typeof client.unsafe;

  const patched = Object.assign(client, { unsafe: counting });
  const db = drizzle(patched, { schema }) as unknown as Database;

  return {
    db,
    queries,
    rowsFrom(table: string): number {
      return queries
        .filter((query) => query.sql.includes(`"${table}"`))
        .reduce((total, query) => total + query.rows, 0);
    },
    reset(): void {
      queries.length = 0;
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}
