/**
 * Everything the Console reads and P03–P05 did not already expose.
 *
 * The rule of `docs/phases/P06-web-coeur.md`: the UI adds *queries*, never behaviour. So the
 * services keep their write paths untouched and this file holds the joins and the counts a
 * screen needs — the job list with its track tallies, the detail page's tracks and steps, the
 * dashboard's six tiles. Every function here is a read; the only mutation in the whole file is
 * the one the wizard performs on `imports.options`, and it is here rather than in
 * `imports.service` because it belongs to the wizard, not to the pipeline.
 */
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  importTracks,
  imports,
  inboxItems,
  jobSteps,
  libraryAlbums,
  libraryTracks,
  type Import,
  type ImportOptions,
  type ImportStatus,
  type ImportTrack,
  type InboxItem,
  type JobStep,
  type StepName,
} from "#/server/db/schema/index.ts";
import { youtubeThumbnail } from "#/server/services/documents.ts";
import { assertSigned } from "#/server/services/imports.ts";

/* ------------------------------------------------------------------ */
/* the job list                                                        */
/* ------------------------------------------------------------------ */

/** One row of `/imports`: the import, plus the two numbers its progress bar needs. */
export interface JobSummary {
  readonly job: Import;
  readonly tracksTotal: number;
  readonly tracksDone: number;
  /** Open Inbox items blocking this job. The list shows a "Review" button when non-zero. */
  readonly openItems: number;
  /**
   * The YouTube thumbnail of the first video, so the tile can show what was imported rather
   * than a gradient with a letter on it (owner review B10).
   *
   * Only the *fallback* travels: once `match` has bound a release, the Console derives the
   * Cover Art Archive front from `job.releaseMbid` itself — one fewer column to keep current,
   * and a release that gains a cover shows it on the next render rather than the next import.
   */
  readonly thumbnail: string | null;
}

/** Statuses the `active` filter of `/imports` covers. */
export const ACTIVE_STATUSES: readonly ImportStatus[] = [
  "pending",
  "running",
  "awaiting_confirm",
  "awaiting_review",
];

export interface JobListFilter {
  /** `all`, `active`, or one exact status. */
  readonly status?: ImportStatus | "all" | "active";
  readonly limit?: number;
}

/**
 * The job list with its counts, in three queries rather than one per row.
 *
 * A per-row count would be fine at twenty jobs and quietly awful at two thousand; grouping the
 * tallies once is the same amount of code and does not have that cliff.
 */
export async function listJobs(
  filter: JobListFilter = {},
  db: Database = defaultDb(),
): Promise<JobSummary[]> {
  const wanted = filter.status ?? "all";
  const where =
    wanted === "all"
      ? isNotNull(imports.id)
      : wanted === "active"
        ? inArray(imports.status, [...ACTIVE_STATUSES])
        : eq(imports.status, wanted);

  const jobs = await db
    .select()
    .from(imports)
    .where(where)
    .orderBy(desc(imports.createdAt))
    .limit(filter.limit ?? 100);

  if (jobs.length === 0) return [];
  const ids = jobs.map((job) => job.id);

  const tallies = await db
    .select({
      importId: importTracks.importId,
      total: count(),
      done: sql<number>`count(*) filter (where ${importTracks.state} in ('placed','done','skipped'))`,
    })
    .from(importTracks)
    .where(inArray(importTracks.importId, ids))
    .groupBy(importTracks.importId);

  const open = await db
    .select({ importId: inboxItems.importId, total: count() })
    .from(inboxItems)
    .where(and(inArray(inboxItems.importId, ids), eq(inboxItems.status, "open")))
    .groupBy(inboxItems.importId);

  // One row per import — the first video, which is what the source looked like.
  const firstVideos = await db
    .selectDistinctOn([importTracks.importId], {
      importId: importTracks.importId,
      raw: importTracks.raw,
    })
    .from(importTracks)
    .where(inArray(importTracks.importId, ids))
    .orderBy(importTracks.importId, importTracks.position);

  const byId = new Map(tallies.map((row) => [row.importId, row]));
  const openById = new Map(open.map((row) => [row.importId, Number(row.total)]));
  const thumbnailById = new Map(
    firstVideos.map((row) => [row.importId, youtubeThumbnail(row.raw as never)]),
  );

  return jobs.map((job) => ({
    job,
    tracksTotal: Number(byId.get(job.id)?.total ?? 0),
    tracksDone: Number(byId.get(job.id)?.done ?? 0),
    openItems: openById.get(job.id) ?? 0,
    thumbnail: thumbnailById.get(job.id) ?? null,
  }));
}

