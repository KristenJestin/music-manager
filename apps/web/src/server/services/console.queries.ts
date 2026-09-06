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

  const byId = new Map(tallies.map((row) => [row.importId, row]));
  const openById = new Map(open.map((row) => [row.importId, Number(row.total)]));

  return jobs.map((job) => ({
    job,
    tracksTotal: Number(byId.get(job.id)?.total ?? 0),
    tracksDone: Number(byId.get(job.id)?.done ?? 0),
    openItems: openById.get(job.id) ?? 0,
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
