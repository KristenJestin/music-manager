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
import { sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";

export const QUEUES = {
  /** Advance one import through the step machine. */
  importStep: "import.step",
  /** The single global download slot. */
  download: "download",
  /**
   * One local step (`fingerprint`, `tag`, `place`) for **one track** — the pipelining of
   * decision 147. Several tracks at once, one step at a time per track, and never a download:
   * that is what lets track N be fingerprinted, tagged and filed while track N+1 is still
   * coming down the single slot next door.
   */
  trackStep: "track.step",
  /** Re-tag files whose `MUSICMANAGER_TAGSCHEMA` is behind (P07). */
  retag: "retag",
  /** Walk the library and reconcile it with the database (P07). */
  scan: "scan",
  /** Hand one event to one webhook endpoint, with retries (P08). */
  webhook: "webhook.deliver",
  /** Scan one watched source, or every enabled one. */
  watchedScan: "watched-sources.scan",
  /**
   * Read the whole library back from Navidrome (P07).
   *
   * On the queue rather than in the request that asks for it, because it is a rescan wait of up
   * to four minutes followed by six or seven Subsonic calls per album, serially and with no cap
   * — a quarter of an hour on a real library. `worker/handlers/verify.ts` says the rest.
   */
  verify: "verify.library",
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
  /**
   * Scan every enabled watched source.
   *
   * Deliberately **not** `cron.refresh-sources`, which is the MusicBrainz cache refresh of
   * P04 and has nothing to do with this. Two crons whose names differ by one word would be
   * one incident away from somebody disabling the wrong one.
   */
  "cron.watched-sources": "0 */6 * * *",
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

/**
 * One pipelined step for one track — or, with `trackId: null`, the album-wide tail of `tag`
 * that closes the record once every track has been filed (ReplayGain and the album-scope
 * fields, neither of which is knowable per track).
 */
export interface TrackStepJob {
  readonly importId: string;
  readonly trackId: string | null;
  readonly step: "fingerprint" | "tag" | "place";
}

/** One row of `webhook_deliveries`. The payload is in the row, not on the queue. */
export interface WebhookJob {
  readonly deliveryId: string;
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
  // `standard`, not `singleton`: the whole point is that several *tracks* progress at once.
  // What must not overlap is two steps of the same track, and that is guaranteed upstream —
  // a track's next step is a function of its own row, and one message exists for it at a time.
  await boss.createQueue(QUEUES.trackStep, { policy: "standard" });
  await boss.createQueue(QUEUES.retag, { policy: "standard" });
  await boss.createQueue(QUEUES.scan, { policy: "singleton" });
  await boss.createQueue(QUEUES.webhook, { policy: "standard" });
  // `standard`, with the source id as `singletonKey` on the send side: two *different*
  // sources may be scanned at once, the same source may not be queued twice.
  await boss.createQueue(QUEUES.watchedScan, { policy: "standard" });
  // `singleton`: two whole-library read-backs at once would double every Subsonic call and
  // agree with each other about nothing. The same rule as `scan`, for the same reason.
  await boss.createQueue(QUEUES.verify, { policy: "singleton" });
  for (const name of Object.keys(CRON_QUEUES)) {
    await boss.createQueue(name, { policy: "singleton" });
  }
}

/**
 * Ask for an import to be advanced.
 *
 * The `singletonKey` is the import id, so a delayed message can be replaced by name and the
 * ledger can be read per import. It is **not** a uniqueness guarantee: on pg-boss 12 a
 * `standard` queue carries no unique index on `singleton_key`, so the insert's `ON CONFLICT
 * DO NOTHING` has nothing to conflict with and two sends are two rows. Anything that must send
 * exactly one message per import — the reconciliation sweep — checks `importsWithLiveJobs`
 * first rather than trusting this key.
 */
export async function enqueueImportStep(
  boss: PgBoss,
  job: ImportStepJob,
  options: { priority?: number; startAfterSeconds?: number } = {},
): Promise<string | null> {
  const delay = Math.max(0, Math.round(options.startAfterSeconds ?? 0));
  return await boss.send(QUEUES.importStep, job, {
    singletonKey: job.importId,
    priority: options.priority ?? 0,
    retryLimit: 0,
    /*
     * The wait after a source refused us (`services/jobs/upstream.ts`).
     *
     * pg-boss holds the message until then, so the growing backoff costs no process and no
     * timer: the delay is a column in the same database everything else already lives in, and
     * a worker that dies during it loses nothing — `imports.next_attempt_at` still says when.
     * `singletonKey` keeps its meaning as a *name* for that delayed message, so a Retry
     * pressed while a job is waiting can address it.
     */
    ...(delay > 0 ? { startAfter: delay } : {}),
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
 * Ask for one pipelined step of one track (or for the album's tail, with `trackId: null`).
 *
 * The `singletonKey` is the track and the step, so a duplicate — a resume that re-walks the
 * album, a chain that fires twice — collapses into the message already waiting rather than
 * running the step a second time. `retryLimit: 0` for the same reason as everywhere else here:
 * a step that failed has written *why* on the track row, and pg-boss replaying it blindly
 * would only bury that sentence under another one.
 */
export async function enqueueTrackStep(
  boss: PgBoss,
  job: TrackStepJob,
  options: { priority?: number } = {},
): Promise<string | null> {
  return await boss.send(QUEUES.trackStep, job, {
    singletonKey: `${job.trackId ?? "album"}:${job.step}`,
    priority: options.priority ?? 0,
    retryLimit: 0,
    // Long enough for the album-wide tail of a big record (ReplayGain over 28 files), short
    // enough that a worker killed mid-step does not hold the message for hours.
    expireInSeconds: 60 * 60,
  });
}

/**
 * Hand one webhook delivery to the worker.
 *
 * **The retry policy lives here, not in the handler.** Five attempts with exponential backoff
 * is roughly eleven minutes of patience, which is the right amount for "the subscriber's box
 * is rebooting" and the wrong amount for "the URL is a typo" — the latter fails five times
 * cheaply and then stops, leaving five `failed` rows that say exactly what happened.
 */
export async function enqueueWebhookDelivery(
  boss: PgBoss,
  job: WebhookJob,
): Promise<string | null> {
  return await boss.send(QUEUES.webhook, job, {
    retryLimit: 5,
    retryDelay: 20,
    retryBackoff: true,
    expireInSeconds: 120,
  });
}

/** The three queues whose payload names an import. `webhook`, `retag`, `scan` do not. */
export const IMPORT_QUEUES = [QUEUES.importStep, QUEUES.download, QUEUES.trackStep] as const;

/**
 * Which imports already have a message on one of the three import queues.
 *
 * This is the guard the reconciliation sweep needs and could not get from pg-boss. The
 * obvious answer — "`singletonKey` is the import id, so a second send collapses into the
 * first" — is **not true on pg-boss 12** for a `standard` queue, and `import.step` and
 * `track.step` are both `standard`. The insert ends in `ON CONFLICT DO NOTHING`, and the only
 * unique indexes on `singleton_key` are the ones a policy creates: `short` (one `created` job
 * per key), `singleton` (one *active* job per key), `stately`, `exclusive`. A `standard` queue
 * has none, so two identical sends are two rows. Even `download`, which is `singleton`,
 * deduplicates only against an *active* job — two `created` ones are allowed.
 *
 * So the sweep asks the ledger instead of trusting the send. It is read once per sweep and
 * applied to every candidate, which also makes the pass safe against a queue the boot purge
 * did not empty: an import that still holds its message is skipped and counted, not sent a
 * second one.
 *
 * `state < 'completed'` is pg-boss's own way of saying "not finished": the `job_state` enum is
 * ordered `created < retry < active < completed < cancelled < failed`.
 */
export async function importsWithLiveJobs(db: Database = defaultDb()): Promise<Set<string>> {
  const rows = await db.execute<{ import_id: string | null }>(sql`
    select distinct data->>'importId' as import_id
      from ${sql.raw(BOSS_SCHEMA)}.job
     where name in (${sql.join(
       IMPORT_QUEUES.map((name) => sql`${name}`),
       sql`, `,
     )})
       and state < 'completed'
       and data->>'importId' is not null
  `);
  const live = new Set<string>();
  for (const row of rows) {
    if (row.import_id !== null) live.add(row.import_id);
  }
  return live;
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