/** How many jobs sit in each status. The filter chips of `/imports` show these. */
export async function jobCounts(
  db: Database = defaultDb(),
): Promise<Record<ImportStatus | "all" | "active", number>> {
  const rows = await db
    .select({ status: imports.status, total: count() })
    .from(imports)
    .groupBy(imports.status);

  const counts = {
    all: 0,
    active: 0,
    pending: 0,
    running: 0,
    awaiting_confirm: 0,
    awaiting_review: 0,
    paused: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  } satisfies Record<ImportStatus | "all" | "active", number>;

  for (const row of rows) {
    const total = Number(row.total);
    counts[row.status] += total;
    counts.all += total;
    if (ACTIVE_STATUSES.includes(row.status)) counts.active += total;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* one job                                                             */
/* ------------------------------------------------------------------ */

export interface JobDetail {
  readonly job: Import;
  readonly tracks: readonly ImportTrack[];
  /** One entry per step of the machine, in execution order; `row` is null if never run. */
  readonly steps: readonly { step: StepName; row: JobStep | null }[];
  readonly inbox: readonly InboxItem[];
  readonly tracksDone: number;
  /** As in `JobSummary`: the first video's thumbnail, the fallback under the CAA front. */
  readonly thumbnail: string | null;
}

export async function jobDetail(
  importId: string,
  db: Database = defaultDb(),
): Promise<JobDetail | null> {
  const [job] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (job === undefined) return null;

  const [tracks, stepRows, items] = await Promise.all([
    db
      .select()
      .from(importTracks)
      .where(eq(importTracks.importId, importId))
      .orderBy(importTracks.position),
    db.select().from(jobSteps).where(eq(jobSteps.importId, importId)),
    db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.importId, importId), eq(inboxItems.status, "open")))
      .orderBy(desc(inboxItems.createdAt)),
  ]);

  const byName = new Map(stepRows.map((row) => [row.step, row]));
  const { STEP_ORDER } = await import("#/server/services/jobs/machine.ts");

  return {
    job,
    tracks,
    steps: STEP_ORDER.map((step) => ({ step, row: byName.get(step) ?? null })),
    inbox: items,
    tracksDone: tracks.filter((track) => ["placed", "done", "skipped"].includes(track.state))
      .length,
    thumbnail: tracks[0] === undefined ? null : youtubeThumbnail(tracks[0].raw as never),
  };
}

/**
 * Other imports of the same URL, newest first.
 *
 * `imports.service` reports duplicates when it *creates* a job, but the wizard redirects to
 * `?importId=…` the moment it has one — so that answer is gone by the time step 1 renders, and
 * the warning would never be seen. Re-asking on every visit is one indexed lookup and makes
 * "you have imported this before" true whenever you look, not only in the second you looked
 * away.
 */
export async function duplicatesOf(
  url: string,
  exceptId: string,
  db: Database = defaultDb(),
): Promise<Import[]> {
  return await db
    .select()
    .from(imports)
    .where(and(eq(imports.url, url), ne(imports.id, exceptId)))
    .orderBy(desc(imports.createdAt))
    .limit(10);
}

/** The step row of one step, for the release/options panels of the detail page. */
export async function stepResult(
  importId: string,
  step: StepName,
  db: Database = defaultDb(),
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ result: jobSteps.result })
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, step)))
    .limit(1);
  return row?.result ?? null;
}

/* ------------------------------------------------------------------ */
/* the wizard's one write                                              */
/* ------------------------------------------------------------------ */

/**
 * Store what the wizard decided on the import, so `match` and the steps after it read it.
 *
 * Merged rather than replaced: `createFromUrl` already wrote whatever the paste box knew, and
 * a wizard that overwrote the whole object would silently drop it.
 */
export async function setImportOptions(
  importId: string,
  patch: Record<string, unknown>,
  extra: { priority?: number; releaseMbid?: string | null } = {},
  db: Database = defaultDb(),
): Promise<Import> {
  // The wizard, `POST /imports/{id}/confirm-mapping` and MCP's `confirm_mapping` all open the
  // confirmation gate through here, so this is the second place that has to refuse an
  // unsigned one. See `assertSigned` in `services/imports.ts`.
  assertSigned(patch);

  const [current] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (current === undefined) {
    throw new MMError("NOT_FOUND", `No import with id ${importId}.`, { status: 404 });
  }
  const merged = { ...(current.options as Record<string, unknown>), ...patch };
  const [updated] = await db
    .update(imports)
    .set({
      options: merged as ImportOptions,
      ...(extra.priority === undefined ? {} : { priority: extra.priority }),
      ...(extra.releaseMbid === undefined ? {} : { releaseMbid: extra.releaseMbid }),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId))
    .returning();
  return updated ?? current;
}

