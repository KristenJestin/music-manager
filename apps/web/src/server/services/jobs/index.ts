/**
 * `jobs.service` — running the step machine.
 *
 * The eight steps live one directory down and know nothing about each other. This file is the
 * only place that decides *when* one runs: it takes the transition from `machine.ts`, writes
 * `job_steps` and `imports` before and after every step, and emits the journal lines the SSE
 * stream carries.
 *
 * Two invariants are worth stating, because everything else follows from them:
 *
 *  1. **The database is the memory.** Nothing about a running job lives in this process, so a
 *     worker can be killed at any instant and another one picks the job up exactly where it
 *     was. That is what `resume` is; there is no separate recovery path.
 *  2. **A step is idempotent.** Running it twice must be indistinguishable from running it
 *     once. `retryStep` is therefore nothing more than "start again from this step".
 */
import { rmSync } from "node:fs";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { hostPath } from "#/server/paths.ts";
import {
  importTracks,
  imports,
  jobSteps,
  libraryTracks,
  type Import,
  type ImportStatus,
  type PausedBy,
  type StepName,
  type StepStatus,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "#/server/services/events.ts";
import { closeItemsOf, openInboxItem } from "#/server/services/inbox.ts";
import { bumpQueuedImport, type BumpOutcome } from "#/server/services/queue.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  isTerminal,
  resumePoint,
  stepsFrom,
  transition,
  STEP_ORDER,
  type StepResult,
} from "./machine.ts";
import {
  classifyFailure,
  describeHold,
  exhaustedError,
  HOLD_KEY,
  holdOf,
  planUpstreamRetry,
  sourceOf,
  wasKilledByASource,
  type UpstreamHold,
  type UpstreamPolicy,
} from "./upstream.ts";
import {
  makeContext,
  requireImport,
  resolvePaths,
  type ContextOptions,
  type StepContext,
} from "./context.ts";
import { resolveStep } from "./steps/resolve.ts";
import { matchStep } from "./steps/match.ts";
import { confirmStep } from "./steps/confirm.ts";
import { downloadStep } from "./steps/download.ts";
import { fingerprintStep } from "./steps/fingerprint.ts";
import { tagStep } from "./steps/tag.ts";
import { placeStep } from "./steps/place.ts";
import { verifyStep } from "./steps/verify.ts";

export { STEP_ORDER } from "./machine.ts";
export type { StepResult } from "./machine.ts";
export {
  failSettled,
  handOverToVerify,
  isLocalStep,
  LOCAL_STEPS,
  nextStepOfTrack,
  nextTrackStep,
  pauseForReview,
  runTrackStep,
  settleImport,
  syncLocalSteps,
  type LocalStep,
  type Settlement,
} from "./pipeline.ts";

/** One implementation per step, in the order they run. */
const STEP_FUNCTIONS: Record<StepName, (ctx: StepContext) => Promise<StepResult>> = {
  resolve: resolveStep,
  match: matchStep,
  confirm: confirmStep,
  download: downloadStep,
  fingerprint: fingerprintStep,
  tag: tagStep,
  place: placeStep,
  verify: verifyStep,
};

export interface RunOptions extends ContextOptions {
  /** Stop before this step and hand the job over (the worker does this for `download`). */
  readonly stopBefore?: StepName;
  /** Run this one step and no more. */
  readonly only?: boolean;
}

export interface RunOutcome {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly step: StepName;
  readonly ran: readonly { step: StepName; result: StepResult }[];
  /** Set when the runner stopped because `stopBefore` was reached. */
  readonly handOff: StepName | null;
  /**
   * Set when the run stopped because a source refused us and the job is waiting it out.
   *
   * The caller that owns a queue handle — the worker — puts the message back with this delay.
   * The runner cannot do it itself: it has no pg-boss, on purpose, since the same code runs
   * inside `mm import`, where the answer is simply to stop.
   */
  readonly hold: UpstreamHold | null;
}

/** The ladder's shape, as the settings describe it. */
export function upstreamPolicyOf(settings: Settings): UpstreamPolicy {
  return {
    maxAttempts: settings.upstreamMaxAttempts,
    baseMs: settings.upstreamBackoffBaseMs,
    maxMs: settings.upstreamBackoffMaxMs,
  };
}

/* ------------------------------------------------------------------ */
/* one step                                                            */
/* ------------------------------------------------------------------ */

