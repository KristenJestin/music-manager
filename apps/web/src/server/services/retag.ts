/**
 * The background re-tag (`docs/03-metadonnees.md` §8).
 *
 * §8 is the promise this whole architecture exists to make good on: *the database is the
 * source of truth, files are a regenerable projection of it*. If that is true, then finding
 * out six months later that two fields were forgotten costs a re-projection, not a
 * re-download. This service is the re-projection.
 *
 * One file, one pass:
 *
 *   1. **rebuild the document, offline.** `documents.rebuild` reads the raw source cache and
 *      nothing else — §8's "no network" is enforced rather than intended: `offline: true`
 *      makes a cache miss an error instead of an HTTP call.
 *   2. **project it** into the format the file actually is (Vorbis for `.opus`/`.flac`, ID3
 *      for `.mp3`, MP4 atoms for `.m4a`). The tag map owns the names; the toolbox owns the
 *      encoding, exactly as in the `tag` step.
 *   3. **read the file back** through the toolbox's `/probe` and diff the two. This is what
 *      makes the dry run meaningful: the diff is against *what is in the file*, not against
 *      what we believe we wrote.
 *   4. **write**, unless this is a dry run — `clear: true`, so the result is the projection
 *      and not the union of two of them — refresh the `.lrc` sidecar, and stamp the new
 *      schema version on the document and on the library row.
 *
 * The audio stream is never touched: mutagen rewrites the tag block in place.
 *
 * **A dry run keeps its diffs.** That is the point of it. You read them, and *then* you press
 * the button. The real run re-projects rather than "applying" the stored diff, because between
 * the two the raw cache may have grown — and re-projecting costs nothing.
 *
 * **Work is done in batches.** One queue job re-tags `retagBatchSize` files and then puts
 * itself back on the queue. A library-wide re-tag is therefore interruptible, cancellable and
 * visible: the run row carries its own counters and every batch emits a journal line, so the
 * Console's progress bar is reading the same rows the CLI prints.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  formatProjection,
  projectDocument,
  type ProjectedTag,
  type TagFormat,
  type TrackDocument,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  retagDiffs,
  retagRuns,
  type LibraryTrack,
  type RetagRun,
  type RetagScope,
  type RetagTagChange,
  type RetagTrigger,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath, type PathMap } from "#/server/paths.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { emit } from "#/server/services/events.ts";
import { rebuild as rebuildDocument } from "#/server/services/documents.ts";
import { lyricsOf } from "#/server/services/jobs/steps/tag.ts";
import { tracksBehindSchema } from "#/server/services/quality.ts";
import { effectiveSchemaVersion } from "#/server/services/schema-version.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  toolbox as defaultToolbox,
  type Tag,
  type ToolboxClient,
} from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* the format a file actually is                                       */
/* ------------------------------------------------------------------ */

const BY_EXTENSION: Readonly<Record<string, TagFormat>> = Object.freeze({
  opus: "vorbis",
  ogg: "vorbis",
  oga: "vorbis",
  flac: "vorbis",
  mp3: "id3v24",
  m4a: "mp4",
  mp4: "mp4",
  aac: "mp4",
  alac: "mp4",
});

/**
 * Which projection a path needs.
 *
 * A guess is not acceptable here: projecting Vorbis names into an MP3 would write a pile of
 * `TXXX` frames nothing reads, and the file would still be "up to date" afterwards. An
 * unknown extension is an error, and the diff row says so.
 */
export function formatOf(path: string): TagFormat {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const format = BY_EXTENSION[extension];
  if (format === undefined) {
    throw new MMError("INVALID_INPUT", `No tag format is known for a ".${extension}" file.`, {
      hint: "The tag map covers Vorbis (opus, flac), ID3v2.4 (mp3) and MP4 atoms (m4a).",
    });
  }
  return format;
}

/* ------------------------------------------------------------------ */
/* the diff                                                            */
/* ------------------------------------------------------------------ */

/**
 * Keys `ffprobe` reports that are not tags of ours.
 *
 * Two families: what the container itself records (the encoder, the brands, the stream
 * handler) and what ffprobe synthesises. Listing them explicitly rather than filtering by
 * "not in the tag map" is deliberate — a key we do not recognise and did not put there is
 * exactly the interesting case, and it should show up as `removed` so somebody looks at it.
 */
