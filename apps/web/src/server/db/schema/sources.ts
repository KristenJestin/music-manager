/**
 * Watched sources: a YouTube playlist or channel the installation keeps an eye on.
 *
 * The tables are named `watched_*` rather than `sources` on purpose. "Source" is already
 * taken twice in this codebase — `source_cache` holds the eight metadata providers of
 * `docs/03-metadonnees.md` §4, and `cron.refresh-sources` refreshes *them*. A third meaning
 * of the word in the schema would make every grep ambiguous.
 *
 * One source is a listing plus a policy. The listing is scanned flatly (`/extract?flat`),
 * diffed by video id against `watched_source_items`, and each genuinely new video becomes one
 * import. The policy is what the scan is allowed to do with it, and it is **off by default**:
 * `docs/04-pipeline-et-matching.md` § Ce que l'algo ne fait jamais says the algorithm never
 * chooses for you, and `autoAccept` is the one explicit, per-source, opt-in exception to that
 * — which is why it is a column on the source and not a setting, why turning it on is a
 * decision recorded per source, and why every import it waves through writes a `decisions`
 * row naming `watched-source` as the decider.
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { watchedItemStatusEnum, watchedScanStatusEnum, watchedSourceKindEnum } from "./enums.ts";
import { imports, type StoredError } from "./imports.ts";

export const watchedSources = pgTable(
  "watched_sources",
  {
    id: text("id").primaryKey(),
    /** The playlist or channel URL, as it was submitted. */
    url: text("url").notNull(),
    kind: watchedSourceKindEnum("kind").notNull(),
    /** What to call it in the Console. Defaults to whatever the first scan read off it. */
    label: text("label").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),

    /**
     * Confirm an import from this source without asking, when the match is unambiguous.
     *
     * **Default false, and it stays false unless somebody says otherwise per source.** The
     * gate is in `confirmStep`; this flag only opens the *possibility* of it opening.
     */
    autoAccept: boolean("auto_accept").notNull().default(false),
    /**
     * The score this source demands before auto-accepting, overriding `safeThreshold`.
     *
     * `null` is "use the installation's own threshold". A source of `- Topic` uploads can
     * afford the default; a source that mixes live sets and radio edits should be asked to
     * clear a higher bar, and that is a per-source judgement.
     */
    autoAcceptThreshold: doublePrecision("auto_accept_threshold"),

    /* ---- filters, applied to a new video before it becomes an import ---- */
    /** Seconds. A video shorter than this is skipped — trailers, teasers, shorts. */
    minDuration: integer("min_duration"),
    /** Seconds. A video longer than this is skipped — full concerts, mixes, podcasts. */
    maxDuration: integer("max_duration"),
    /**
     * Only import videos whose description carries the "Provided to YouTube by" block.
     *
     * That block is what a distributor writes on an official upload, so it is the cheapest
     * honest answer to "is this a record or a person talking?". It costs one full extraction
     * per new video, which is why it is a switch and not a rule.
     */
    requireProvidedToYouTube: boolean("require_provided_to_youtube").notNull().default(false),

    /* ---- what the last scan did ---- */
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    lastScanStatus: watchedScanStatusEnum("last_scan_status").notNull().default("never"),
    lastError: jsonb("last_error").$type<StoredError>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("watched_sources_url_idx").on(table.url),
    index("watched_sources_enabled_idx").on(table.enabled),
  ],
);

export const watchedSourceItems = pgTable(
  "watched_source_items",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => watchedSources.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    title: text("title").notNull().default(""),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The import this video opened. `set null`, not `cascade`: deleting an import must not
     * make the source forget it has already seen the video, or the next scan re-imports it.
     */
    importId: text("import_id").references(() => imports.id, { onDelete: "set null" }),
    status: watchedItemStatusEnum("status").notNull().default("new"),
    /** Why it was skipped or ignored, in one sentence the Console can print as-is. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * **The whole idempotence of the feature is this index.** A scan that runs twice, two
     * workers that overlap, a manual "Scan now" during the cron — all of them end in the same
     * insert, and the database is what refuses the second one. Nothing upstream has to be
     * careful.
     */
    uniqueIndex("watched_source_items_source_video_idx").on(table.sourceId, table.videoId),
    index("watched_source_items_status_idx").on(table.status),
    index("watched_source_items_import_idx").on(table.importId),
  ],
);

export const watchedSourcesRelations = relations(watchedSources, ({ many }) => ({
  items: many(watchedSourceItems),
}));

export const watchedSourceItemsRelations = relations(watchedSourceItems, ({ one }) => ({
  source: one(watchedSources, {
    fields: [watchedSourceItems.sourceId],
    references: [watchedSources.id],
  }),
  import: one(imports, { fields: [watchedSourceItems.importId], references: [imports.id] }),
}));

export type WatchedSource = typeof watchedSources.$inferSelect;
export type NewWatchedSource = typeof watchedSources.$inferInsert;
export type WatchedSourceItem = typeof watchedSourceItems.$inferSelect;
export type NewWatchedSourceItem = typeof watchedSourceItems.$inferInsert;