async function beginStep(db: Database, importId: string, step: StepName): Promise<number> {
  const [existing] = await db
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, step)))
    .limit(1);

  const attempt = (existing?.attempt ?? 0) + 1;
  if (existing === undefined) {
    await db.insert(jobSteps).values({
      id: newId("jobStep"),
      importId,
      step,
      status: "running",
      attempt,
      startedAt: new Date(),
    });
  } else {
    await db
      .update(jobSteps)
      .set({
        status: "running",
        attempt,
        startedAt: new Date(),
        finishedAt: null,
        error: null,
        // The previous run's sentence is not this run's sentence. Leaving it made `download`
        // sit at `running` under "No mapped track to download." from the attempt before —
        // a message that reads like a live diagnosis and is a stale one.
        message: null,
        result: null,
        updatedAt: new Date(),
      })
      .where(eq(jobSteps.id, existing.id));
  }
  return attempt;
}

async function endStep(
  db: Database,
  importId: string,
  step: StepName,
  result: StepResult,
  status: StepStatus,
): Promise<void> {
  await db
    .update(jobSteps)
    .set({
      status,
      message: result.message ?? null,
      result: result.data ?? null,
      error: result.error ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, step)));
}

/**
 * Run exactly one step, with its bookkeeping. Exported because `mm retry --step` and the
 * integration tests both want a single step without the loop around it.
 *
 * `skipIfStopped` is how the worker says "…but only if the job still wants it". `runImport` has
 * always refused a terminal import, but `download` does not go through `runImport` — the worker
 * takes it off its own queue and calls this function directly, so the queue path had no such
 * check at all. A `download` message that outlived the job it names (the owner cancels an
 * import while it is queued, a worker restarts, a duplicate arrives) therefore downloaded an
 * album nobody had asked for any more, held the single global slot while doing it, and —
 * because the tail of this function writes `imports.status` unconditionally — brought the
 * cancelled job back as `running`. It is opt-in rather than automatic because `mm retry --step`
 * deliberately re-runs a step on a job that has finished, and that must keep working.
 */
export async function runStep(
  importId: string,
  step: StepName,
  options: ContextOptions = {},
): Promise<StepResult> {
  const db = options.db ?? defaultDb();

  if (options.skipIfStopped === true) {
    const current = await requireImport(importId, db);
    if (isTerminal(current.status) || current.status === "paused") {
      const message = `${step} skipped: the job is ${current.status}`;
      await emit({ importId, step, type: "step.skipped", message }, db);
      // `refused` is what stops the worker asking for the job to be advanced afterwards, which
      // would undo a Pause one queue hop later.
      return { status: "skipped", message, data: { refused: current.status } };
    }
  }

  const ctx = await makeContext(importId, step, options);
  const attempt = await beginStep(db, importId, step);

  await emit(
    { importId, step, type: "step.started", message: `${step} started`, data: { attempt } },
    db,
  );

  let result: StepResult;
  try {
    result = await STEP_FUNCTIONS[step](ctx);
  } catch (error) {
    const failure = MMError.from(error);
    result = {
      status: "failed",
      message: failure.message,
      error: failure.toBody(),
    };
  }

  const moved = transition(step, result);

  /*
   * The one place a busy source stops being a dead import.
   *
   * `transition` is pure and says `failed`, which is correct as a statement about the *step*.
   * What the *job* should do about it depends on why the step failed, and that is a question
   * about an error body, not about the machine — so it is asked here, between the transition
   * and the write, and answered by `classifyFailure`. `moved.continues` is respected: a step
   * that already named an earlier step to rewind to (`verify` losing a file) is repairing
   * itself and must not be turned into a wait on MusicBrainz.
   */
  const upstream =
    result.status === "failed" && !moved.continues
      ? await considerUpstream(db, importId, step, result, ctx.settings)
      : null;
  result = upstream?.result ?? result;

  await endStep(db, importId, step, result, moved.stepStatus);

  // A failure the machine is going to repair by itself (`restartAt`) is a warning, not an
  // error: it does not stop the job, so a red line in the journal would be a lie. A failure
  // the machine is going to *wait out* is the same argument, one source further away.
  const repaired = result.status === "failed" && moved.continues;
  const waiting = upstream?.hold ?? null;

  await emit(
    {
      importId,
      step,
      level: repaired || waiting !== null ? "warn" : result.status === "failed" ? "error" : "info",
      type:
        waiting !== null
          ? "step.waiting_upstream"
          : repaired
            ? "step.restarting"
            : `step.${result.status}`,
      message: result.message ?? `${step} ${result.status}`,
      data: { attempt, restartAt: moved.step, ...(result.data ?? {}) },
    },
    db,
  );

  // A hold is not a transition: the job stays on the step it failed, because that is the step
  // that has to run again once the source is answering. Everything else follows the machine.
  const status: ImportStatus = waiting === null ? moved.status : "waiting_upstream";

  /*
   * The second door into `paused`, and the one that carries no reason.
   *
   * `pauseImport` is the explicit one. This is the other: a step that saw the abort signal
   * returns `blocked` with `blockedAs: "paused"` (`download`, `fingerprint`, `tag`, `place`
   * all do), and the machine writes the status here. Every such site in the tree today is an
   * abort check, but the discriminator is derived from the signal rather than from that
   * happy coincidence — a future `blocked` that pauses for some other reason will be called
   * `user`, which is the answer that leaves it alone.
   */
  const pausedBy: PausedBy | null =
    status !== "paused" ? null : options.signal?.aborted === true ? "worker" : "user";

  await db
    .update(imports)
    .set({
      step: moved.step,
      status,
      pausedBy,
      // The row's `error` is "why this job is stopped". A job the machine is rewinding is not
      // stopped, so it must not carry one — the Console paints it as a red banner. A job that
      // is waiting *does* keep it: it is the sentence that says which source refused, and the
      // status beside it is what stops the Console painting it red.
      error: moved.continues ? null : (result.error ?? null),
      ...(waiting !== null
        ? { upstreamAttempts: waiting.attempt, nextAttemptAt: new Date(waiting.nextAttemptAt) }
        : result.status === "failed"
          ? // Freeze the counter where it got to. The row is terminal and the number is part
            // of the explanation: "six attempts" is why it stopped.
            { nextAttemptAt: null }
          : // **Progress clears the budget.** A step that finished means the source answered,
            // so an import that waits twice a week for a year never accumulates its way into a
            // terminal state. This is the reason the counter is on the import and not on the
            // step: it measures a run of bad luck, and a success ends the run.
            { upstreamAttempts: 0, nextAttemptAt: null }),
      updatedAt: new Date(),
      ...(isTerminal(status) ? { finishedAt: new Date() } : {}),
    })
    .where(eq(imports.id, importId));

  // The import-level line is emitted here rather than in the loop, because `download` runs on
  // its own queue and never goes through the loop at all: a failure there has to close the
  // job for anyone following it just as clearly as a failure anywhere else. A hold has
  // already said its piece — `announce` would repeat it in a second, vaguer sentence.
  if (!moved.continues && waiting === null) await announce(db, importId, step, status, result);

  return result;
}