/* ------------------------------------------------------------------ */
/* the dashboard                                                       */
/* ------------------------------------------------------------------ */

export interface DashboardStats {
  readonly needsYou: number;
  readonly inProgress: number;
  readonly failed: number;
  readonly albums: number;
  readonly tracks: number;
  readonly artists: number;
  readonly storageBytes: number;
  /** Share of albums whose every track is present, in [0, 1]. `null` on an empty library. */
  readonly complete: number | null;
  /**
   * Mean metadata completeness. Null until P07 computes it — the tile shows "—" and says so
   * rather than showing a zero that would read as "all your tags are missing".
   */
  readonly metadataQuality: number | null;
}

/**
 * One line of the dashboard's "Recently added": an album, as a list of ten needs it.
 *
 * `releaseMbid` and `coverPath` travel rather than a rendered URL, for the reason `JobSummary`
 * gives about thumbnails: the Console derives the picture from them itself
 * (`components/cover.tsx`, `albumCoverSources`), so an album that gains a cover shows it on the
 * next render instead of on the next import.
 */
export interface RecentAlbum {
  readonly id: string;
  readonly title: string;
  readonly albumArtist: string;
  readonly year: number | null;
  readonly releaseMbid: string | null;
  readonly coverPath: string | null;
  readonly trackCount: number;
  readonly presentCount: number;
  /** `library_albums.created_at` — when the album entered the library, not when it was released. */
  readonly addedAt: string;
}

/**
 * The last albums added to the library, newest first.
 *
 * One indexed scan of one table: no documents, no scores, nothing per row. The dashboard is
 * the first page every visit renders, and "what did I import lately" must not cost what
 * `/library` costs.
 */
export async function recentAlbums(
  limit = 10,
  db: Database = defaultDb(),
): Promise<readonly RecentAlbum[]> {
  const rows = await db
    .select({
      id: libraryAlbums.id,
      title: libraryAlbums.title,
      albumArtist: libraryAlbums.albumArtist,
      year: libraryAlbums.year,
      releaseMbid: libraryAlbums.releaseMbid,
      coverPath: libraryAlbums.coverPath,
      trackCount: libraryAlbums.trackCount,
      presentCount: libraryAlbums.presentCount,
      createdAt: libraryAlbums.createdAt,
    })
    .from(libraryAlbums)
    .orderBy(desc(libraryAlbums.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    albumArtist: row.albumArtist,
    year: row.year,
    releaseMbid: row.releaseMbid,
    coverPath: row.coverPath,
    trackCount: row.trackCount,
    presentCount: row.presentCount,
    addedAt: row.createdAt.toISOString(),
  }));
}

export async function dashboardStats(db: Database = defaultDb()): Promise<DashboardStats> {
  const [statuses, openItems, albums, tracks] = await Promise.all([
    db.select({ status: imports.status, total: count() }).from(imports).groupBy(imports.status),
    db.select({ total: count() }).from(inboxItems).where(eq(inboxItems.status, "open")),
    db
      .select({
        total: count(),
        complete: sql<number>`count(*) filter (where ${libraryAlbums.presentCount} >= ${libraryAlbums.trackCount} and ${libraryAlbums.trackCount} > 0)`,
        artists: sql<number>`count(distinct ${libraryAlbums.albumArtist})`,
        quality: sql<number | null>`avg(${libraryAlbums.completeness})`,
      })
      .from(libraryAlbums),
    db
      .select({ total: count(), bytes: sql<number | null>`sum(${libraryTracks.size})` })
      .from(libraryTracks),
  ]);

  const byStatus = new Map(statuses.map((row) => [row.status, Number(row.total)]));
  const albumRow = albums[0];
  const trackRow = tracks[0];
  const albumTotal = Number(albumRow?.total ?? 0);

  return {
    needsYou: Number(openItems[0]?.total ?? 0),
    inProgress: ACTIVE_STATUSES.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0),
    failed: byStatus.get("failed") ?? 0,
    albums: albumTotal,
    tracks: Number(trackRow?.total ?? 0),
    artists: Number(albumRow?.artists ?? 0),
    storageBytes: Number(trackRow?.bytes ?? 0),
    complete: albumTotal === 0 ? null : Number(albumRow?.complete ?? 0) / albumTotal,
    metadataQuality: albumRow?.quality === null ? null : Number(albumRow?.quality ?? 0),
  };
}
