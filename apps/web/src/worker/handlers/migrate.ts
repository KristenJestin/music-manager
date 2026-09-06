/**
 * The `migrate` queue (P11 § Commande).
 *
 * A migration is the longest-running job this application has: it reads a whole database,
 * probes every file in a library, rewrites every one of them, and computes ReplayGain per
 * album. That is minutes on a fixture and hours on a real library, so it belongs to the
 * worker and not to a request — the Console starts it, the SSE journal follows it, and
 * closing the browser tab changes nothing.
 *
 * The queue policy is `singleton`: two migrations at once over one library would fight over
 * the same files, and there is never a reason to want that.
 *
 * The connection string travels on the job payload, which is a row in `pgboss.job`. That is
 * the same trust boundary as `settings` (which holds the Navidrome password) and the same
 * database the library itself lives in — but it is still a secret, so it is redacted in every
 * log line this file writes and stored redacted on the run row.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { emit } from "#/server/services/events.ts";
import { redactUrl, runMigration, type MigrationResult } from "#/server/migration/v1/index.ts";

/** The queue's name. Declared here rather than in `queues.ts`: P11 owns this queue. */
export const MIGRATE_QUEUE = "migrate";

export interface MigrateJob {
  readonly dbUrl: string;
  readonly libraryPath: string;
  readonly dryRun?: boolean;
  readonly renameToTemplate?: boolean;
  readonly limit?: number;
  readonly resume?: boolean;
  readonly acknowledgeBackup?: boolean;
  readonly verify?: boolean;
  readonly trigger?: string;
}

export interface MigrateDeps {
  readonly db?: Database;
  readonly signal?: AbortSignal;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Run one migration.
 *
 * A failure is recorded on the run row and swallowed rather than rethrown, for the reason
 * `handleScan` gives: pg-boss would retry it, and a migration that failed because the v1
 * database is unreachable will fail identically thirty seconds later. The run row and the
 * journal both already say what happened, which is where somebody would look.
 */
export async function handleMigrate(
  job: Job<MigrateJob>,
  deps: MigrateDeps = {},
): Promise<MigrationResult | null> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? (() => {});
  const data = job.data;

  log("migrate started", {
    database: redactUrl(data.dbUrl),
    library: data.libraryPath,
    dryRun: data.dryRun === true,
  });

  try {
    const result = await runMigration({
      dbUrl: data.dbUrl,
      libraryPath: data.libraryPath,
      dryRun: data.dryRun ?? false,
      renameToTemplate: data.renameToTemplate ?? false,
      ...(data.limit === undefined ? {} : { limit: data.limit }),
      resume: data.resume ?? false,
      acknowledgeBackup: data.acknowledgeBackup ?? false,
      verify: data.verify ?? false,
      trigger: data.trigger ?? "console",
      db,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });

    log("migrate done", {
      runId: result.run.id,
      migrated: result.report.counts.migrated,
      imports: result.report.counts.importsCreated,
      failed: result.report.counts.failed,
    });
    await emit(
      {
        type: "migration.done",
        level: result.report.counts.failed > 0 ? "warn" : "info",
        message: result.run.message ?? "Migration finished.",
        data: { runId: result.run.id, dryRun: result.report.dryRun },
      },
      db,
    );
    return result;
  } catch (error) {
    const failure = MMError.from(error);
    log("migrate failed", { error: failure.message });
    await emit(
      {
        type: "migration.failed",
        level: "error",
        message: `The migration failed: ${failure.message}`,
        data: { code: failure.code },
      },
      db,
    );
    return null;
  }
}

/** Put a migration on the queue. Used by the Console and by the CLI's `--queue`. */
export async function enqueueMigrate(boss: PgBoss, job: MigrateJob): Promise<string | null> {
  await boss.createQueue(MIGRATE_QUEUE, { policy: "singleton" });
  return await boss.send(MIGRATE_QUEUE, job, {
    singletonKey: "migrate-v1",
    retryLimit: 0,
    // A real library takes hours; a job reclaimed halfway through would start a second one.
    expireInSeconds: 12 * 60 * 60,
  });
}

/**
 * Register the queue and its consumer. One line in `worker/index.ts`.
 *
 * `localConcurrency: 1` on a `singleton` queue is belt and braces, and it is the same pair
 * the download slot uses for the same reason.
 */
export async function registerMigrateHandlers(boss: PgBoss, deps: MigrateDeps = {}): Promise<void> {
  await boss.createQueue(MIGRATE_QUEUE, { policy: "singleton" });
  await boss.work<MigrateJob>(
    MIGRATE_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<MigrateJob>[]) => {
      for (const job of jobs) await handleMigrate(job, deps);
    },
  );
}