/* ------------------------------------------------------------------ */
/* upstream refusals                                                   */
/* ------------------------------------------------------------------ */

/**
 * A step failed. Is that the source's fault, and if so, how many times has it been already?
 *
 * Returns `null` when the failure is a defect and the job should fail now — which is the
 * answer for a 404, a parse error, a bad MBID and everything else `classifyFailure` calls a
 * defect. Otherwise it returns either a hold (the job goes back on the queue later) or a
 * rewritten failure that says, in its code, that the *source* is what gave up.
 *
 * The counter lives on the row and is read here rather than passed in, because the same
 * import can be refused on `match` today and on `tag` in an hour: the budget belongs to the
 * import, not to one step of it.
 */
async function considerUpstream(
  db: Database,
  importId: string,
  step: StepName,
  result: StepResult,
  settings: Settings,
): Promise<{ result: StepResult; hold: UpstreamHold | null } | null> {
  if (classifyFailure(result.error) !== "upstream") return null;

  const policy = upstreamPolicyOf(settings);
  const job = await requireImport(importId, db);
  const decision = planUpstreamRetry(job.upstreamAttempts, policy);
  const source = sourceOf(result.error);

  if (decision.action === "giveUp") {
    // The terminal answer, and it must not read like a broken file. Built in `upstream.ts`
    // because `failSettled` says exactly the same thing about the per-track half.
    const failure = exhaustedError(source, step, policy.maxAttempts, result.error ?? null);
    await emit(
      {
        importId,
        step,
        level: "error",
        type: "import.upstream_exhausted",
        message: failure.message,
        data: { source, attempts: policy.maxAttempts },
      },
      db,
    );
    return {
      result: { ...result, message: failure.message, error: failure.toBody() },
      hold: null,
    };
  }

  const hold: UpstreamHold = {
    attempt: decision.attempt,
    maxAttempts: policy.maxAttempts,
    delayMs: decision.delayMs,
    nextAttemptAt: new Date(Date.now() + decision.delayMs).toISOString(),
    source,
  };
  const message = describeHold(decision, policy, source);
  await emit(
    {
      importId,
      step,
      level: "warn",
      type: "import.waiting_upstream",
      message: `${message} (${result.error?.code ?? "upstream"})`,
      data: { ...hold },
    },
    db,
  );
  return {
    result: {
      ...result,
      message: `${step}: ${message}`,
      data: { ...(result.data ?? {}), [HOLD_KEY]: hold },
    },
    hold,
  };
}

/**
 * One journal line saying the import as a whole stopped, and why.
 *
 * Exported since the pipelining of decision 147: a track that fails on the `track.step` queue
 * is not allowed to stop the album on the spot — the downloads behind it must finish — so the
 * conclusion is drawn later, by the worker, and it must read exactly like every other one.
 */
