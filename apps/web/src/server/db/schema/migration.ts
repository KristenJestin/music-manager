/**
 * The v1 → v2 migration's memory (`docs/phases/P11-migration-v1.md` § Commande).
 *
 * A migration of somebody's whole library is not a transaction: it walks thousands of rows,
 * probes thousands of files, writes tags into them, and will be interrupted — by a full disk,
 * by a reboot, by somebody pressing Ctrl-C because dinner is ready. So the state lives in the
 * database, one row per v1 song, and every run is a resume of the previous one.
 *
 *  - `migration_v1_runs`  one invocation: dry run or real, its counters, its JSON report;
 *  - `migration_v1`       one v1 song, keyed by `(v1_song_id)`, with what became of it.
 *
 * The idempotence key of P11 is "the v1 song id **and** the file path": the id says which row
 * we are talking about, the path says which file it claimed at the time. A second run over an
 * unchanged library therefore has nothing to do — which is the acceptance criterion — while a
 * v1 row whose file has since moved is noticed rather than silently re-migrated on top of the
 * wrong file.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { StoredError } from "./imports.ts";

/**
 * What the inventory decided one v1 row is.
 *
 * The five values are the classification of P11 § Étapes 1: a `Present` row whose file is
 * really there is the only one that becomes a library track; a `Present` row whose file is
 * gone and every non-`Present` status alike become a v2 import, because in both cases the
 * audio has to come from the network and nothing else can produce it.
 */
export const MIGRATION_CLASSES = [
  /** `Present` and the file is on disk: re-tag it in place. */
  "present_with_file",
  /** `Present` but the file is not where `FinalFilePath` says: an import. */
  "present_missing_file",
  /** `Needed` — never downloaded. */
  "needed",
  /** `NeedsManualReview` — v1 could not decide; it arrives in v2 as `awaiting_review`. */
  "needs_manual_review",
  /** Any of the `*Failed` statuses. */
  "failed",
] as const;
export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

/** What actually happened to the row. `planned` is what a dry run leaves behind — nowhere. */
export const MIGRATION_OUTCOMES = [
  "planned",
  "migrated",
  "import_created",
  "playlist_only",
  "skipped",
  "failed",
] as const;
export type MigrationOutcome = (typeof MIGRATION_OUTCOMES)[number];

/** How the file on disk was tied back to the v1 row (P11 § Étapes 1). */
export const MIGRATION_MATCHES = ["path", "recording_mbid", "youtube_id", "none"] as const;
export type MigrationMatch = (typeof MIGRATION_MATCHES)[number];

export const migrationV1Runs = pgTable(
  "migration_v1_runs",
  {
    id: text("id").primaryKey(),
    /** `cli`, `console`, `worker` — who asked. */
    trigger: text("trigger").notNull().default("cli"),
    /** `pending`, `running`, `done`, `failed`, `cancelled`. */
    status: text("status").notNull().default("pending"),
    /** A dry run reads everything and writes nothing outside these two tables. */
    dryRun: boolean("dry_run").notNull().default(false),
    /** Apply the v2 path template instead of keeping the v1 paths (§ Étapes 3). */
    renameToTemplate: boolean("rename_to_template").notNull().default(false),
    /**
     * The v1 library root, as this process saw it. Stored so the report can be read months
     * later and still say which directory it was about.
     */
    libraryPath: text("library_path").notNull().default(""),
    /**
     * The v1 connection **without its password**. A connection string is a secret; the report
     * is a document somebody pastes into a ticket.
     */
    dbLabel: text("db_label").notNull().default(""),
    limit: integer("limit"),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    migrated: integer("migrated").notNull().default(0),
    importsCreated: integer("imports_created").notNull().default(0),
    orphanFiles: integer("orphan_files").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /**
     * Rows written outside these two tables. A dry run asserts this is zero — the spec asks
     * for a write counter rather than for trust (§ Sécurité).
     */
    writes: integer("writes").notNull().default(0),
    durationMs: integer("duration_ms"),
    message: text("message"),
    error: jsonb("error").$type<StoredError>(),
    /** The `MigrationReport` of `src/server/migration/v1/report.ts`. */
    report: jsonb("report").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("migration_v1_runs_status_idx").on(table.status),
    index("migration_v1_runs_created_at_idx").on(table.createdAt),
  ],
);

export const migrationV1 = pgTable(
  "migration_v1",
  {
    id: text("id").primaryKey(),
    /** The last run that touched this row. Not a foreign key to a *first* run: rows outlive runs. */
    runId: text("run_id"),
    /** `Songs.Id` in the v1 database — the idempotence key. */
    v1SongId: text("v1_song_id").notNull(),
    /** `Songs.FinalFilePath`, verbatim, as v1 stored it. */
    v1Path: text("v1_path"),
    /** Library-relative path in v2, with forward slashes. The other half of the key. */
    path: text("path"),
    classification: text("classification").$type<MigrationClass>().notNull(),
    outcome: text("outcome").$type<MigrationOutcome>().notNull().default("planned"),
    matchedBy: text("matched_by").$type<MigrationMatch>().notNull().default("none"),
    libraryAlbumId: text("library_album_id"),
    libraryTrackId: text("library_track_id"),
    documentId: text("document_id"),
    importId: text("import_id"),
    importTrackId: text("import_track_id"),
    /** Set only by `--rename-to-template`, so the rename report can be replayed. */
    renamedFrom: text("renamed_from"),
    /** Everything the report wants to show about this row: v1 title, discrepancies, counts. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    error: jsonb("error").$type<StoredError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("migration_v1_song_idx").on(table.v1SongId),
    index("migration_v1_run_idx").on(table.runId),
    index("migration_v1_outcome_idx").on(table.outcome),
    index("migration_v1_path_idx").on(table.path),
  ],
);

export type MigrationRun = typeof migrationV1Runs.$inferSelect;
export type NewMigrationRun = typeof migrationV1Runs.$inferInsert;
export type MigrationRow = typeof migrationV1.$inferSelect;
export type NewMigrationRow = typeof migrationV1.$inferInsert;
