/**
 * Putting the imports back on the queues — at boot, and every few minutes after it.
 *
 * Three mechanisms, all deliberate, together amputate the in-flight batch on every restart:
 *
 *  1. **A clean shutdown pauses, and nothing un-paused.** `runImport` pauses whatever it is
 *     running when the abort signal fires, which is right — a paused row is honest and a
 *     `running` one would be a lie — but the queue message is consumed and gone, and at boot
 *     nobody read those pauses back.
 *  2. **An interrupted job is never retried.** Everything is sent with `retryLimit: 0`, on
 *     purpose: a half-done download must not restart itself blindly. So a worker killed
 *     mid-job loses that job with no replacement.
 *  3. **A deferred retry dies with the queue.** The worker deletes its own queues at boot,
 *     because a ghost `download` would hold the singleton slot for six hours — and that also
 *     deletes the *scheduled* message of an import waiting out a busy source.
 *
 * The answer to all three is the same sentence, and it is the one this file implements:
 * **after the purge, every import that is not finished and not waiting on a human gets
 * exactly one message.** "Exactly one" is enforced against pg-boss's own ledger
 * (`importsWithLiveJobs`) rather than assumed from a `singletonKey`, so the sweep is also
 * correct if it ever runs against a queue that was not emptied first.
 *
 * The owner's external watchdog — a poll of the database every two minutes, calling
 * `mm retry` on whatever looked stuck — existed because none of this was in the app. The
 * periodic pass below is that watchdog, with the two things it could not have: it knows
 * whether a message is already on the queue, and it knows that a pause the owner asked for is
 * not a stuck job.
 */
import type { PgBoss } from "pg-boss";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { emit } from "#/server/services/events.ts";
import {
  resumableImports,
  RESUME_REASONS,
  type ResumableImport,
  type ResumeReason,
} from "#/server/services/jobs/index.ts";
import { humanDelay, remainingMs } from "#/server/services/jobs/upstream.ts";
import {
  enqueueDownload,
  enqueueImportStep,
  importsWithLiveJobs,
  QUEUES,
} from "#/worker/queues.ts";

/**
 * The longest wait a resume will honour from `imports.next_attempt_at`.
 *
 * A row written by a process whose clock was hours ahead must not park an import for a day.
 * Two hours is comfortably past the largest backoff the default policy can produce, so the
 * cap only ever bites on a clock that is wrong.
 */
export const MAX_RESUME_WAIT_MS = 2 * 60 * 60 * 1000;

/**
 * How often the periodic pass runs, and how still a row must be before it counts as stuck.
 *
 * Two minutes is the interval the owner's watchdog used, and it is cheap: one indexed query
 * on `imports_status_idx` that returns nothing on a healthy installation, and no second query
 * at all when it does. Ten minutes of stillness is the threshold, comfortably longer than any
 * single step, so a healthy import is never a candidate and the pg-boss check below is a
 * second guard rather than the only one.
 */
export const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
export const RECONCILE_IDLE_MS = 10 * 60 * 1000;

/** What one sweep did, by reason, for the log line the owner reads after a deploy. */
export interface ReconcileReport {
  readonly trigger: "boot" | "periodic";
  /** Imports that were sent a message. */
  readonly resumed: number;
  /** Candidates that already held a live job, so nothing was sent. */
  readonly skipped: number;
  readonly byReason: Record<ResumeReason, number>;
}

function emptyCounts(): Record<ResumeReason, number> {
  return { "paused-by-shutdown": 0, "waiting-upstream-due": 0, "running-orphan": 0 };
}

/** The reasons that actually happened, as `{reason: n}`, for a log line with no zeroes in it. */
export function nonZero(counts: Record<ResumeReason, number>): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const reason of RESUME_REASONS) {
    const n = counts[reason];
    if (n > 0) kept[reason] = n;
  }
  return kept;
}

