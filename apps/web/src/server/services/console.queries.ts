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
import { and, count, desc, eq, getTableColumns, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  importTracks,
  imports,
  inboxItems,
  jobSteps,
  libraryAlbums,
  libraryTracks,
  STEPS,
  type Import,
  type ImportOptions,
  type ImportStatus,
  type ImportTrack,
  type InboxItem,
  type JobStep,
  type StepName,
  type StepStatus,
} from "#/server/db/schema/index.ts";
import { totalIsKnown } from "#/server/services/album-counters.ts";
import { youtubeThumbnail } from "#/server/services/documents.ts";
import { assertSigned } from "#/server/services/imports.ts";
import { countImports, importsWhere, type ImportFilter } from "#/server/services/jobs/index.ts";

/* ------------------------------------------------------------------ */
/* the job list                                                        */
/* ------------------------------------------------------------------ */

/** One row of `/imports`: the import, plus the two numbers its progress bar needs. */
export interface JobSummary {
  readonly job: Import;
  readonly tracksTotal: number;
  readonly tracksDone: number;
  /**
   * One entry per step of the machine, in execution order; `row` is `null` if never run.
   * What `PipelineDots` needs to show more than one step running at once (owner review F3) —
   * the same shape `JobDetail.steps` already gives the detail page.
   */
  readonly steps: readonly { step: StepName; row: { status: StepStatus } | null }[];
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
  // A job waiting on a busy source is still an import in progress. Leaving it out of `active`
  // would have made the Console's headline count drop by forty-five during an outage, which
  // reads as "they finished" and is the opposite of what happened.
  "waiting_upstream",
];

/** The chips of `/imports`: `all`, the `active` group, or one exact status. */
export type JobStatusGroup = ImportStatus | "all" | "active";

export interface JobListFilter {
  /** `all`, `active`, or one exact status. */
  readonly status?: JobStatusGroup;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * One chip, as a filter the import service understands.
 *
 * The Console and `/api/v1` narrow through the same `importsWhere`, so a chip's count, its
 * page and its total are three readings of one set rather than three queries that agree by
 * coincidence.
 */
export function importFilterOf(status: JobStatusGroup): ImportFilter {
  if (status === "all") return {};
  if (status === "active") return { statuses: ACTIVE_STATUSES };
  return { status };
}

/**
 * The order the Jobs list is read in: **what is moving, first**.
 *
 * Sorting by `created_at` put the newest paste on top, which at four hundred imports is a
 * page of whatever was submitted last — usually a burst that was cancelled. Sorting by
 * `updated_at` alone is not enough either: a job cancelled a minute ago would outrank one
 * that has been downloading for ten. So liveness ranks first and recency breaks the tie, and
 * `cancelled` sits at the bottom of every unfiltered view by construction.
 *
 * Written as one `case` rather than as a column: the rank is a statement about *this screen*,
 * not a fact about an import, and a column would have to be maintained by the pipeline.
 */
const LIVENESS = sql`case ${imports.status}
    when 'running' then 0
    when 'awaiting_confirm' then 1
    when 'awaiting_review' then 1
    when 'pending' then 2
    when 'waiting_upstream' then 3
    when 'paused' then 4
    when 'failed' then 5
    when 'done' then 6
    else 7
  end`;

/**
 * The job list with its counts, in five queries rather than one per row.
 *
 * A per-row count would be fine at twenty jobs and quietly awful at two thousand; grouping the
 * tallies once is the same amount of code and does not have that cliff. Everything after the
 * first query is keyed on the ids of *this page*, so the cost is the page size and not the
 * table size.
 */
export async function listJobs(
  filter: JobListFilter = {},
  db: Database = defaultDb(),
): Promise<JobSummary[]> {
  const where = importsWhere(importFilterOf(filter.status ?? "all"));

  const jobs = await db
    .select()
    .from(imports)
    .where(where)
    .orderBy(LIVENESS, desc(imports.updatedAt))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0);

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

  // Every step row of every job in the page, so `PipelineDots` can colour more than one step
  // "running" at once instead of inferring a straight line from `job.step` (owner review F3).
  const stepRows = await db
    .select({ importId: jobSteps.importId, step: jobSteps.step, status: jobSteps.status })
    .from(jobSteps)
    .where(inArray(jobSteps.importId, ids));