export async function announce(
  db: Database,
  importId: string,
  step: StepName,
  status: ImportStatus,
  result: StepResult,
): Promise<void> {
  if (status === "done") {
    // "already present" is the word `docs/04` § Règles uses for the idempotent case, and the
    // one the acceptance criteria look for. It is the *download* step that knows, so ask it.
    const [download] = await db
      .select({ message: jobSteps.message, status: jobSteps.status })
      .from(jobSteps)
      .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, "download")))
      .limit(1);
    const untouched =
      download?.status === "skipped" && (download.message ?? "").startsWith("already present");
    await emit(
      {
        importId,
        type: "import.done",
        message: untouched ? "Import complete: already present." : "Import complete.",
        data: { ...(result.data ?? {}), alreadyPresent: untouched },
      },
      db,
    );
    return;
  }
  if (status === "failed") {
    await emit(
      {
        importId,
        level: "error",
        type: "import.failed",
        message: result.message ?? `${step} failed`,
        data: result.error ?? {},
      },
      db,
    );
    await raiseFailure(db, importId, step, result);
    return;
  }
  await emit(
    {
      importId,
      level: "warn",
      type: "import.status",
      message: `${status}: ${result.message ?? step}`,
      data: { step, status },
    },
    db,
  );
}

/**
 * A failed job becomes a question, not just a red row in a list.
 *
 * `job_failed` was in the vocabulary (`enums.vocab.ts`), in the Inbox options test and in
 * `docs/04` § Inbox — "avec code d'erreur décodé" — and **no producer existed**: two failed
 * jobs left `/review` saying "Nothing to decide" and the NEEDS YOU tile at zero, so a failure
 * was only discoverable by walking the Jobs list (DRIVE-1 §A3). The Inbox is the one place
 * that is supposed to be able to say "something needs you"; a failure is the plainest example
 * there is.
 *
 * The item is idempotent per import (`openInboxItem` refreshes rather than piling up), so a
 * job that fails, is retried and fails again is one question, not three. Its payload carries
 * the **decoded** error — the same `{code, message, hint, action}` the toolbox bridge and the
 * error decoder speak — because "UNKNOWN" with a developer's sentence under it is what the
 * previous drive had to read off the screen.
 */
async function raiseFailure(
  db: Database,
  importId: string,
  step: StepName,
  result: StepResult,
): Promise<void> {
  const error: Record<string, unknown> = { ...(result.error ?? {}) };
  const code = typeof error["code"] === "string" ? error["code"] : "UNKNOWN";
  const message =
    result.message ?? (typeof error["message"] === "string" ? error["message"] : null);
  const hint = typeof error["hint"] === "string" ? error["hint"] : null;

  await openInboxItem(
    {
      type: "job_failed",
      importId,
      title: `The import failed at ${step}: ${code}`,
      summary: [message, hint].filter((part): part is string => part !== null).join(" — "),
      payload: { step, error, code, ...(hint === null ? {} : { hint }) },
      // Retrying is what the person almost always wants, and it is the answer that lets the
      // job carry on — the property every preselection in this Inbox has.
      preselected: { action: "retry", step },
    },
    db,
  );
}

/* ------------------------------------------------------------------ */
/* the loop                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run steps from wherever the job is until it finishes, blocks, fails, or reaches
 * `stopBefore`.
 *
 * `stopBefore: "download"` is how the worker hands the job to the single global download
 * queue: the pipeline is not interrupted, it changes queue.
 */
export async function runImport(importId: string, options: RunOptions = {}): Promise<RunOutcome> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const ran: { step: StepName; result: StepResult }[] = [];

  const job = await requireImport(importId, db);
  if (isTerminal(job.status)) {
    return { importId, status: job.status, step: job.step, ran, handOff: null, hold: null };
  }

  if (job.startedAt === null) {
    await db
      .update(imports)
      .set({ startedAt: new Date(), status: "running", updatedAt: new Date() })
      .where(eq(imports.id, importId));
  }

  let step: StepName = job.step;

  for (;;) {
    if (options.signal?.aborted === true) {
      await pauseImport(importId, "the worker is shutting down", db, "worker");
      break;
    }
    if (step === options.stopBefore) {
      // Not an interruption: the job changes queue. `download` is global and single-file, so
      // it is executed by the one worker slot that owns that queue, not by this one.
      return { importId, status: "running", step, ran, handOff: step, hold: null };
    }

    const result = await runStep(importId, step, { ...options, settings, db });
    ran.push({ step, result });

    const moved = transition(step, result);
    if (!moved.continues) {
      // `runStep` may have turned that failure into a wait. It wrote the row; the loop only
      // has to stop and hand the reason up, so that whoever owns a queue can re-send later.
      const hold = holdOf(result.data);
      return {
        importId,
        status: hold === null ? moved.status : "waiting_upstream",
        step: moved.step,
        ran,
        handOff: null,
        hold,
      };
    }

    step = moved.step;
    if (options.only === true) {
      return { importId, status: "running", step, ran, handOff: null, hold: null };
    }
  }

  const current = await requireImport(importId, db);
  return { importId, status: current.status, step: current.step, ran, handOff: null, hold: null };
}

