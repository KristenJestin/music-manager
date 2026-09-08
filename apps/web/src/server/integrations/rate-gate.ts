/**
 * One request per second for the **installation**, not for the process (decision 164).
 *
 * `http.ts` already spaced departures with a module-level `RateLimiter`, and that was correct
 * for one process and wrong for this application, which runs three at once: the web app (SSR
 * and server functions), the worker, and `mm` / the MCP session. Each held its own limiter, so
 * MusicBrainz saw two or three requests a second from one User-Agent and answered **503**.
 * From the wizard that surfaced as a full-screen *"Something went wrong! musicbrainz answered
 * HTTP 503."* — the incident of 2026-09-08.
 *
 * The gate below moves the reservation into Postgres, which every process already shares:
 *
 *  - **one round trip, then a local sleep.** `reserve` takes `pg_advisory_xact_lock` on the
 *    source, moves `source_rate_limit.next_free_at` forward by the interval and returns the
 *    slot it took. The caller sleeps until then in its own process. Nothing polls, nothing
 *    holds a lock while it waits, and a queue of ten callers costs ten short transactions
 *    rather than ten seconds of contention.
 *  - **`clock_timestamp()`, never `now()`.** `now()` is the transaction's start instant, which
 *    is frozen *before* the advisory lock is granted; two callers that queued on the lock
 *    would both read the same "now" and both take the same slot. `clock_timestamp()` reads the
 *    wall clock at statement time, after the wait.
 *  - **the server's clock decides.** The wait is computed from two values Postgres returned in
 *    the same statement, so the processes never have to agree on a clock of their own.
 *  - **`Retry-After` is installation-wide.** When any process is told to slow down, it calls
 *    `penalise`, which pushes `next_free_at` out for everyone. A 503 the worker collected is
 *    therefore a wait the Console honours too.
 *
 * It degrades rather than fails. A gate that cannot reach the database falls back to the
 * in-process limiter and logs once: being unable to coordinate is a reason to be careful, not
 * a reason to turn a metadata lookup into an error.
 */
import { sql } from "drizzle-orm";
import type { Database } from "#/server/db/client.ts";
import { limiterFor, sleep } from "./http.ts";

/**
 * What `getJson` needs from a limiter, whoever implements it.
 *
 * Two verbs, because a rate limit has two directions: what we promised to do (`acquire`) and
 * what the source has just told us to do (`penalise`).
 */
export interface RateGate {
  /** Take the next departure slot and wait for it. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** The source asked for a pause: no request may leave for `ms`, in any process. */
  penalise(ms: number): Promise<void>;
}

/** Never sleep longer than this on one acquisition, whatever the table says. */
const MAX_WAIT_MS = 60_000;

/** The in-process gate: `http.ts`'s own limiter, behind the `RateGate` shape. */
export function localGate(source: string, minIntervalMs: number): RateGate {
  const limiter = limiterFor(source, minIntervalMs);
  return {
    acquire: async (signal) => {
      await limiter.acquire(signal);
    },
    penalise: (ms) => {
      limiter.penalise(ms);
      return Promise.resolve();
    },
  };
}

interface Reservation {
  /** Milliseconds to wait before departing, as Postgres measured them. */
  readonly waitMs: number;
}

/**
 * The cross-process gate, over `source_rate_limit`.
 *
 * `local` is kept alongside it on purpose: it is the fallback when the database is
 * unreachable, and it is also a second, cheaper barrier inside this process — two coroutines
 * of the *same* process still queue locally before either opens a transaction.
 */
export function databaseGate(db: Database, source: string, minIntervalMs: number): RateGate {
  const local = limiterFor(source, minIntervalMs);
  let warned = false;

  const degrade = (error: unknown): null => {
    if (!warned) {
      warned = true;
      console.warn(
        `[rate-gate] ${source}: the shared limiter is unavailable, falling back to this process's own ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Other processes may now exceed ${String(minIntervalMs)} ms between requests.`,
      );
    }
    return null;
  };

  async function reserve(): Promise<Reservation | null> {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`mm:rate:${source}`})::bigint)`,
        );
        const rows = await tx.execute<{ wait_ms: string | number }>(sql`
          insert into source_rate_limit (source, next_free_at, updated_at)
          values (
            ${source},
            clock_timestamp() + make_interval(secs => ${minIntervalMs / 1000}),
            clock_timestamp()
          )
          on conflict (source) do update set
            next_free_at =
              greatest(source_rate_limit.next_free_at, clock_timestamp())
              + make_interval(secs => ${minIntervalMs / 1000}),
            updated_at = clock_timestamp()
          returning extract(
            epoch from (source_rate_limit.next_free_at
                        - make_interval(secs => ${minIntervalMs / 1000})
                        - clock_timestamp())
          ) * 1000 as wait_ms
        `);
        const raw = [...rows][0]?.wait_ms ?? 0;
        const waitMs = typeof raw === "number" ? raw : Number(raw);
        return { waitMs: Number.isFinite(waitMs) ? waitMs : 0 };
      });
    } catch (error) {
      return degrade(error);
    }
  }

  return {
    async acquire(signal) {
      if (minIntervalMs <= 0) return;
      // The local limiter first: it costs nothing, and it keeps this process's own concurrent
      // callers from opening N transactions that would all have to queue on the same lock.
      await local.acquire(signal);
      const slot = await reserve();
      if (slot === null) return; // degraded: the local limiter is the only rule left.
      const wait = Math.min(Math.max(0, slot.waitMs), MAX_WAIT_MS);
      if (wait > 0) await sleep(wait, signal);
    },

    async penalise(ms) {
      if (ms <= 0) return;
      local.penalise(ms);
      try {
        await db.execute(sql`
          insert into source_rate_limit (source, next_free_at, updated_at)
          values (
            ${source},
            clock_timestamp() + make_interval(secs => ${ms / 1000}),
            clock_timestamp()
          )
          on conflict (source) do update set
            next_free_at = greatest(
              source_rate_limit.next_free_at,
              clock_timestamp() + make_interval(secs => ${ms / 1000})
            ),
            updated_at = clock_timestamp()
        `);
      } catch (error) {
        degrade(error);
      }
    },
  };
}

/**
 * The gate a source client should use: shared when there is a database, local when there is
 * not.
 *
 * The cassette suite builds a `SourceContext` with `db: null as never` — it proves the clients
 * without a container — so the parameter is typed nullable here rather than pretending that
 * cannot happen. A missing database means "this process is alone", which is exactly what the
 * in-memory limiter already models.
 */
export function gateFor(
  db: Database | null | undefined,
  source: string,
  minIntervalMs: number,
): RateGate {
  if (db === null || db === undefined) return localGate(source, minIntervalMs);
  return databaseGate(db, source, minIntervalMs);
}
