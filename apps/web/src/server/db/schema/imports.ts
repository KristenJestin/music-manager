/**
 * The job model of `docs/04-pipeline-et-matching.md` § Modèle.
 *
 * `imports` is one submitted URL; `import_tracks` is one video inside it. Together they hold
 * everything a resume needs: nothing about the progress of a job lives in the worker's memory,
 * so killing the worker mid-download loses at most the current file's `.part`.
 */
import { relations, sql } from "drizzle-orm";
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
import {
  importKindEnum,
  importStatusEnum,
  stepEnum,
  trackRoleEnum,
  trackStateEnum,
} from "./enums.ts";

/**
 * `{code, message, hint, action}` — the same shape on both sides of the TS↔Python bridge.
 *
 * Field for field `MMErrorBody` of `@mm/contracts`, restated here rather than imported so that
 * the schema module stays free of anything but Drizzle. `status` joined it when `toBody()`
 * started serialising the HTTP code: without the column type knowing about it, a 422 from the
 * toolbox reached this row at runtime and was invisible to every reader at compile time.
 */
export interface StoredError {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly action?: string;
  readonly details?: Record<string, unknown>;
  /** The HTTP status a bridge failure arrived with, when it arrived over HTTP. */
  readonly status?: number;
}

/** Per-import switches. Defaults come from `settings`; these are the overrides for this job. */
export interface ImportOptions {
  /** Run `fingerprint` and compare it to the mapping. */
  readonly fingerprint?: boolean;
  readonly lyrics?: boolean;
  readonly replaygain?: boolean;
  /** Re-download and re-place even when the recording is already in the library. */
  readonly force?: boolean;
  /** `--yes`: `confirm` does not block. */
  readonly autoConfirm?: boolean;
  /**
   * **Who** did the confirming, for the `decisions` row `confirm` writes.
   *
   * `autoConfirm` says only *that* the gate is open, and `confirm` used to infer `"cli --yes"`
   * from it — so a release chosen through the Console wizard, through `/api/v1` or through the
   * MCP server was all logged to the audit trail as a CLI decision. Every caller that opens the
   * gate now names itself; absent means the CLI, which is the one caller that has no other way
   * of opening it.
   */
  readonly confirmedBy?: string;
  /** MBID of the release the CLI or the fixtures picked. */
  readonly releaseMbid?: string;
}

export const imports = pgTable(
  "imports",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    kind: importKindEnum("kind").notNull(),
    status: importStatusEnum("status").notNull().default("pending"),
    /** The step the job is on, or the one it stopped at. */
    step: stepEnum("step").notNull().default("resolve"),
    options: jsonb("options").$type<ImportOptions>().notNull().default({}),
    /** The release chosen by `match`/`confirm`. */
    releaseMbid: text("release_mbid"),
    releaseGroupMbid: text("release_group_mbid"),
    /** Display fields, filled by `resolve` then refined by `match`. */
    title: text("title"),
    artist: text("artist"),
    year: integer("year"),
    /** Priority for the queue; `mm bump` raises it. Higher runs first. */
    priority: integer("priority").notNull().default(0),
    error: jsonb("error").$type<StoredError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("imports_status_idx").on(table.status),
    index("imports_created_at_idx").on(table.createdAt),
    index("imports_release_mbid_idx").on(table.releaseMbid),
    index("imports_url_idx").on(table.url),
  ],
);

export const importTracks = pgTable(
  "import_tracks",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** Position in the source listing, as yt-dlp numbered it. */
    position: integer("position").notNull(),
    videoId: text("video_id").notNull(),
    url: text("url").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceDuration: doublePrecision("source_duration"),
    uploader: text("uploader"),
    /** The whole `ExtractEntry`, kept verbatim — description included (§ raw cache). */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),

    role: trackRoleEnum("role").notNull().default("unmatched"),
    state: trackStateEnum("state").notNull().default("pending"),
    /** The MusicBrainz track this video was bound to. */
    trackMbid: text("track_mbid"),
    recordingMbid: text("recording_mbid"),
    trackTitle: text("track_title"),
    trackPosition: integer("track_position"),
    mediumPosition: integer("medium_position"),
    confidence: doublePrecision("confidence"),

    /** Absolute path inside the toolbox's filesystem, as `/download` reported it. */
    downloadPath: text("download_path"),
    downloadedBytes: integer("downloaded_bytes"),
    fingerprint: text("fingerprint"),
    fingerprintDuration: doublePrecision("fingerprint_duration"),
    /** Recording MBID the fingerprint claims, when AcoustID answered. */
    acoustidMbid: text("acoustid_mbid"),
    fingerprintOk: boolean("fingerprint_ok"),
    /** Library-relative path once `place` moved it. */
    libraryPath: text("library_path"),

    attempts: integer("attempts").notNull().default(0),
    error: jsonb("error").$type<StoredError>(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_tracks_import_position_idx").on(table.importId, table.position),
    index("import_tracks_state_idx").on(table.state),
    index("import_tracks_recording_idx").on(table.recordingMbid),
  ],
);

export const importsRelations = relations(imports, ({ many }) => ({
  tracks: many(importTracks),
}));

export const importTracksRelations = relations(importTracks, ({ one }) => ({
  import: one(imports, { fields: [importTracks.importId], references: [imports.id] }),
}));

/** `now()` as Drizzle sees it, for the `updated_at` touch every service does. */
export const now = sql`now()`;

export type Import = typeof imports.$inferSelect;
export type NewImport = typeof imports.$inferInsert;
export type ImportTrack = typeof importTracks.$inferSelect;
export type NewImportTrack = typeof importTracks.$inferInsert;