/* ------------------------------------------------------------------ */
/* the imports a source killed                                         */
/* ------------------------------------------------------------------ */

/** One import that failed on a source, and where a retry of it would restart. */
export interface UpstreamFailure {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  readonly step: StepName;
  readonly source: string | null;
  readonly code: string;
  readonly attempts: number;
  readonly failedAt: Date | null;
}

/**
 * Every `failed` import whose failure was the source's fault.
 *
 * The filter is **`wasKilledByASource`, not a code list**, and that is the point: the forty-five
 * albums this exists for died before `UPSTREAM_UNAVAILABLE` was a code at all. Their rows say
 * `SOURCE_UNAVAILABLE` with `status: 503`, which is exactly what the rule was written to
 * recognise — so the same function that decides the live case also identifies the historical
 * one, and there is no second definition of "upstream" to keep in step with the first.
 *
 * SQL narrows to `failed` with an error; the rule does the rest in one pass. A coarse filter
 * and one predicate beats a clever `jsonb` query that would be a second implementation.
 */
export async function upstreamFailures(
  db: Database = defaultDb(),
  options: { limit?: number } = {},
): Promise<UpstreamFailure[]> {
  const rows = await db
    .select()
    .from(imports)
    .where(and(eq(imports.status, "failed"), isNotNull(imports.error)))
    .orderBy(asc(imports.createdAt));

  const matched: UpstreamFailure[] = [];
  for (const row of rows) {
    if (!wasKilledByASource(row.error)) continue;
    matched.push({
      id: row.id,
      url: row.url,
      title: row.title,
      step: row.step,
      source: sourceOf(row.error),
      code: row.error?.code ?? "UNKNOWN",
      attempts: row.upstreamAttempts,
      failedAt: row.finishedAt,
    });
    if (options.limit !== undefined && matched.length >= options.limit) break;
  }
  return matched;
}

/**
 * Put every import a source killed back on the line. **Nothing is executed here.**
 *
 * Rewind only, exactly like `rewindTo` and for the same reason (owner review C3): the caller
 * puts the ids on a queue, with one producer for all of them rather than one each — forty-five
 * short-lived pg-boss connections to retry forty-five albums would be its own small incident.
 *
 * **Idempotent by construction.** `rewindTo` moves the row out of `failed` and into `running`,
 * so a second call selects nothing: the answer to "did that work, let me run it again" is an
 * empty list, not forty-five duplicate jobs. It also resets `upstream_attempts`, so a requeued
 * import gets a fresh ladder rather than inheriting an exhausted one.
 */
export async function requeueUpstreamFailures(
  options: { limit?: number; dryRun?: boolean } = {},
  db: Database = defaultDb(),
): Promise<(UpstreamFailure & { restartAt: StepName })[]> {
  const found = await upstreamFailures(db, options);
  const planned: (UpstreamFailure & { restartAt: StepName })[] = [];
  for (const failure of found) {
    // From where the job actually stopped, not from `resolve`: the files that came down before
    // MusicBrainz refused are still on disk, and re-fetching them would be the expensive way
    // of being wrong.
    const restartAt = await resumeStepOf(failure.id, db);
    planned.push({ ...failure, restartAt });
    if (options.dryRun !== true) await rewindTo(failure.id, restartAt, db);
  }
  return planned;
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rewind the rows to `step`. **Nothing is executed.**
 *
 * This is the half of "retry" that is safe to call from an HTTP request, and splitting it out
 * is the fix for the owner's C3. `retryStep` used to be the only entry point, and it ends with
 * `runImport` — so the Console's Retry button ran the step *inside the web process*, in
 * parallel with the worker, whatever the queue thought. On a job sitting at `download` that
 * meant a second `POST /download` while the first was still streaming, the toolbox answering
 * `409 LOCKED`, and the job going `failed` for a reason that was entirely our own doing.
 * Callers that are not the worker now rewind here and put the job on a queue; the worker, and
 * only the worker, runs steps.
 */
export async function rewindTo(
  importId: string,
  step: StepName,
  db: Database = defaultDb(),
): Promise<void> {
  await requireImport(importId, db);

  const later = stepsFrom(step);
  await db
    .update(jobSteps)
    .set({
      status: "pending",
      finishedAt: null,
      error: null,
      message: null,
      result: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobSteps.importId, importId), inArray(jobSteps.step, [...later])));

  await db
    .update(imports)
    .set({
      step,
      status: "running",
      // The row is leaving `paused`; whoever had stopped it no longer has it stopped.
      pausedBy: null,
      error: null,
      finishedAt: null,
      // A retry is a fresh ladder. A job that used all six attempts during an outage and is
      // requeued the next morning must get six more, or the requeue would be one attempt long
      // and land back in `failed` on the first hiccup — which is exactly the shape of the
      // incident this whole branch is about, one day later.
      upstreamAttempts: 0,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));

  await emit({ importId, step, type: "import.status", message: `Retrying from ${step}.` }, db);
}