  const byId = new Map(tallies.map((row) => [row.importId, row]));
  const openById = new Map(open.map((row) => [row.importId, Number(row.total)]));
  const thumbnailById = new Map(
    firstVideos.map((row) => [row.importId, youtubeThumbnail(row.raw as never)]),
  );
  const stepsById = new Map<string, Map<StepName, StepStatus>>();
  for (const row of stepRows) {
    const byStep = stepsById.get(row.importId) ?? new Map<StepName, StepStatus>();
    byStep.set(row.step, row.status);
    stepsById.set(row.importId, byStep);
  }

  return jobs.map((job) => {
    const byStep = stepsById.get(job.id);
    return {
      job,
      tracksTotal: Number(byId.get(job.id)?.total ?? 0),
      tracksDone: Number(byId.get(job.id)?.done ?? 0),
      steps: STEPS.map((step) => {
        const rowStatus = byStep?.get(step);
        return { step, row: rowStatus === undefined ? null : { status: rowStatus } };
      }),
      openItems: openById.get(job.id) ?? 0,
      thumbnail: thumbnailById.get(job.id) ?? null,
    };
  });
}

/**
 * How many jobs one chip matches, ignoring the page.
 *
 * `countImports`, not a second count of its own: the page and its total have to describe the
 * same set, and the only way to guarantee that is for both to go through one `where`.
 */
