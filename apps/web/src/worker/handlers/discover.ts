/**
 * `cron.discover` — the nightly recommendation refresh (`docs/phases/P09-discover.md`).
 *
 * The queue and its schedule have existed since P03 (`worker/queues.ts`, `CRON_QUEUES`); this
 * is the handler that finally does something with them. It is deliberately thin: everything it
 * knows how to do is `syncDiscover`, which is the same function the Console button and
 * `mm discover sync` call, so a recommendation set can never depend on which of the three
 * triggered it.
 *
 * Two properties worth stating because they are easy to lose:
 *
 *  - **It never throws.** `syncDiscover` already reports a failure as a `discover_syncs` row
 *    with a status and a message; letting the job fail on top of that would make pg-boss retry
 *    a sync whose cause (a Navidrome that is off) will not have changed in ten seconds, and
 *    would put the same message in two places.
 *  - **It is `singleton`.** The queue policy comes from `ensureQueues`, so a sync started by
 *    hand while the cron fires does not produce two runs racing to reconcile the same table.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { syncDiscover, type SyncReport } from "#/server/services/discover.ts";
import { loadSettings } from "#/server/services/settings.ts";

export interface DiscoverJob {
  readonly trigger?: string;
}

export interface HandlerDeps {
  readonly db?: Database;
  readonly signal?: AbortSignal;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** The queue a manual "sync now" from the worker side would use. */
export const DISCOVER_QUEUE = "discover";

export async function handleDiscoverSync(
  job: Job<DiscoverJob> | null,
  deps: HandlerDeps = {},
): Promise<SyncReport | null> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? ((): void => undefined);
  const settings = await loadSettings(db);
  if (!settings.discoverEnabled) {
    log("discover sync skipped", { reason: "discoverEnabled is off" });
    return null;
  }

  try {
    const report = await syncDiscover({
      db,
      settings,
      trigger: job?.data.trigger ?? "cron",
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    log("discover sync", {
      runId: report.id,
      status: report.status,
      discography: report.discography,
      recommendations: report.recommendations,
      similarArtists: report.similarArtists,
      durationMs: report.durationMs,
    });
    return report;
  } catch (error) {
    // Belt and braces: `syncDiscover` catches its own failures, so reaching here means
    // something outside it broke. Still not a thrown job — see the module note.
    log("discover sync failed", { error: MMError.from(error).message });
    return null;
  }
}

/** Register the cron consumer and the ad-hoc queue. Called once from `worker/index.ts`. */
export async function registerDiscoverHandlers(
  boss: PgBoss,
  deps: HandlerDeps = {},
): Promise<void> {
  await boss.createQueue(DISCOVER_QUEUE, { policy: "singleton" });

  await boss.work<DiscoverJob>(
    DISCOVER_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<DiscoverJob>[]) => {
      for (const job of jobs) await handleDiscoverSync(job, deps);
    },
  );

  await boss.work("cron.discover", { localConcurrency: 1 }, async () => {
    await handleDiscoverSync(null, deps);
  });
}

/** Ask the worker for a sync without waiting for it. Used by `mm discover sync --queue`. */
export async function enqueueDiscover(boss: PgBoss, job: DiscoverJob = {}): Promise<string | null> {
  return await boss.send(DISCOVER_QUEUE, job, { singletonKey: "discover-sync" });
}