const NOT_OURS = new Set([
  "ENCODER",
  "ENCODED_BY",
  "COMPATIBLE_BRANDS",
  "MAJOR_BRAND",
  "MINOR_VERSION",
  "HANDLER_NAME",
  "VENDOR_ID",
  "DURATION",
  "TLEN",
  "METADATA_BLOCK_PICTURE",
  "COVERART",
  "COVERARTMIME",
]);

export interface ProjectionDiff {
  readonly added: RetagTagChange[];
  readonly removed: RetagTagChange[];
  readonly changed: RetagTagChange[];
  readonly unchanged: number;
}

/** True when the diff would leave the file exactly as it is. */
export function isNoop(diff: ProjectionDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * Compare a projection with what is embedded in the file.
 *
 * `ffprobe` reports one string per key, so a multi-valued Vorbis field (`ARTISTS`, `GENRE`,
 * `PERFORMER`) comes back as whatever the container joined it into. The projection's values
 * for one key are therefore compared *joined*, with the separator ffmpeg itself uses — which
 * makes the comparison honest for the common case and, in the rare case where a container
 * disagrees about the separator, reports a difference rather than hiding one. The re-tag
 * writes the values separately regardless: only the *diff* is approximate here, never the
 * write.
 */
export function diffProjection(
  projected: readonly ProjectedTag[],
  embedded: Readonly<Record<string, string>>,
): ProjectionDiff {
  const wanted = new Map<string, { values: string[]; field: string }>();
  for (const tag of projected) {
    const key = tag.key.toUpperCase();
    const held = wanted.get(key);
    if (held === undefined) wanted.set(key, { values: [tag.value], field: tag.field });
    else held.values.push(tag.value);
  }

  const present = new Map<string, string>();
  for (const [key, value] of Object.entries(embedded)) present.set(key.toUpperCase(), value);

  const added: RetagTagChange[] = [];
  const changed: RetagTagChange[] = [];
  const removed: RetagTagChange[] = [];
  let unchanged = 0;

  for (const [key, { values, field }] of wanted) {
    const after = values.join("; ");
    const before = present.get(key);
    if (before === undefined) {
      added.push({ key, field, after });
    } else if (normalise(before) === normalise(after)) {
      unchanged += 1;
    } else {
      changed.push({ key, field, before, after });
    }
  }

  for (const [key, before] of present) {
    if (wanted.has(key) || NOT_OURS.has(key)) continue;
    removed.push({ key, before });
  }

  const order = (a: RetagTagChange, b: RetagTagChange): number => a.key.localeCompare(b.key);
  return {
    added: added.sort(order),
    removed: removed.sort(order),
    changed: changed.sort(order),
    unchanged,
  };
}

/**
 * Compare values the way a tag reader would.
 *
 * Trims, collapses runs of whitespace, and treats the two joiners containers use for a
 * multi-valued frame as the same joiner. It does **not** case-fold: `Daft Punk` and `DAFT
 * PUNK` are a real difference and hiding it would defeat the point of the diff.
 */
function normalise(value: string): string {
  return value
    .replace(/\s*[;/]\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The same hash `tag` stores, so a re-tag and an import agree on "unchanged". */
export function hashProjection(tags: readonly ProjectedTag[]): string {
  return createHash("sha256").update(formatProjection(tags)).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* planning a run                                                      */
/* ------------------------------------------------------------------ */

export interface PlanOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly scope: RetagScope;
  /** An album id for `album`, a library-track id for `track`, absent for `library`. */
  readonly targetId?: string | null;
  /** `false` re-tags everything in scope, even the files that are already current. */
  readonly onlyBehind?: boolean;
}

/** Which files a run would touch, in a stable order. */
export async function planRetag(options: PlanOptions): Promise<LibraryTrack[]> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const onlyBehind = options.onlyBehind ?? true;

  if (options.scope === "track") {
    const id = options.targetId ?? "";
    const [row] = await db.select().from(libraryTracks).where(eq(libraryTracks.id, id)).limit(1);
    if (row === undefined) throw new MMError("NOT_FOUND", `No library track with id ${id}.`);
    return [row];
  }

  if (options.scope === "album") {
    const id = options.targetId ?? "";
    if (onlyBehind) return await tracksBehindSchema({ db, settings, albumId: id });
    return await db
      .select()
      .from(libraryTracks)
      .where(eq(libraryTracks.albumId, id))
      .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);
  }

  if (onlyBehind) return await tracksBehindSchema({ db, settings });
  return await db
    .select()
    .from(libraryTracks)
    .orderBy(libraryTracks.albumId, libraryTracks.discNumber, libraryTracks.trackNumber);
}

export interface CreateRunOptions extends PlanOptions {
  readonly dryRun?: boolean;
  readonly trigger?: RetagTrigger;
}

/**
 * Open a run: count what it will touch, write the row, say so in the journal.
 *
 * The total is fixed here rather than recounted per batch. A file that stops being behind
 * while the run is in flight (because this run just fixed it) must not shrink the denominator
 * under a progress bar somebody is watching.
 */
export async function createRun(options: CreateRunOptions): Promise<RetagRun> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const targets = await planRetag({ ...options, db, settings });
  const id = newId("retagRun");

  const [row] = await db
    .insert(retagRuns)
    .values({
      id,
      scope: options.scope,
      targetId: options.targetId ?? null,
      trigger: options.trigger ?? "manual",
      dryRun: options.dryRun ?? false,
      status: "pending",
      schemaVersion: effectiveSchemaVersion(settings),
      total: targets.length,
    })
    .returning();

  if (row === undefined) throw new MMError("INTERNAL", "The re-tag run was not created.");

  await emit(
    {
      type: "retag.queued",
      message: `${options.dryRun === true ? "Dry run" : "Re-tag"} queued: ${String(targets.length)} file(s), projection v${String(row.schemaVersion)}.`,
      data: { runId: row.id, scope: row.scope, total: row.total, dryRun: row.dryRun },
    },
    db,
  );

  return row;
}