export async function countJobs(
  status: JobStatusGroup = "all",
  db: Database = defaultDb(),
): Promise<number> {
  return await countImports(importFilterOf(status), db);
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
    waiting_upstream: 0,
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

/**
 * Just the numbers that move, for rows already on screen.
 *
 * The Jobs list re-reads this when the journal says one of its imports did something. Two
 * queries over the ids of one page: the import rows themselves, and one grouped tally. It
 * exists so that live progress does not have to mean re-running the loader, which would
 * re-sort and re-page the table under the reader every time a track finished.
 */
export interface JobProgressRow {
  readonly id: string;
  readonly status: ImportStatus;
  readonly step: StepName;
  readonly tracksDone: number;
  readonly tracksTotal: number;
  readonly updatedAt: string;
}

export async function jobProgress(
  ids: readonly string[],
  db: Database = defaultDb(),
): Promise<readonly JobProgressRow[]> {
  if (ids.length === 0) return [];
  const wanted = [...ids];

  const [rows, tallies] = await Promise.all([
    db
      .select({
        id: imports.id,
        status: imports.status,
        step: imports.step,
        updatedAt: imports.updatedAt,
      })
      .from(imports)
      .where(inArray(imports.id, wanted)),
    db
      .select({
        importId: importTracks.importId,
        total: count(),
        done: sql<number>`count(*) filter (where ${importTracks.state} in ('placed','done','skipped'))`,
      })
      .from(importTracks)
      .where(inArray(importTracks.importId, wanted))
      .groupBy(importTracks.importId),
  ]);

  const byId = new Map(tallies.map((row) => [row.importId, row]));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    step: row.step,
    tracksDone: Number(byId.get(row.id)?.done ?? 0),
    tracksTotal: Number(byId.get(row.id)?.total ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* what the worker is actually on                                      */
/* ------------------------------------------------------------------ */

/** One import, as the sidebar's worker card shows it. */
export interface WorkerCurrent {
  readonly importId: string;
  readonly title: string;
  readonly artist: string | null;
  readonly step: string;
  readonly tracksDone: number;
  readonly tracksTotal: number;
  /** When this import last moved — a track changing state is a move. */
  readonly movedAt: string;
  /**
   * True when this import holds the one download slot, false when it is merely the last thing
   * seen moving. The card says which, because "downloading" and "still tidying up after the
   * download" are different answers to "what is happening right now".
   */
  readonly holdsSlot: boolean;
}

export interface WorkerSnapshot {
  readonly current: WorkerCurrent | null;
  /** Imports waiting for the worker, not counting the one it is on. */
  readonly queued: number;
}

/** How recently an import must have moved to be worth naming when no download is in flight. */
const RECENTLY_MOVED_MS = 60_000;

/** Imports that are waiting for the worker rather than for a person. */
const WAITING_ON_WORKER: readonly ImportStatus[] = ["pending", "running"];

/**
 * What the worker is on, and how deep the line behind it is.
 *
 * The card used to take the first `running` import out of a page of twenty ordered by age,
 * which is not "the one being worked" but "an arbitrary one of the forty-six queued": it
 * showed the same import at `0/13 tracks` for an hour while the worker finished four others.
 * The download slot is a row, not a guess — `job_steps(step: download, status: running)` is
 * written by `beginStep` when the worker picks the job up and closed by `endStep` when it lets
 * go — so that row *is* the holder, and there is at most one because there is one slot.
 *
 * When no download is in flight the worker may still be fingerprinting, tagging or filing, so
 * the fallback is the most recently *moved* running import, and only if it moved within the
 * last minute. Anything older is not "what is happening now", and the card says it is idle
 * rather than pointing at a job that has not breathed since breakfast.
 *
 * `queued` is the real depth: every import waiting for the worker, less the one it is on.
 * `pending` alone read `0 queued` while forty-five imports sat behind the slot, because an
 * import that has been picked up once is `running` for as long as it waits.
 */
export async function workerSnapshot(db: Database = defaultDb()): Promise<WorkerSnapshot> {
  const [holder] = await db
    .select({ job: imports })
    .from(jobSteps)
    .innerJoin(imports, eq(imports.id, jobSteps.importId))
    .where(
      and(
        eq(jobSteps.step, "download"),
        eq(jobSteps.status, "running"),
        eq(imports.status, "running"),
      ),
    )
    // A worker killed mid-download leaves its row behind; the newest start is the live one.
    .orderBy(desc(jobSteps.startedAt))
    .limit(1);

  let job: Import | null = holder?.job ?? null;
  const holdsSlot = job !== null;

  if (job === null) {
    const [recent] = await db
      .select()
      .from(imports)
      .where(
        and(
          eq(imports.status, "running"),
          gt(imports.updatedAt, new Date(Date.now() - RECENTLY_MOVED_MS)),
        ),
      )
      .orderBy(desc(imports.updatedAt))
      .limit(1);
    job = recent ?? null;
  }

  const [waiting] = await db
    .select({ total: count() })
    .from(imports)
    .where(inArray(imports.status, [...WAITING_ON_WORKER]));
  const queued = Math.max(0, Number(waiting?.total ?? 0) - (job === null ? 0 : 1));

  if (job === null) return { current: null, queued };

  const [tally] = await db
    .select({
      total: count(),
      done: sql<number>`count(*) filter (where ${importTracks.state} in ('placed','done','skipped'))`,
    })
    .from(importTracks)
    .where(eq(importTracks.importId, job.id));

  return {
    current: {
      importId: job.id,
      title: job.title ?? job.url,
      artist: job.artist,
      step: job.step,
      tracksDone: Number(tally?.done ?? 0),
      tracksTotal: Number(tally?.total ?? 0),
      movedAt: job.updatedAt.toISOString(),
      holdsSlot,
    },
    queued,
  };
}

/* ------------------------------------------------------------------ */
/* one job                                                             */
/* ------------------------------------------------------------------ */

/**
 * An import track **without** `raw`, which is the whole point of the type.
 *
 * `raw` is the verbatim yt-dlp entry — description, every thumbnail size, every format — and
 * `select()` brought back one per track: several megabytes on a hundred-track playlist, none
 * of which the page, `/api/v1` or MCP ever read. Only the first entry's is wanted, for the
 * thumbnail, and `jobDetail` fetches that one row on its own.
 */
export type JobDetailTrack = Omit<ImportTrack, "raw"> & {
  /**
   * `raw.webpage_url` — the one field of the yt-dlp entry the page has any use for.
   *
   * An import's page linked the playlist and not one of its videos, so listening to the track
   * a question is about meant copying an id by hand. The field is the same one
   * `lib/source-url.ts`'s `webpageUrlOf` reads; it is extracted **in SQL** here rather than in
   * TypeScript for the reason `withoutRaw` exists at all — `raw` is several kilobytes per
   * track of thumbnails and formats, and a hundred-track playlist must not ship all of it to
   * learn a hundred URLs. `isWebUrl`, the half of the judgement that matters to a link, is
   * still the shared one and is applied on the page.
   */
  readonly sourceUrl: string | null;
};

/**
 * Every column of `import_tracks` except `raw`, derived from the table rather than typed out.
 *
 * Built from the Drizzle column map so a column added to the schema is selected here without
 * anybody remembering to come back — the failure mode of a hand-written projection is a field
 * that silently becomes `undefined` on the page.
 */
const withoutRaw = Object.fromEntries(
  Object.entries(getTableColumns(importTracks)).filter(([name]) => name !== "raw"),
) as Omit<typeof importTracks._.columns, "raw">;

export interface JobDetail {
  readonly job: Import;
  readonly tracks: readonly JobDetailTrack[];
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

  const [tracks, stepRows, items, [first]] = await Promise.all([
    db
      .select({
        ...withoutRaw,
        sourceUrl: sql<string | null>`${importTracks.raw} ->> 'webpage_url'`,
      })
      .from(importTracks)
      .where(eq(importTracks.importId, importId))
      .orderBy(importTracks.position),
    db.select().from(jobSteps).where(eq(jobSteps.importId, importId)),
    db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.importId, importId), eq(inboxItems.status, "open")))
      .orderBy(desc(inboxItems.createdAt)),
    /* The thumbnail comes from the first entry's `raw`, and from that one alone. */
    db
      .select({ raw: importTracks.raw })
      .from(importTracks)
      .where(eq(importTracks.importId, importId))
      .orderBy(importTracks.position)
      .limit(1),
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
    thumbnail: first === undefined ? null : youtubeThumbnail(first.raw as never),
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
/* where an import stands in the line                                  */
/* ------------------------------------------------------------------ */

/**
 * The first step this import has not finished, and how many jobs are ahead of it.
 *
 * `imports.step` is *the step the job is on*, which for a job that has not been picked up yet
 * is the step it will run next — so a queued import reads `running` / `step: "download"` and
 * looks, to anything that reads the pair, exactly like an import that is downloading. The
 * `steps[]` table said `download: pending` all along; it was the headline that misled (third
 * MCP test report, minor observations).
 *
 * `queuePosition` counts the *other* active imports ahead of this one in the order the worker
 * takes them — priority first, then age — so `1` means "next". It is `null` for an import that
 * is not waiting for the worker at all: waiting for **you** is a different state, and a
 * position would suggest patience is enough.
 *
 * There is deliberately no reading of pg-boss's own tables here. The queue is one consumer and
 * this ordering is the one the dispatcher applies; peering into a library's private schema to
 * say the same thing would tie a public field to an implementation detail.
 */
export interface QueueStanding {
  /** The first step of the machine this import has not finished. */
  readonly step: StepName;
  /** 1 = next in line. `null` when the import is not waiting for the worker. */
  readonly queuePosition: number | null;
  readonly note: string;
}

const WAITING_FOR_WORKER: readonly ImportStatus[] = ["pending", "running"];

export async function queueStanding(
  detail: JobDetail,
  db: Database = defaultDb(),
): Promise<QueueStanding> {
  const done = new Set(["done", "skipped"]);
  const pending = detail.steps.find(({ row }) => row === null || !done.has(row.status));
  const step = pending?.step ?? detail.job.step;

  if (!WAITING_FOR_WORKER.includes(detail.job.status)) {
    return {
      step,
      queuePosition: null,
      note:
        detail.job.status === "awaiting_confirm" || detail.job.status === "awaiting_review"
          ? "Waiting for a decision, not for the worker."
          : `This import is \`${detail.job.status}\`; it is not in the queue.`,
    };
  }

  // Already running this step: the row exists and is `running`, so nothing is ahead of it.
  if (pending?.row?.status === "running") {
    return { step, queuePosition: 0, note: `\`${step}\` is running now.` };
  }

  const [ahead] = await db
    .select({ total: count() })
    .from(imports)
    .where(
      and(
        inArray(imports.status, [...WAITING_FOR_WORKER]),
        ne(imports.id, detail.job.id),
        // Drizzle's own operators rather than a `sql` template: a raw template hands the
        // `Date` to postgres.js unbound and it throws on the parameter, not on the query.
        or(
          gt(imports.priority, detail.job.priority),
          and(
            eq(imports.priority, detail.job.priority),
            lt(imports.createdAt, detail.job.createdAt),
          ),
        ),
      ),
    );

  const position = Number(ahead?.total ?? 0) + 1;
  return {
    step,
    queuePosition: position,
    note:
      position === 1
        ? `Queued: \`${step}\` is next, as soon as the worker is free.`
        : `Queued behind ${String(position - 1)} other import(s); \`${step}\` has not started.`,
  };
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
  /** False when `trackCount` is our own file count rather than the release's total. */
  readonly totalKnown: boolean;
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
      trackCountSource: libraryAlbums.trackCountSource,
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
    totalKnown: totalIsKnown(row.trackCountSource),
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
        // "Complete" needs a counted release behind it; an album whose total is its own
        // file count is not complete, it is unknown (`services/album-counters.ts`).
        complete: sql<number>`count(*) filter (where ${libraryAlbums.presentCount} >= ${libraryAlbums.trackCount} and ${libraryAlbums.trackCount} > 0 and ${libraryAlbums.trackCountSource} <> 'rows')`,
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
