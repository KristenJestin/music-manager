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
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
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
  type StepName,
  type StepStatus,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "#/server/services/events.ts";
import { closeItemsOf, openInboxItem } from "#/server/services/inbox.ts";
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
 */
export async function runStep(
  importId: string,
  step: StepName,
  options: ContextOptions = {},
): Promise<StepResult> {
  const db = options.db ?? defaultDb();
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
  await endStep(db, importId, step, result, moved.stepStatus);

  // A failure the machine is going to repair by itself (`restartAt`) is a warning, not an
  // error: it does not stop the job, so a red line in the journal would be a lie.
  const repaired = result.status === "failed" && moved.continues;

  await emit(
    {
      importId,
      step,
      level: repaired
        ? "warn"
        : result.status === "failed"
          ? "error"
          : result.status === "blocked"
            ? "warn"
            : "info",
      type: repaired ? "step.restarting" : `step.${result.status}`,
      message: result.message ?? `${step} ${result.status}`,
      data: { attempt, restartAt: moved.step, ...(result.data ?? {}) },
    },
    db,
  );

  await db
    .update(imports)
    .set({
      step: moved.step,
      status: moved.status,
      // The row's `error` is "why this job is stopped". A job the machine is rewinding is not
      // stopped, so it must not carry one — the Console paints it as a red banner.
      error: moved.continues ? null : (result.error ?? null),
      updatedAt: new Date(),
      ...(isTerminal(moved.status) ? { finishedAt: new Date() } : {}),
    })
    .where(eq(imports.id, importId));

  // The import-level line is emitted here rather than in the loop, because `download` runs on
  // its own queue and never goes through the loop at all: a failure there has to close the
  // job for anyone following it just as clearly as a failure anywhere else.
  if (!moved.continues) await announce(db, importId, step, moved.status, result);

  return result;
}

/** One journal line saying the import as a whole stopped, and why. */
async function announce(
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
    return { importId, status: job.status, step: job.step, ran, handOff: null };
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
      await pauseImport(importId, "the worker is shutting down", db);
      break;
    }
    if (step === options.stopBefore) {
      // Not an interruption: the job changes queue. `download` is global and single-file, so
      // it is executed by the one worker slot that owns that queue, not by this one.
      return { importId, status: "running", step, ran, handOff: step };
    }

    const result = await runStep(importId, step, { ...options, settings, db });
    ran.push({ step, result });

    const moved = transition(step, result);
    if (!moved.continues) {
      return { importId, status: moved.status, step: moved.step, ran, handOff: null };
    }

    step = moved.step;
    if (options.only === true) {
      return { importId, status: "running", step, ran, handOff: null };
    }
  }

  const current = await requireImport(importId, db);
  return { importId, status: current.status, step: current.step, ran, handOff: null };
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
      error: null,
      finishedAt: null,
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

/** Stop a job where it stands. It can be picked up again. */
export async function pauseImport(
  importId: string,
  reason = "paused",
  db: Database = defaultDb(),
): Promise<void> {
  await db
    .update(imports)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(imports.id, importId), ne(imports.status, "done")));
  await emit({ importId, level: "warn", type: "import.status", message: reason }, db);
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

/** Raise a job's priority so the queue takes it first. */
export async function bumpImport(
  importId: string,
  by = 10,
  db: Database = defaultDb(),
): Promise<number> {
  const job = await requireImport(importId, db);
  const priority = job.priority + by;
  await db.update(imports).set({ priority, updatedAt: new Date() }).where(eq(imports.id, importId));
  await emit(
    { importId, type: "import.status", message: `Priority raised to ${String(priority)}.` },
    db,
  );
  return priority;
}

/**
 * Jobs a worker should pick up when it starts.
 *
 * A worker that dies mid-step leaves an import in `running` with nobody working on it. Since
 * the database is the memory, "resume" is simply: find those, and run them again.
 */
export async function resumableImports(db: Database = defaultDb()): Promise<Import[]> {
  return await db
    .select()
    .from(imports)
    .where(inArray(imports.status, ["pending", "running"]))
    .orderBy(desc(imports.priority), asc(imports.createdAt));
}

/** Every step row of an import, for `mm job`. */
export async function stepsOf(importId: string, db: Database = defaultDb()) {
  const rows = await db.select().from(jobSteps).where(eq(jobSteps.importId, importId));
  const byName = new Map(rows.map((row) => [row.step, row]));
  return STEP_ORDER.map((step) => ({ step, row: byName.get(step) ?? null }));
}

/** The job list, newest first. */
export async function listImports(
  filter: { status?: ImportStatus; limit?: number } = {},
  db: Database = defaultDb(),
): Promise<Import[]> {
  return await db
    .select()
    .from(imports)
    .where(filter.status === undefined ? isNotNull(imports.id) : eq(imports.status, filter.status))
    .orderBy(desc(imports.createdAt))
    .limit(filter.limit ?? 50);
}

export { loadSettings, type Settings };