/* ------------------------------------------------------------------ */
/* running one file                                                    */
/* ------------------------------------------------------------------ */

export interface FileContext {
  readonly db: Database;
  readonly settings: Settings;
  readonly toolbox: ToolboxClient;
  readonly paths: PathMap;
  readonly schemaVersion: number;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal;
}

export interface FileOutcome {
  readonly path: string;
  readonly diff: ProjectionDiff;
  readonly wrote: boolean;
  readonly schemaBefore: number | null;
  readonly schemaAfter: number | null;
  readonly error: MMError | null;
}

/**
 * Re-project one file.
 *
 * Every failure is *this file's* failure: it is recorded on the diff row and the run carries
 * on. A library-wide re-tag that stopped on the first file with a missing cache entry would
 * be useless, and the whole point of keeping a row per file is that "which ones did not work"
 * is a question with an answer.
 */
export async function retagOne(ctx: FileContext, track: LibraryTrack): Promise<FileOutcome> {
  const empty: ProjectionDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  const before = track.tagSchemaVersion;

  try {
    if (track.importTrackId === null) {
      throw new MMError(
        "NOT_FOUND",
        `${track.path} was not produced by an import, so there are no sources to rebuild it from.`,
        {
          hint: "Files found by the library scan are adopted in a later phase.",
          action: "Import it instead",
        },
      );
    }

    const absolute = hostPath(ctx.paths, track.path);
    if (!existsSync(absolute)) {
      throw new MMError("NOT_FOUND", `${track.path} is not on disk.`, {
        hint: "The library scan reports missing files; a re-download restores one.",
        action: "Re-download",
      });
    }

    const format = formatOf(track.path);

    /* ---- 1 · the document, from the raw cache, offline ---- */
    const built = await rebuildDocument(track.importTrackId, {
      db: ctx.db,
      settings: ctx.settings,
      offline: true,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (built.requests > 0) {
      // §8 says "no network". If the builder reached out, that is a defect, not a warning.
      throw new MMError(
        "INTERNAL",
        `Rebuilding ${track.path} made ${String(built.requests)} outgoing request(s); a re-tag must be offline.`,
      );
    }

    /* ---- 2 · the projection ---- */
    const projected = projectDocument(built.document, format);

    /* ---- 3 · what the file actually holds ---- */
    const probe = await ctx.toolbox.probe(containerPath(ctx.paths, track.path));
    const diff = diffProjection(projected, probe.tags ?? {});

    if (ctx.dryRun) {
      return {
        path: track.path,
        diff,
        wrote: false,
        schemaBefore: before,
        schemaAfter: null,
        error: null,
      };
    }

    /* ---- 4 · write, refresh the sidecar, stamp the version ---- */
    const tags: Tag[] = projected.map((tag) => ({ key: tag.key, value: tag.value }));
    const lrc = lyricsOf(built.document);
    await ctx.toolbox.tag({
      path: containerPath(ctx.paths, track.path),
      format: "auto",
      tags,
      // Pictures are deliberately not re-sent: re-embedding the artwork would mean fetching
      // it, and §8's re-tag is offline. `clear` drops the tag block, not the picture frames
      // the toolbox re-attaches from the file it already has.
      pictures: [],
      lyrics_lrc: lrc,
      sidecar_lrc: false,
      clear: true,
    });

    refreshSidecars(ctx, track, built.document);

    const hash = hashProjection(projected);
    await stamp(ctx, track, built.document, hash);

    return {
      path: track.path,
      diff,
      wrote: true,
      schemaBefore: before,
      schemaAfter: ctx.schemaVersion,
      error: null,
    };
  } catch (error) {
    return {
      path: track.path,
      diff: empty,
      wrote: false,
      schemaBefore: before,
      schemaAfter: null,
      error: MMError.from(error),
    };
  }
}

/**
 * Rewrite the sidecars a document owns.
 *
 * Only the `.lrc` here, and only when the setting asks for it: it is generated from the raw
 * cache, so it is free to redo and it is the one sidecar that is *per track*. `cover.jpg` is
 * per album and needs the artwork, which needs the network — the cover picker does that, on
 * purpose and with a person watching.
 */
function refreshSidecars(ctx: FileContext, track: LibraryTrack, document: TrackDocument): void {
  if (!ctx.settings.writeLyricsSidecar) return;
  const lyrics = lyricsOf(document);
  if (lyrics === null) return;
  const target = hostPath(ctx.paths, track.path.replace(/\.[^./]+$/, ".lrc"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lyrics.endsWith("\n") ? lyrics : `${lyrics}\n`, "utf8");
}

/**
 * Record that this file now carries the current projection.
 *
 * Three writes, and all three matter: the document's own `schemaVersion` (so an export or a
 * later rebuild agrees), the `metadata_documents` row (so "documents behind" is right), and
 * the `library_tracks` row (so "files behind" is right — that is the one the Quality page
 * counts, because it is the one that describes a file).
 */
async function stamp(
  ctx: FileContext,
  track: LibraryTrack,
  document: TrackDocument,
  hash: string,
): Promise<void> {
  const stamped = { ...document, schemaVersion: ctx.schemaVersion };
  await ctx.db
    .update(metadataDocuments)
    .set({
      document: stamped as unknown as Record<string, unknown>,
      tagSchemaVersion: ctx.schemaVersion,
      projectionHash: hash,
      updatedAt: new Date(),
    })
    .where(eq(metadataDocuments.libraryTrackId, track.id));

  await ctx.db
    .update(libraryTracks)
    .set({ tagSchemaVersion: ctx.schemaVersion, projectionHash: hash, updatedAt: new Date() })
    .where(eq(libraryTracks.id, track.id));
}

/* ------------------------------------------------------------------ */
/* running a batch                                                     */
/* ------------------------------------------------------------------ */

export interface BatchOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly signal?: AbortSignal;
  /** Override the setting, for the tests. */
  readonly batchSize?: number;
}

export interface BatchResult {
  readonly run: RetagRun;
  readonly processed: number;
  readonly remaining: number;
  readonly finished: boolean;
}

/**
 * Do the next slice of a run.
 *
 * The slice is chosen from the *plan*, minus the files this run has already recorded a diff
 * for. That is what makes a batch restartable: a worker killed mid-run leaves the run row
 * `running` with N diffs, and the next batch simply carries on from N — no cursor to keep, no
 * file re-tagged twice.
 */
export async function runBatch(runId: string, options: BatchOptions = {}): Promise<BatchResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const toolbox = options.toolbox ?? defaultToolbox();
  const paths = resolvePaths(settings);
  const batchSize = options.batchSize ?? settings.retagBatchSize;

  const run = await getRun(runId, db);
  if (run === null) throw new MMError("NOT_FOUND", `No re-tag run with id ${runId}.`);
  if (run.status === "cancelled" || run.status === "done" || run.status === "failed") {
    return { run, processed: 0, remaining: 0, finished: true };
  }

  if (run.status === "pending") {
    await db
      .update(retagRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(retagRuns.id, run.id));
    await emit(
      {
        type: "retag.started",
        message: `${run.dryRun ? "Dry run" : "Re-tag"} started: ${String(run.total)} file(s) to projection v${String(run.schemaVersion)}.`,
        data: { runId: run.id, total: run.total, dryRun: run.dryRun },
      },
      db,
    );
  }

  /* ---- what is left ---- */
  const planned = await planRetag({
    db,
    settings,
    scope: run.scope,
    targetId: run.targetId,
    // A run that was opened over "everything" keeps that meaning even as files stop being
    // behind: `alreadyDone` below is what shrinks the remaining set, not the filter.
    onlyBehind: false,
  });
  const scoped = await scopeTargets(run, planned, db);
  const done = await doneIds(run.id, db);
  const pending = scoped.filter((track) => !done.has(track.id));
  const slice = pending.slice(0, batchSize);

  const ctx: FileContext = {
    db,
    settings,
    toolbox,
    paths,
    schemaVersion: run.schemaVersion,
    dryRun: run.dryRun,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  for (const track of slice) {
    if (options.signal?.aborted === true) break;
    const current = await getRun(run.id, db);
    if (current?.status === "cancelled") break;

    const outcome = await retagOne(ctx, track);
    const touched = !isNoop(outcome.diff);

    await db.insert(retagDiffs).values({
      id: newId("retagDiff"),
      runId: run.id,
      libraryTrackId: track.id,
      albumId: track.albumId,
      path: outcome.path,
      added: outcome.diff.added,
      removed: outcome.diff.removed,
      changed: outcome.diff.changed,
      unchanged: outcome.diff.unchanged,
      wrote: outcome.wrote,
      schemaBefore: outcome.schemaBefore,
      schemaAfter: outcome.schemaAfter,
      error: outcome.error === null ? null : outcome.error.toBody(),
    });

    await db
      .update(retagRuns)
      .set({
        done: sql`${retagRuns.done} + 1`,
        changed: sql`${retagRuns.changed} + ${touched && outcome.error === null ? 1 : 0}`,
        failed: sql`${retagRuns.failed} + ${outcome.error === null ? 0 : 1}`,
        updatedAt: new Date(),
      })
      .where(eq(retagRuns.id, run.id));

    await emit(
      {
        importId: track.importId,
        type: "retag.progress",
        level: outcome.error === null ? "info" : "warn",
        message:
          outcome.error !== null
            ? `${track.path}: ${outcome.error.message}`
            : run.dryRun
              ? `${track.path}: ${describeDiff(outcome.diff)} (dry run, nothing written)`
              : `${track.path}: ${describeDiff(outcome.diff)}`,
        // The per-file counts are named `*Tags` so they cannot be mistaken for the run's own
        // `changed`/`failed` counters, which travel under those names on the finish event and
        // which the Console's progress bar reads.
        data: {
          runId: run.id,
          path: track.path,
          addedTags: outcome.diff.added.length,
          removedTags: outcome.diff.removed.length,
          changedTags: outcome.diff.changed.length,
          wrote: outcome.wrote,
        },
      },
      db,
    );
  }

  const remaining = pending.length - slice.length;
  const after = await getRun(run.id, db);
  const cancelled = after?.status === "cancelled";

  if (remaining <= 0 || cancelled) {
    await finish(run.id, cancelled ? "cancelled" : "done", db);
  }

  const final = (await getRun(run.id, db)) ?? run;
  return {
    run: final,
    processed: slice.length,
    remaining: Math.max(0, remaining),
    finished: remaining <= 0 || cancelled,
  };
}

/** A run scoped to `library` still means "everything that was behind when it opened". */
async function scopeTargets(
  run: RetagRun,
  planned: readonly LibraryTrack[],
  db: Database,
): Promise<LibraryTrack[]> {
  if (run.scope !== "library") return [...planned];
  // Re-derive the set from the run's own schema version rather than the live one: a run
  // opened at v2 must finish at v2 even if somebody bumps to v3 halfway through.
  const behind = planned.filter(
    (track) => track.tagSchemaVersion === null || track.tagSchemaVersion < run.schemaVersion,
  );
  // Files this run has already stamped are no longer "behind", so they would vanish from the
  // filter — which would make `remaining` wrong. The already-done set is added back in.
  const done = await doneIds(run.id, db);
  const stamped = planned.filter((track) => done.has(track.id));
  const seen = new Set(behind.map((track) => track.id));
  return [...behind, ...stamped.filter((track) => !seen.has(track.id))];
}

async function doneIds(runId: string, db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ id: retagDiffs.libraryTrackId })
    .from(retagDiffs)
    .where(eq(retagDiffs.runId, runId));
  return new Set(rows.map((row) => row.id).filter((id): id is string => id !== null));
}

