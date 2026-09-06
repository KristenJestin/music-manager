/**
 * The library scan's runs (`docs/phases/P07-bibliotheque-qualite.md` § Scan de bibliothèque).
 *
 * One row per run, with the whole report as JSONB. It is stored rather than recomputed
 * because the Tools page must be able to show last night's findings instantly — a scan walks
 * the whole library and probes files through the toolbox, which is seconds at best and
 * minutes on a real library, and nobody wants a page load to do that.
 *
 * The report is kept whole rather than normalised into four tables: it is read as one
 * document, written once, and never queried by its innards.
 */
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const libraryScans = pgTable(
  "library_scans",
  {
    id: text("id").primaryKey(),
    /** `cron`, `manual`, `cli`. */
    trigger: text("trigger").notNull().default("manual"),
    /** `running`, `done`, `failed`. */
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    filesSeen: integer("files_seen").notNull().default(0),
    tracked: integer("tracked").notNull().default(0),
    orphans: integer("orphans").notNull().default(0),
    missing: integer("missing").notNull().default(0),
    drift: integer("drift").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    /** The `ScanReport` of `src/server/services/scan.ts`. */
    report: jsonb("report").$type<Record<string, unknown>>(),
    error: text("error"),
  },
  (table) => [index("library_scans_started_idx").on(table.startedAt)],
);

export type LibraryScan = typeof libraryScans.$inferSelect;
export type NewLibraryScan = typeof libraryScans.$inferInsert;
