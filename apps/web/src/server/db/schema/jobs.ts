/**
 * Step history and the journal.
 *
 * `job_steps` is one row per (import, step): the state machine's memory, and what `mm retry`
 * rewinds. `job_events` is append-only — every line the Console shows and every line the SSE
 * stream replays comes from here, so a page reload never loses a job's history.
 */
import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { eventLevelEnum, stepEnum, stepStatusEnum } from "./enums.ts";
import { imports, importTracks, type StoredError } from "./imports.ts";

export const jobSteps = pgTable(
  "job_steps",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    step: stepEnum("step").notNull(),
    status: stepStatusEnum("status").notNull().default("pending"),
    /** How many times this step has been run, including the current one. */
    attempt: integer("attempt").notNull().default(0),
    /** Whatever the step wants to remember: counts, chosen release, skipped tracks… */
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<StoredError>(),
    message: text("message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("job_steps_import_step_idx").on(table.importId, table.step),
    index("job_steps_status_idx").on(table.status),
  ],
);

/**
 * The journal. `bigserial` rather than a ULID: the SSE stream resumes with
 * `Last-Event-ID`, which needs a total order the database itself guarantees.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    importId: text("import_id").references(() => imports.id, { onDelete: "cascade" }),
    trackId: text("track_id").references(() => importTracks.id, { onDelete: "cascade" }),
    step: stepEnum("step"),
    level: eventLevelEnum("level").notNull().default("info"),
    /** Dotted event name: `step.started`, `track.downloaded`, `download.progress`… */
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("job_events_import_id_idx").on(table.importId, table.id),
    index("job_events_at_idx").on(table.at),
  ],
);

export type JobStep = typeof jobSteps.$inferSelect;
export type NewJobStep = typeof jobSteps.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