function describeDiff(diff: ProjectionDiff): string {
  if (isNoop(diff)) return "no change";
  const parts = [
    diff.added.length === 0 ? null : `${String(diff.added.length)} added`,
    diff.changed.length === 0 ? null : `${String(diff.changed.length)} changed`,
    diff.removed.length === 0 ? null : `${String(diff.removed.length)} removed`,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}

async function finish(
  runId: string,
  status: "done" | "failed" | "cancelled",
  db: Database,
): Promise<void> {
  const [row] = await db
    .update(retagRuns)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(retagRuns.id, runId))
    .returning();
  if (row === undefined) return;
  await emit(
    {
      type: status === "done" ? "retag.done" : `retag.${status}`,
      level: status === "done" ? "info" : "warn",
      message: `${row.dryRun ? "Dry run" : "Re-tag"} ${status}: ${String(row.done)}/${String(row.total)} file(s), ${String(row.changed)} changed, ${String(row.failed)} failed.`,
      data: {
        runId: row.id,
        done: row.done,
        total: row.total,
        changed: row.changed,
        failed: row.failed,
        dryRun: row.dryRun,
      },
    },
    db,
  );
}

/**
 * Drain a whole run in this process.
 *
 * The worker prefers `runBatch`, so that a long run stays interruptible and the queue keeps
 * breathing. The CLI and the tests want the answer, so they get a loop — with a hard cap on
 * iterations, because a bug that made `remaining` never shrink should stop rather than spin.
 */