/**
 * Rewind to `step` and run from there, in this process.
 *
 * Only the worker and the tests may call this: it blocks for as long as the pipeline takes and
 * it ignores every queue. Everything else wants `rewindTo` followed by `enqueue`.
 */
export async function retryStep(
  importId: string,
  step: StepName,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const db = options.db ?? defaultDb();
  await rewindTo(importId, step, db);
  return await runImport(importId, { ...options, db });
}

/**
 * Put one video back to "never downloaded", so the next `download` fetches it again.
 *
 * The three things that make `download` skip a track are cleared together, because clearing
 * only some of them is a retry that silently does nothing: the `library_tracks` row (which
 * makes `alreadyInLibrary` true), the work file on disk (which makes `fileReady` true) and the
 * row's own `state`. The mapping — recording, title, position, confidence — is deliberately
 * left alone: this is a retry, not a re-match.
 */
export async function resetTrack(
  importId: string,
  trackId: string,
  db: Database = defaultDb(),
): Promise<void> {
  const [track] = await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.id, trackId), eq(importTracks.importId, importId)))
    .limit(1);
  if (track === undefined) {
    throw new MMError("NOT_FOUND", `No track ${trackId} on import ${importId}.`);
  }

  const paths = resolvePaths(await loadSettings(db));
  for (const relative of [track.downloadPath, track.libraryPath]) {
    if (relative === null) continue;
    await db.delete(libraryTracks).where(eq(libraryTracks.path, relative));
    // `force: true`: a file another process removed first is the outcome we wanted anyway.
    rmSync(hostPath(paths, relative), { force: true });
  }

  await db
    .update(importTracks)
    .set({
      state: "pending",
      downloadPath: null,
      downloadedBytes: null,
      libraryPath: null,
      fingerprint: null,
      fingerprintOk: null,
      attempts: 0,
      error: null,
      note: null,
      updatedAt: new Date(),
    })
    .where(eq(importTracks.id, trackId));

  await emit(
    {
      importId,
      trackId,
      step: "download",
      type: "track.progress",
      message: `${track.sourceTitle}: queued for another download`,
      data: { stage: "retry" },
    },
    db,
  );
}

/** Where a resume would restart, from what `job_steps` says. */
export async function resumeStepOf(
  importId: string,
  db: Database = defaultDb(),
): Promise<StepName> {
  const rows = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.importId, importId))
    .orderBy(asc(jobSteps.step));
  const completed: Partial<Record<StepName, (typeof rows)[number]["status"]>> = {};
  for (const row of rows) completed[row.step] = row.status;
  const job = await requireImport(importId, db);
  return resumePoint(completed, job.step);
}

/**
 * Stop a job where it stands. It can be picked up again.
 *
 * `by` is the durable half of `reason`. The sentence goes to the journal, which is where a
 * person reads it; the word goes to `imports.paused_by`, which is where the next boot reads
 * it. They were one argument until a restart had to tell "the owner pressed Pause" from "the
 * worker was going down", and a journal line is not something a `where` clause can ask.
 * It defaults to `user`: only the shutdown path claims to be the worker.
 */
export async function pauseImport(
  importId: string,
  reason = "paused",
  db: Database = defaultDb(),
  by: PausedBy = "user",
): Promise<void> {
  await db
    .update(imports)
    .set({ status: "paused", pausedBy: by, updatedAt: new Date() })
    .where(and(eq(imports.id, importId), ne(imports.status, "done")));
  await emit(
    { importId, level: "warn", type: "import.status", message: reason, data: { pausedBy: by } },
    db,
  );
}

/** Give up on a job. Open Inbox items are dismissed with it. */
export async function cancelImport(importId: string, db: Database = defaultDb()): Promise<void> {
  await db
    .update(imports)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(imports.id, importId));
  await closeItemsOf(importId, db);
  await emit({ importId, level: "warn", type: "import.cancelled", message: "Cancelled." }, db);
}

/** What a bump did: to the row, and to the message the import already had on a queue. */
export interface BumpResult {
  readonly priority: number;
  readonly queue: BumpOutcome;
}

