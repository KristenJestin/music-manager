/**
 * P00's placeholder table, kept as it was.
 *
 * It exists so that a real migration existed before there was a real schema. P03 leaves it
 * alone rather than dropping another phase's table: it costs one row of DDL and it keeps
 * `drizzle/0000_*.sql` an honest description of what was shipped.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;

/**
 * One row per rate-limited source: **when the next request to it may leave the installation**
 * (decision 164).
 *
 * A single instant, not a token count, because the rule this table enforces is a minimum
 * interval rather than a burst allowance: MusicBrainz allows one request per second per
 * *client*, and "the client" is the installation, not the process. The web app, the worker
 * and `mm` each held their own in-memory limiter, so three of them together sent three
 * requests per second and MusicBrainz answered 503.
 *
 * `next_free_at` is written under `pg_advisory_xact_lock`, so a reservation is atomic across
 * processes; every reader then simply sleeps until its own slot. Nothing polls this table.
 *
 * Deliberately *not* a row of `app_meta`: `app_meta` is a string KV store and this is a
 * timestamp that two processes race on. A typed column is what makes `greatest(next_free_at,
 * clock_timestamp())` expressible in the one statement that has to be atomic.
 */
export const sourceRateLimit = pgTable("source_rate_limit", {
  /** The source name, exactly as `integrations/http.ts` keys its limiters: `musicbrainz`. */
  source: text("source").primaryKey(),
  /** The earliest instant at which the next request to this source may depart. */
  nextFreeAt: timestamp("next_free_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SourceRateLimit = typeof sourceRateLimit.$inferSelect;