export async function runToCompletion(
  runId: string,
  options: BatchOptions = {},
): Promise<RetagRun> {
  let guard = 0;
  for (;;) {
    const result = await runBatch(runId, options);
    if (result.finished) return result.run;
    guard += 1;
    if (guard > 10_000) {
      throw new MMError("INTERNAL", `Re-tag run ${runId} did not make progress.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* reading runs back                                                   */
/* ------------------------------------------------------------------ */

export async function getRun(id: string, db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db.select().from(retagRuns).where(eq(retagRuns.id, id)).limit(1);
  return row ?? null;
}

export async function listRuns(
  options: { limit?: number; albumId?: string } = {},
  db: Database = defaultDb(),
): Promise<RetagRun[]> {
  const query = db
    .select()
    .from(retagRuns)
    .orderBy(desc(retagRuns.createdAt))
    .limit(options.limit ?? 20);
  if (options.albumId === undefined) return await query;
  return await db
    .select()
    .from(retagRuns)
    .where(and(eq(retagRuns.scope, "album"), eq(retagRuns.targetId, options.albumId)))
    .orderBy(desc(retagRuns.createdAt))
    .limit(options.limit ?? 20);
}

export interface RunView {
  readonly run: RetagRun;
  readonly diffs: readonly (typeof retagDiffs.$inferSelect)[];
}

/** One run and the per-file diffs it produced — what the dry-run panel renders. */
export async function runView(
  id: string,
  options: { limit?: number } = {},
  db: Database = defaultDb(),
): Promise<RunView | null> {
  const run = await getRun(id, db);
  if (run === null) return null;
  const diffs = await db
    .select()
    .from(retagDiffs)
    .where(eq(retagDiffs.runId, id))
    .orderBy(retagDiffs.path)
    .limit(options.limit ?? 500);
  return { run, diffs };
}

/** The run currently in flight, if any. There is at most one that matters at a time. */
export async function activeRun(db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db
    .select()
    .from(retagRuns)
    .where(inArray(retagRuns.status, ["pending", "running"]))
    .orderBy(desc(retagRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** Stop a run. The batch in flight finishes its current file and then notices. */
export async function cancelRun(id: string, db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db
    .update(retagRuns)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(retagRuns.id, id), inArray(retagRuns.status, ["pending", "running"])))
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* the source-refresh trigger (docs/03 §8, cron)                       */
/* ------------------------------------------------------------------ */

/**
 * Albums whose MusicBrainz release has changed upstream since we cached it.
 *
 * The weekly `sources.refresh` cron re-fetches the release entities we hold, and anything
 * whose payload is not byte-identical to the cached one marks its albums for a re-tag. The
 * comparison is on the *payload*, not on `last-updated`: MusicBrainz's own timestamp moves
 * for edits that change nothing we project, and a re-tag nobody needs is still a write to
 * every file of an album.
 */
export async function albumsOfReleases(
  releaseMbids: readonly string[],
  db: Database = defaultDb(),
): Promise<string[]> {
  if (releaseMbids.length === 0) return [];
  const rows = await db
    .select({ id: libraryAlbums.id })
    .from(libraryAlbums)
    .where(inArray(libraryAlbums.releaseMbid, [...releaseMbids]));
  return rows.map((row) => row.id);
}
