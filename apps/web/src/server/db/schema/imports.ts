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
  pausedByEnum,
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

/**
 * One entry the source listed and `resolve` could not read at all.
 *
 * Field for field `ExtractGap` of the toolbox contract, restated here rather than imported for
 * the same reason `StoredError` is: this module stays free of everything but Drizzle.
 *
 * It is a **column rather than a journal line** because the journal is a log and this is a
 * fact about the import that three surfaces have to keep reading — the wizard before Start,
 * the album page afterwards, `/api/v1`. An import that holds nineteen tracks where the source
 * listed twenty has to be able to say so for as long as it exists, not only while somebody
 * happened to be watching the step run.
 */
export interface SourceGap {
  /** One-based position in the listing. Null when the source counted it without placing it. */
  readonly position: number | null;
  /** The video id, when the failure named one. */
  readonly id: string | null;
  /** The source's own sentence — "Private video. Sign in if you've been granted access". */
  readonly reason: string | null;
  /** The same catalogue the Console decodes a failure with: `YTDLP_PRIVATE`, and friends. */
  readonly code: string;
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

  /**
   * `releaseMbid` above came from the **files**, not from a person.
   *
   * A folder import whose files agree on a `MUSICBRAINZ_ALBUMID` gets it pinned automatically
   * (`resolve`), because that tag is the record their owner already decided this was. But it is
   * an inference, and the difference shows exactly once: when MusicBrainz cannot produce the
   * release. A pin somebody typed means *block and ask* — they asserted something and were
   * wrong, or the source is down. A pin read off a tag means *carry on without MusicBrainz*,
   * which is the whole point of the fallback. Without this flag the two are the same string.
   */
  readonly releaseMbidFromTags?: boolean;

  /**
   * Search MusicBrainz under **this** album title instead of the one the source advertises.
   *
   * The hints `match` computes take the album from a majority of the videos' own YouTube Music
   * tags, and those tags carry the edition — "The Best Damn Thing (Expanded Edition)" — for a
   * release MusicBrainz never published under that name. The review card's "search without the
   * edition qualifier" button writes the base title here and re-runs the step.
   *
   * A stated title, not a rule: the automatic stripping is the matcher's own business (branch
   * `fix-matching-exactness`), and this stays the way a person overrides it by hand whatever
   * that rule ends up saying.
   */
  readonly albumTitle?: string;

  /**
   * When MusicBrainz has nothing, import from the source's own tags instead of asking.
   *
   * Absent means "decide by the source": **on for a folder, off for a URL**, and the asymmetry
   * is the whole of it. A YouTube listing that matches nothing has no usable metadata to fall
   * back on — a video title, a channel name, four tags YouTube Music inferred — so blocking and
   * asking a human is right, and has been since P03. A folder's files carry real tags written
   * by Picard or by this application's own v1, so "MusicBrainz does not know this record" is a
   * fact about a bootleg or a live set rather than a reason to stop.
   *
   * Setting it explicitly overrides that in either direction: `false` on a folder somebody
   * knows is on MusicBrainz and would rather be asked about, `true` on a URL they have given up
   * on. It selects the `untagged` path that already exists (`match`, `SuppliedMapping` with
   * `releaseMbid: null`); it does not add a second one.
   */
  readonly untaggedFallback?: boolean;

  /**
   * The watched source that opened this import, when one did.
   *
   * Its presence is what makes `confirm` read the source's policy instead of its own rules:
   * an import nobody asked for by hand must not be waved through by fixtures mode or by a
   * `--yes` inherited from anywhere.
   */
  readonly watchedSourceId?: string;
  /**
   * The source said: accept this without asking **if the match is unambiguous**.
   *
   * Not `autoConfirm`. `autoConfirm` is unconditional — it is what `--yes` means — and this
   * is a *permission* that `confirm` still has to earn against the match result. The two are
   * deliberately different words because they are deliberately different promises.
   */
  readonly sourceAutoAccept?: boolean;
  /** The source's own score floor, when it set one. Otherwise `safeThreshold` applies. */
  readonly sourceAutoAcceptThreshold?: number;
}

export const imports = pgTable(
  "imports",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    kind: importKindEnum("kind").notNull(),
    status: importStatusEnum("status").notNull().default("pending"),
    /**
     * Who imposed the pause, while `status = 'paused'`. Meaningless otherwise.
     *
     * The boot sweep resumes `worker` and never `user`: see `PAUSED_BY` for why this is a
     * column and not a ninth status. Nullable because rows written before this column existed
     * have no answer, and "no answer" must read as `user` — the side that leaves them alone.
     */
    pausedBy: pausedByEnum("paused_by"),
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
    /**
     * What the source listed and `resolve` could not read. Empty for every healthy import.
     *
     * Written by `resolve` and by nothing else, so it always describes the listing the rows
     * beside it were built from. `import_tracks` holds what came back; this holds what did
     * not, and the pair is the "19 of 20" every surface quotes.
     */
    unreadable: jsonb("unreadable").$type<SourceGap[]>().notNull().default([]),
    /**
     * How many times a source has refused this import for a reason that was about the source.
     *
     * On the import row and not on `job_steps.attempt`, because it counts something else:
     * `attempt` is "how many times this step has been run", which a `mm retry --step` also
     * raises, and the cap here must not be spent by a person pressing Retry. Reset to zero by
     * every rewind and by every step that finishes, so a job that waits twice a week for
     * years never accumulates its way into a terminal state.
     */
    upstreamAttempts: integer("upstream_attempts").notNull().default(0),
    /**
     * When the queue should look at this job again, while it is `waiting_upstream`.
     *
     * Published so that the Console and `/api/v1` can say "next try in 4 minutes" rather than
     * showing a job that appears to be doing nothing. It is also what a worker restart reads:
     * the delayed pg-boss message is deleted on boot with the rest of the queue, so the
     * remaining wait has to be recoverable from the row.
     */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("imports_status_idx").on(table.status),
    index("imports_next_attempt_at_idx").on(table.nextAttemptAt),
    index("imports_created_at_idx").on(table.createdAt),
    // The Jobs list sorts on "what moved last", and the worker card asks for the single most
    // recently moved running import. Both are `order by updated_at desc limit n` and neither
    // may degrade into a full scan once the table holds thousands of imports.
    index("imports_updated_at_idx").on(table.updatedAt),
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
