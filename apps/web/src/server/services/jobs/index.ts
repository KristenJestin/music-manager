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
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  imports,
  jobSteps,
  type Import,
  type ImportStatus,
  type StepName,
  type StepStatus,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "#/server/services/events.ts";
import { closeItemsOf } from "#/server/services/inbox.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  isTerminal,
  resumePoint,
  stepsFrom,
  transition,
  STEP_ORDER,
  type StepResult,
} from "./machine.ts";
import { makeContext, requireImport, type ContextOptions, type StepContext } from "./context.ts";
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

  await emit(
    {
      importId,
      step,
      level: result.status === "failed" ? "error" : result.status === "blocked" ? "warn" : "info",
      type: `step.${result.status}`,
      message: result.message ?? `${step} ${result.status}`,
      data: { attempt, ...(result.data ?? {}) },
    },
    db,
  );

  await db
    .update(imports)
    .set({
      step: moved.step,
      status: moved.status,
      error: result.error ?? null,
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

/** Rewind to `step` and run from there. Every later step is forgotten, not deleted. */
export async function retryStep(
  importId: string,
  step: StepName,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const db = options.db ?? defaultDb();
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
  return await runImport(importId, options);
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
