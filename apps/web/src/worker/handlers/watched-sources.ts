/**
 * `cron.watched-sources` and the `watched-sources.scan` queue.
 *
 * The handler is thin on purpose: everything it knows how to do is `scanSource`, which is the
 * same function the Console's "Scan now", `/api/v1`, the MCP tool and `mm watch scan` call. A
 * source can therefore never behave differently depending on what woke it up.
 *
 * Three properties worth stating:
 *
 *  - **It never throws.** `scanSource` records a failure on the source row — status, error,
 *    timestamp — and a thrown job on top would make pg-boss retry a playlist whose 404 will
 *    not have healed in ten seconds, and put the same sentence in two places.
 *  - **One source at a time, and one message per source.** `singletonKey` is the source id, so
 *    a cron firing while somebody presses "Scan now" collapses into one scan of that source
 *    instead of two racing to claim the same new videos. The unique index would catch the race
 *    anyway; this is what stops it happening in the first place.
 *  - **Requests are spaced.** A run over nine channels is nine flat extractions, and YouTube
 *    notices a burst far more readily than it notices a trickle. `SPACING_MS` between sources
 *    costs nothing on a six-hourly schedule, and is zero in fixtures mode so the offline run
 *    stays fast.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { enabledSources, scanSource, type ScanReport } from "#/server/services/watched-sources.ts";
import { enqueueImportStep, QUEUES } from "#/worker/queues.ts";

/** The ad-hoc queue. `cron.watched-sources` only ever puts messages on it. */
export const WATCHED_SOURCES_QUEUE = QUEUES.watchedScan;

/** Pause between two sources in one run. Zero offline, where there is nobody to annoy. */
const SPACING_MS = 3_000;

export interface WatchedScanJob {
  /** One source, or every enabled one when absent. */
  readonly sourceId?: string;
  readonly trigger?: string;
}

export interface HandlerDeps {
  readonly db?: Database;
  readonly signal?: AbortSignal;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
  /**
   * The worker's own pg-boss, when there is one.
   *
   * Absent means "queue through a short-lived producer" (`services/queue.ts`), which is what a
   * CLI scan needs. Present means the imports a scan opens are queued on the connection that
   * is already there — a scan of a channel with forty new videos would otherwise open and
   * close forty pg-boss clients.
   */
  readonly boss?: PgBoss;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function handleWatchedScan(
  job: Job<WatchedScanJob> | null,
  deps: HandlerDeps = {},
): Promise<ScanReport[]> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? ((): void => undefined);
  const settings = await loadSettings(db);

  if (!settings.watchedSourcesEnabled) {
    log("watched-sources scan skipped", { reason: "watchedSourcesEnabled is off" });
    return [];
  }

  const asked = job?.data.sourceId;
  /*
   * A *named* source is scanned even when it is disabled: "Scan now" on a source you have
   * just paused is a deliberate act, and refusing it silently would look like a broken
   * button. `enabled` is what the schedule respects, not what the operator may ask for.
   */
  const targets =
    asked === undefined ? (await enabledSources(db)).map((source) => source.id) : [asked];

  const spacing = serverEnv().MM_FIXTURES ? 0 : SPACING_MS;
  const reports: ScanReport[] = [];
  const queue = enqueuer(deps.boss);

  for (const [index, sourceId] of targets.entries()) {
    if (deps.signal?.aborted === true) break;
    if (index > 0) await sleep(spacing, deps.signal);
    try {
      const report = await scanSource(sourceId, {
        db,
        settings,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        enqueue: queue,
      });
      reports.push(report);
      log("watched source scanned", {
        sourceId: report.sourceId,
        status: report.status,
        listed: report.listed,
        discovered: report.discovered,
        imported: report.imported,
        skipped: report.skipped,
        durationMs: report.durationMs,
      });
    } catch (error) {
      // Belt and braces: `scanSource` records its own failures. Reaching here means something
      // outside it broke, and one broken source must not end the run.
      log("watched source scan failed", {
        sourceId,
        error: MMError.from(error).message,
      });
    }
  }

  return reports;
}

/** How a freshly opened import reaches `import.step`, with or without a worker's own boss. */
function enqueuer(boss: PgBoss | undefined): (importId: string) => Promise<void> {
  if (boss !== undefined) {
    return async (importId: string): Promise<void> => {
      await enqueueImportStep(boss, { importId, reason: "watched source" });
    };
  }
  return async (importId: string): Promise<void> => {
    const { enqueue } = await import("#/server/services/queue.ts");
    await enqueue(importId, "watched source");
  };
}

/** Register the ad-hoc queue and the cron consumer. Called once from `worker/index.ts`. */
export async function registerWatchedSourceHandlers(
  boss: PgBoss,
  deps: HandlerDeps = {},
): Promise<void> {
  await boss.createQueue(WATCHED_SOURCES_QUEUE, { policy: "standard" });

  await boss.work<WatchedScanJob>(
    WATCHED_SOURCES_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<WatchedScanJob>[]) => {
      for (const job of jobs) await handleWatchedScan(job, deps);
    },
  );

  await boss.work("cron.watched-sources", { localConcurrency: 1 }, async () => {
    await handleWatchedScan(null, deps);
  });
}

/** Ask the worker for a scan without waiting for it. One message per source, at most. */
export async function enqueueWatchedScan(
  boss: PgBoss,
  job: WatchedScanJob = {},
): Promise<string | null> {
  return await boss.send(WATCHED_SOURCES_QUEUE, job, {
    singletonKey: job.sourceId ?? "all",
    retryLimit: 0,
    expireInSeconds: 60 * 60,
  });
}
