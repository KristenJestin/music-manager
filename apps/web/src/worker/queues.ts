/**
 * The queues, and how to put something on them.
 *
 * pg-boss on the same Postgres as everything else (`docs/06-stack.md`). Two of the five
 * queues carry the whole of P03:
 *
 *  - **`import.step`** advances one import until it either finishes or reaches `download`.
 *    Sent with `singletonKey = importId`, so an import can never be advanced twice at once
 *    however many times something asks for it.
 *  - **`download`** is the single global download slot. Its queue policy is `singleton` and
 *    exactly one worker consumes it (`localConcurrency: 1`), which is `docs/06-stack.md`'s
 *    "concurrence 1" — the toolbox's own `409 LOCKED` is the belt to this pair of braces.
 *
 * `retag`, `scan` and the `cron.*` queues are registered here because the schedules must
 * exist before the phases that fill them (P07, P09); their handlers are deliberately no-ops
 * that say so in the log rather than pretending to work.
 */
import { PgBoss } from "pg-boss";
import { serverEnv } from "#/server/env.ts";

export const QUEUES = {
  /** Advance one import through the step machine. */
  importStep: "import.step",
  /** The single global download slot. */
  download: "download",
  /** Re-tag files whose `MUSICMANAGER_TAGSCHEMA` is behind (P07). */
  retag: "retag",
  /** Walk the library and reconcile it with the database (P07). */
  scan: "scan",
} as const;

/** Scheduled work. Registered now, implemented in the phase named in the comment. */
export const CRON_QUEUES = {
  /** Keep yt-dlp alive — the single largest cause of breakage in v1 (decision 012). */
  "cron.ytdlp-update": "0 4 * * *",
  /** Nightly library scan (P07). */
  "cron.scan": "0 3 * * *",
  /** Refresh cached sources whose entities have changed upstream (P04). */
  "cron.refresh-sources": "0 5 * * 1",
  /** Recommendation sync (P09). */
  "cron.discover": "0 6 * * *",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES] | keyof typeof CRON_QUEUES;

export interface ImportStepJob {
  readonly importId: string;
  /** Which step to start from. Omitted means "wherever the job is". */
  readonly step?: string;
  readonly reason?: string;
}

export interface DownloadJob {
  readonly importId: string;
}

/** The schema pg-boss owns. Separate from `public`, which Drizzle owns alone. */
export const BOSS_SCHEMA = "pgboss";

/**
 * A pg-boss instance.
 *
 * `producer` builds one that only sends: no maintenance, no scheduler, no supervision. The
 * CLI uses it to drop a job on a queue and exit, without becoming a second worker.
 */
export function createBoss(options: { producer?: boolean } = {}): PgBoss {
  const { DATABASE_URL } = serverEnv();
  return new PgBoss({
    connectionString: DATABASE_URL,
    schema: BOSS_SCHEMA,
    ...(options.producer === true
      ? { supervise: false, schedule: false, max: 2 }
      : { supervise: true, schedule: true }),
  });
}

/** Declare every queue. Safe to call repeatedly; pg-boss ignores an existing queue. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.importStep, { policy: "standard" });
  // `singleton`: one active job at a time for the whole installation, which is the rule.
  await boss.createQueue(QUEUES.download, { policy: "singleton" });
  await boss.createQueue(QUEUES.retag, { policy: "standard" });
  await boss.createQueue(QUEUES.scan, { policy: "singleton" });
  for (const name of Object.keys(CRON_QUEUES)) {
    await boss.createQueue(name, { policy: "singleton" });
  }
}

/**
 * Ask for an import to be advanced.
 *
 * The `singletonKey` is what makes this safe to call from anywhere — the CLI, an SSE
 * reconnect, the end of a download — without ever queueing the same import twice.
 */
export async function enqueueImportStep(
  boss: PgBoss,
  job: ImportStepJob,
  options: { priority?: number } = {},
): Promise<string | null> {
  return await boss.send(QUEUES.importStep, job, {
    singletonKey: job.importId,
    priority: options.priority ?? 0,
    retryLimit: 0,
  });
}

/** Ask for an import's files to be downloaded, on the one queue that may do it. */
export async function enqueueDownload(
  boss: PgBoss,
  job: DownloadJob,
  options: { priority?: number } = {},
): Promise<string | null> {
  return await boss.send(QUEUES.download, job, {
    singletonKey: job.importId,
    priority: options.priority ?? 0,
    retryLimit: 0,
    // A download of a long album must not be reclaimed while it is still running.
    expireInSeconds: 6 * 60 * 60,
  });
}

/**
 * Stop a pg-boss instance and wait for it to be really stopped.
 *
 * `stop()` only *initiates* the shutdown in pg-boss 12; the instance announces the end with a
 * `stopped` event. Without this wait a short-lived producer — the CLI — exits with its
 * connections still open, which shows up later as a confusing pool warning.
 */
export async function stopBoss(boss: PgBoss, timeoutMs = 20_000): Promise<void> {
  const stopped = new Promise<void>((done) => {
    boss.once("stopped", () => {
      done();
    });
    setTimeout(done, timeoutMs).unref?.();
  });
  await boss.stop({ graceful: true, close: true, timeout: timeoutMs });
  await stopped;
}
