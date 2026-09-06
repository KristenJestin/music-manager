/**
 * Discover (`docs/phases/P09-discover.md`, `docs/05-recommandations.md`).
 *
 * Three tables, because a recommendation has three lifetimes and mixing them would lose one:
 *
 *  - `discover_items` is the **current** proposal set. A sync rewrites it; nothing here is
 *    history, and every row is keyed by `(kind, subject)` so the second sync updates the row
 *    the first one wrote instead of piling a duplicate on top of it.
 *  - `discover_dismissals` is the **memory**, and it is deliberately a separate table from the
 *    items: "not interested" has to survive a sync that no longer proposes the thing at all,
 *    and it has to be consultable *before* an item is written. Storing it as a status on the
 *    item would make it exactly as durable as the proposal — which is to say, not at all.
 *  - `discover_syncs` is the **run log**, and it carries the listening-signals snapshot the
 *    page's top strip renders. The signals are a fact about a moment (play counts on a sliding
 *    window), so they belong to the run that observed them rather than to a mutable row.
 *
 * `subject` is the stable identity of a proposal across syncs — `release-group:<mbid>`,
 * `recording:<mbid>`, `artist:<mbid>`. It is a string rather than three nullable MBID columns
 * because it is used as a key (dismissals, upserts), and a key made of three nullable columns
 * is a key you get wrong once.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The three blocks of the Discover page, in the order it shows them. */
export const DISCOVER_KINDS = ["discography", "recommendation", "similar_artist"] as const;
export type DiscoverKind = (typeof DISCOVER_KINDS)[number];
export const discoverKindEnum = pgEnum("discover_kind", DISCOVER_KINDS);

/**
 * Where one proposal stands.
 *
 * `later` is on the item and not in the dismissal table on purpose: it means "keep proposing
 * it, just not at the top", so it is a property of the current set, not a memory.
 */
export const DISCOVER_STATUSES = ["open", "later", "imported"] as const;
export type DiscoverStatus = (typeof DISCOVER_STATUSES)[number];
export const discoverStatusEnum = pgEnum("discover_status", DISCOVER_STATUSES);

export const discoverItems = pgTable(
  "discover_items",
  {
    id: text("id").primaryKey(),
    kind: discoverKindEnum("kind").notNull(),
    status: discoverStatusEnum("status").notNull().default("open"),
    /** `release-group:<mbid>`, `recording:<mbid>`, `artist:<mbid>` — stable across syncs. */
    subject: text("subject").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    /** The album a recommended *track* sits on. Null for an album or an artist. */
    albumTitle: text("album_title"),
    artistMbid: text("artist_mbid"),
    releaseGroupMbid: text("release_group_mbid"),
    recordingMbid: text("recording_mbid"),
    year: integer("year"),
    /** MusicBrainz `primary-type`: Album, EP, Single, Broadcast, Other. */
    primaryType: text("primary_type"),
    /** MusicBrainz `secondary-types`: Live, Compilation, Soundtrack, Remix… */
    secondaryTypes: jsonb("secondary_types").$type<string[]>().notNull().default([]),
    score: doublePrecision("score").notNull().default(0),
    /** Why this is here, in words a person reads. Decision 002: it explains, never chooses. */
    reason: text("reason").notNull(),
    /** `ListenBrainz collaborative filtering`, `Last.fm (fallback)`, `Your library`… */
    source: text("source").notNull(),
    inLibrary: boolean("in_library").notNull().default(false),
    /** The per-kind extras: `have`/`total` for a gap, `similarTo` for an artist, the factors. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** The `discover_syncs` run that last wrote this row. */
    syncId: text("sync_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("discover_items_subject_idx").on(table.kind, table.subject),
    index("discover_items_kind_score_idx").on(table.kind, table.score),
    index("discover_items_sync_idx").on(table.syncId),
  ],
);

/**
 * "Not interested", remembered.
 *
 * One row per subject, written when the button is pressed and read by every later sync before
 * an item is inserted — which is what makes the acceptance criterion ("it does not come back
 * after `sync`") a property of the data rather than of the order two services happen to run in.
 */
export const discoverDismissals = pgTable(
  "discover_dismissals",
  {
    subject: text("subject").primaryKey(),
    kind: discoverKindEnum("kind").notNull(),
    /** What it was, so Settings can list what you have hidden without re-syncing. */
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("discover_dismissals_kind_idx").on(table.kind)],
);

export const discoverSyncs = pgTable("discover_syncs", {
  id: text("id").primaryKey(),
  trigger: text("trigger").notNull().default("manual"),
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  discographyCount: integer("discography_count").notNull().default(0),
  recommendationCount: integer("recommendation_count").notNull().default(0),
  similarArtistCount: integer("similar_artist_count").notNull().default(0),
  /** The `ListeningSignals` snapshot of `server/services/signals.ts`, as observed. */
  signals: jsonb("signals").$type<Record<string, unknown>>(),
  error: text("error"),
});

export type DiscoverItem = typeof discoverItems.$inferSelect;
export type NewDiscoverItem = typeof discoverItems.$inferInsert;
export type DiscoverDismissal = typeof discoverDismissals.$inferSelect;
export type DiscoverSync = typeof discoverSyncs.$inferSelect;