/**
 * Which statuses belong on a queue at all.
 *
 * The same rule `resumableImports` encodes, asked of one row: a `done`, `cancelled` or `failed`
 * import has nothing to run, and `awaiting_confirm` / `awaiting_review` / a pause the *owner*
 * asked for are all waiting on a person. Bumping any of them raises the priority for whenever
 * they do move again, and sends nothing — a bump is not a way to restart something somebody
 * deliberately stopped.
 */
function belongsOnQueue(job: Import): boolean {
  if (job.status === "paused") return job.pausedBy === "worker";
  return job.status === "pending" || job.status === "running" || job.status === "waiting_upstream";
}

/**
 * Move an import to the front of the queue — the row **and** the message.
 *
 * It used to be the row alone: `imports.priority += by`, a journal line, done. Nothing read that
 * column when enqueuing (`enqueueImportStep` takes a priority from its caller, and only the
 * resume sweep ever passed one), so the message already sitting on `import.step` kept the 0 it
 * was sent with and the import did not move. Ten of the owner's did not move.
 *
 * Both halves are now written, and they mean different things: the **column** is the durable
 * record, read by the resume sweep the next time a message has to be created; the **message** is
 * the thing pg-boss is about to fetch, and `reprioritiseImport` edits it in place. The journal
 * line says which of the four things actually happened, because "Priority raised to 10" was true
 * and useless — it is exactly what the broken version printed.
 */
export async function bumpImport(
  importId: string,
  by = 10,
  db: Database = defaultDb(),
): Promise<BumpResult> {
  const job = await requireImport(importId, db);
  const priority = job.priority + by;
  await db.update(imports).set({ priority, updatedAt: new Date() }).where(eq(imports.id, importId));

  const queue = await bumpQueuedImport(importId, priority, {
    send: belongsOnQueue(job),
    reason: "bump",
  });

  await emit(
    {
      importId,
      type: "import.status",
      message: `Priority raised to ${String(priority)}: ${bumpSentence(queue)}`,
      data: { ...queue, priority },
    },
    db,
  );
  return { priority, queue };
}

/** The half of the journal line that says what bump did to the queue, and not just to the row. */
function bumpSentence(outcome: BumpOutcome): string {
  const removed =
    outcome.removed === 0
      ? ""
      : ` ${String(outcome.removed)} duplicate message(s) on the same import were removed.`;
  switch (outcome.action) {
    case "reprioritised":
      return `the message waiting on ${outcome.queue ?? "the queue"} was re-prioritised.${removed}`;
    case "sent":
      return `nothing was on a queue, so one message was sent to ${outcome.queue ?? "the queue"}.${removed}`;
    case "running":
      return `the worker is already running this import, so its message could not move; the new priority applies to whatever is queued next.${removed}`;
    case "none":
      return `nothing is on a queue and this import is not waiting for one, so the priority applies to whatever is queued next.${removed}`;
  }
}

/**
 * Why an import is on the resume list. One word per way a restart can lose a job.
 *
 *  - **`paused-by-shutdown`** — the last worker paused it on its way out (`pauseImport(…,
 *    "worker")`, or a step that returned `blocked` on the abort signal). The row is honest and
 *    nothing is in flight; it needs a message, and nobody was ever going to send one.
 *  - **`waiting-upstream-due`** — the job was sitting out a busy source. Its *delayed* pg-boss
 *    message was deleted with the rest of the queue at boot, so the wait has to be re-sent
 *    from `imports.next_attempt_at`. Due now departs now; still in the future departs late.
 *  - **`running-orphan`** — `pending` or `running` with nobody working on it: the worker was
 *    killed mid-job, and `retryLimit: 0` means pg-boss will never put it back by itself.
 */
export const RESUME_REASONS = [
  "paused-by-shutdown",
  "waiting-upstream-due",
  "running-orphan",
] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/** One import the sweep should re-queue, and the sentence that says why. */
export interface ResumableImport {
  readonly job: Import;
  readonly reason: ResumeReason;
}

/**
 * Jobs a worker should pick up when it starts.
 *
 * A worker that dies mid-step leaves an import in `running` with nobody working on it. Since
 * the database is the memory, "resume" is simply: find those, and run them again.
 *
 * It used to select `pending | running` and only those, which lost the two other ways a
 * restart eats a job. `waiting_upstream` was the loud one: the sweep already knew how to
 * honour `next_attempt_at` — the code and its comment are still in `worker/index.ts` — and
 * the query never handed it a single row to honour it for, so nine imports sat with an
 * attempt time an hour in the past and no message to make it happen. `paused` was the quiet
 * one: the worker pauses what it is running as it shuts down, which is the right row to
 * write, and nothing ever read those pauses back.
 *
 * A pause the *owner* asked for is deliberately absent: `paused_by = 'user'` means leave it
 * alone, and a deploy is not permission to restart it. The two human gates
 * (`awaiting_confirm`, `awaiting_review`) are absent for the same reason, and the three
 * terminal statuses because they are terminal.
 */
