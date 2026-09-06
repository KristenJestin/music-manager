/**
 * The background re-tag of `docs/03-metadonnees.md` §8, persisted.
 *
 * A re-tag is not a fire-and-forget job: §8 promises **a visible diff per file before it is
 * written**, and a promise like that needs somewhere to keep the diff. So a run is a row, and
 * every file it looked at is a row too.
 *
 *  - `retag_runs`  one invocation — a dry run or a real one, over the library, one album or
 *                  one track. It carries its own counters so the Console can show progress
 *                  without counting children on every poll.
 *  - `retag_diffs` one file: the tags the new projection adds, removes and changes against
 *                  what is actually embedded in the file right now (read back through the
 *                  toolbox's `/probe`). A dry run stops here; a real run writes and flips
 *                  `wrote`.
 *
 * Keeping the diffs of a dry run is the whole point: you look at them, and *then* you press
 * the button. The run they belong to is re-run for real rather than "applied", because
 * between the two the raw cache may have grown — and re-projecting is free.
 */
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { StoredError } from "./imports.ts";
import { libraryAlbums, libraryTracks } from "./library.ts";

/** What a run covers. `library` is everything behind the current schema. */
export const RETAG_SCOPES = ["library", "album", "track"] as const;
export type RetagScope = (typeof RETAG_SCOPES)[number];
export const retagScopeEnum = pgEnum("retag_scope", RETAG_SCOPES);

/** Why a run was started (§8: a schema bump, a refreshed source, or a person). */
export const RETAG_TRIGGERS = ["manual", "schema", "sources", "cron"] as const;
export type RetagTrigger = (typeof RETAG_TRIGGERS)[number];
export const retagTriggerEnum = pgEnum("retag_trigger", RETAG_TRIGGERS);

/** Where a run is. `cancelled` is a person pressing stop, not a failure. */
export const RETAG_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type RetagStatus = (typeof RETAG_STATUSES)[number];
export const retagStatusEnum = pgEnum("retag_status", RETAG_STATUSES);

export const retagRuns = pgTable(
  "retag_runs",
  {
    id: text("id").primaryKey(),
    scope: retagScopeEnum("scope").notNull().default("library"),
    /** The album or library-track id a scoped run targets. Null for `library`. */
    targetId: text("target_id"),
    trigger: retagTriggerEnum("trigger").notNull().default("manual"),
    /** A dry run reads the files and writes rows, and touches nothing on disk. */
    dryRun: boolean("dry_run").notNull().default(false),
    status: retagStatusEnum("status").notNull().default("pending"),
    /** The tag schema version this run projects to. Stamped on every file it writes. */
    schemaVersion: integer("schema_version").notNull(),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    /** Files whose projection actually differed from what was in them. */
    changed: integer("changed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    message: text("message"),
    error: jsonb("error").$type<StoredError>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("retag_runs_status_idx").on(table.status),
    index("retag_runs_created_at_idx").on(table.createdAt),
  ],
);

/** One projected tag line, as a diff shows it. */
export interface RetagTagChange {
  readonly key: string;
  /** The tag-map field the key came from — so the UI can say *why* it changed. */
  readonly field?: string;
  readonly before?: string;
  readonly after?: string;
}

export const retagDiffs = pgTable(
  "retag_diffs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => retagRuns.id, { onDelete: "cascade" }),
    libraryTrackId: text("library_track_id").references(() => libraryTracks.id, {
      onDelete: "cascade",
    }),
    albumId: text("album_id").references(() => libraryAlbums.id, { onDelete: "cascade" }),
    /** Library-relative, forward slashes — like every path we store. */
    path: text("path").notNull(),
    added: jsonb("added").$type<RetagTagChange[]>().notNull().default([]),
    removed: jsonb("removed").$type<RetagTagChange[]>().notNull().default([]),
    changed: jsonb("changed").$type<RetagTagChange[]>().notNull().default([]),
    /** How many projected lines the file already carried unchanged. */
    unchanged: integer("unchanged").notNull().default(0),
    /** True once the file has really been written. False for every dry run. */
    wrote: boolean("wrote").notNull().default(false),
    schemaBefore: integer("schema_before"),
    schemaAfter: integer("schema_after"),
    error: jsonb("error").$type<StoredError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("retag_diffs_run_idx").on(table.runId),
    index("retag_diffs_track_idx").on(table.libraryTrackId),
  ],
);

export type RetagRun = typeof retagRuns.$inferSelect;
export type NewRetagRun = typeof retagRuns.$inferInsert;
export type RetagDiff = typeof retagDiffs.$inferSelect;
export type NewRetagDiff = typeof retagDiffs.$inferInsert;