export interface ReconcileOptions {
  readonly db?: Database;
  readonly trigger?: "boot" | "periodic";
  /** Injected by the tests so a future `next_attempt_at` can be asserted without waiting. */
  readonly now?: Date;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Re-queue everything that is not finished, not waiting on a human, and holds no message.
 *
 * Returns the breakdown rather than logging it, so the caller decides how loud to be: the
 * boot pass says it either way, the periodic one only when it found something.
 */
export async function reconcileImports(
  boss: PgBoss,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const db = options.db ?? defaultDb();
  const trigger = options.trigger ?? "boot";
  const now = options.now ?? new Date();

  /*
   * At boot: every resumable row, because the queues have just been emptied and nothing can
   * legitimately be in flight. Periodically: the same query with one more predicate, so a
   * healthy worker's own imports are never candidates.
   */
  const candidates = await resumableImports(
    db,
    trigger === "boot" ? {} : { idleSince: new Date(now.getTime() - RECONCILE_IDLE_MS) },
  );
  const byReason = emptyCounts();
  if (candidates.length === 0) return { trigger, resumed: 0, skipped: 0, byReason };

  // One read of the ledger for the whole sweep, and a set of the ids handled in this pass:
  // the first stops a surviving message being doubled, the second stops the loop doubling
  // its own work if the same import ever reaches it twice.
  const live = await importsWithLiveJobs(db);
  const sent = new Set<string>();
  let skipped = 0;

  for (const candidate of candidates) {
    const { job, reason } = candidate;
    if (live.has(job.id) || sent.has(job.id)) {
      skipped += 1;
      options.log?.("import already queued, left alone", { importId: job.id, reason });
      continue;
    }
    sent.add(job.id);
    byReason[reason] += 1;
    await departure(boss, candidate, { db, now, trigger, log: options.log });
  }

  return { trigger, resumed: sent.size, skipped, byReason };
}

/** Send one import on its way, and say so in its journal. */
async function departure(
  boss: PgBoss,
  { job, reason }: ResumableImport,
  context: {
    db: Database;
    now: Date;
    trigger: "boot" | "periodic";
    log?: (message: string, fields?: Record<string, unknown>) => void;
  },
): Promise<void> {
  /*
   * A job that was waiting out a busy source keeps waiting.
   *
   * Its delayed message was deleted with the rest of the queue at boot, so without this the
   * restart would depart immediately — straight back into the 503 the job was sitting out,
   * and one attempt closer to the cap for nothing. `next_attempt_at` is on the row for
   * exactly this, and the remaining wait is derived from it rather than restarted.
   */
  const waitMs = remainingMs(job.nextAttemptAt, context.now, MAX_RESUME_WAIT_MS);
  context.log?.("resuming import", {
    importId: job.id,
    reason,
    status: job.status,
    step: job.step,
    ...(waitMs > 0 ? { inSeconds: Math.round(waitMs / 1000) } : {}),
  });
  await emit(
    {
      importId: job.id,
      type: "import.status",
      message: sentence(reason, job.step, waitMs, context.trigger),
      data: { step: job.step, reason, trigger: context.trigger },
    },
    context.db,
  );
  if (job.step === QUEUES.download && waitMs === 0) {
    await enqueueDownload(boss, { importId: job.id }, { priority: job.priority });
  } else {
    await enqueueImportStep(
      boss,
      { importId: job.id, reason: `resume (${reason})` },
      { priority: job.priority, startAfterSeconds: waitMs / 1000 },
    );
  }
}

/** The journal line, which is the only place a person sees why their import moved. */
function sentence(
  reason: ResumeReason,
  step: string,
  waitMs: number,
  trigger: "boot" | "periodic",
): string {
  if (waitMs > 0) return `Still waiting on a source; next try in ${humanDelay(waitMs)}.`;
  const after = trigger === "boot" ? "a worker restart" : "a reconciliation sweep";
  if (reason === "paused-by-shutdown") {
    return `Resuming at ${step}: the pause came from a worker shutting down, not from you.`;
  }
  if (reason === "waiting-upstream-due")
    return `The wait on the source is over; resuming at ${step}.`;
  return `Resuming at ${step} after ${after}.`;
}