export async function resumableImports(
  db: Database = defaultDb(),
  options: { idleSince?: Date } = {},
): Promise<ResumableImport[]> {
  const resumable = or(
    inArray(imports.status, ["pending", "running", "waiting_upstream"]),
    and(eq(imports.status, "paused"), eq(imports.pausedBy, "worker")),
  );
  /*
   * "…and has not moved since". Only the periodic reconciliation asks for it.
   *
   * At boot every row qualifies, because the queues have just been emptied and nothing can be
   * in flight. In a *running* worker the same list is full of imports that are perfectly
   * healthy, so the periodic pass narrows it to rows that have stopped moving — one more
   * predicate on the same index, and in practice an empty result.
   *
   * `coalesce(next_attempt_at, updated_at)` rather than `updated_at`: a `waiting_upstream` row
   * is *supposed* to sit still, and its due date is the only honest measure of lateness. The
   * column is null on every other status, so the fallback is what applies there.
   */
  const idle =
    options.idleSince === undefined
      ? undefined
      : // The cast is not decoration: the left-hand side is raw SQL, so Drizzle has no column
        // to take the parameter type from and hands postgres-js a `Date` it cannot encode.
        sql`coalesce(${imports.nextAttemptAt}, ${imports.updatedAt}) < ${options.idleSince.toISOString()}::timestamptz`;
  const rows = await db
    .select()
    .from(imports)
    .where(idle === undefined ? resumable : and(resumable, idle))
    .orderBy(desc(imports.priority), asc(imports.createdAt));
  return rows.map((job) => ({ job, reason: resumeReasonOf(job) }));
}

/** The reason that goes in the log and in the journal, read off the row. */
function resumeReasonOf(job: Import): ResumeReason {
  if (job.status === "paused") return "paused-by-shutdown";
  if (job.status === "waiting_upstream") return "waiting-upstream-due";
  return "running-orphan";
}

/** Every step row of an import, for `mm job`. */
export async function stepsOf(importId: string, db: Database = defaultDb()) {
  const rows = await db.select().from(jobSteps).where(eq(jobSteps.importId, importId));
  const byName = new Map(rows.map((row) => [row.step, row]));
  return STEP_ORDER.map((step) => ({ step, row: byName.get(step) ?? null }));
}

/** What `listImports` and `countImports` both narrow on, so a page and its total agree. */
export interface ImportFilter {
  readonly status?: ImportStatus;
  /**
   * Several statuses at once, for a named group rather than one value — the Console's
   * "Active" chip is `pending | running | awaiting_* | waiting_upstream`. Ignored when it is
   * empty, so `{statuses: []}` is "no filter" and never "match nothing".
   */
  readonly statuses?: readonly ImportStatus[];
  /** Substring of the title or the URL, case-insensitive. */
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * The `where` of a filtered list, written once.
 *
 * `q` used to be applied in TypeScript over whatever window had been fetched, which meant the
 * filter only saw the page and a client could not be told how many rows really matched. It is
 * SQL now, so `countImports` counts the same set `listImports` returns.
 *
 * Exported because the Console's job list needs the same guarantee with a different ordering:
 * `console.queries` builds its page from this `where` and takes its total from `countImports`,
 * so the chip counts, the total and the rows on screen can never describe three different
 * sets.
 */
export function importsWhere(filter: ImportFilter) {
  const text = filter.q?.trim() ?? "";
  const group = filter.statuses ?? [];
  const clauses = [
    filter.status !== undefined
      ? eq(imports.status, filter.status)
      : group.length > 0
        ? inArray(imports.status, [...group])
        : isNotNull(imports.id),
    ...(text === ""
      ? []
      : [
          or(ilike(imports.title, `%${text}%`), ilike(imports.url, `%${text}%`)) ??
            isNotNull(imports.id),
        ]),
  ];
  return and(...clauses);
}

/** The job list, newest first. */
export async function listImports(
  filter: ImportFilter = {},
  db: Database = defaultDb(),
): Promise<Import[]> {
  return await db
    .select()
    .from(imports)
    .where(importsWhere(filter))
    .orderBy(desc(imports.createdAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
}

/**
 * How many imports match, ignoring `limit` and `offset`.
 *
 * A client cannot page without it: `GET /api/v1/imports` answered fifty rows and no total, so
 * the owner's bulk session read the fifty most recent imports and concluded that was all of
 * them. Counted in SQL rather than by fetching and measuring, because the whole point is to
 * know the size of a set too large to fetch.
 */
export async function countImports(
  filter: ImportFilter = {},
  db: Database = defaultDb(),
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(imports).where(importsWhere(filter));
  return row?.total ?? 0;
}

export { loadSettings, type Settings };
