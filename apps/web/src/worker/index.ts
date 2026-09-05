/**
 * The worker. `bun run worker`.
 *
 * One process, one pg-boss instance, five queues. It owns no state of its own: everything it
 * needs is in Postgres, which is what lets it be killed at any moment and replaced. On start
 * it looks for imports left `running` by a worker that did not come back and picks them up —
 * that is the whole of "resume", and it is why the acceptance criteria can kill this process
 * mid-download and expect the job to carry on without re-downloading anything.
 *
 * The `download` queue is consumed with a single local worker, so this process downloads one
 * file at a time whatever else it is doing.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { emit } from "#/server/services/events.ts";
import {
  resumableImports,
  runImport,
  runStep,
  type RunOutcome,
} from "#/server/services/jobs/index.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { toolbox } from "#/server/toolbox/client.ts";
import {
  createBoss,
  CRON_QUEUES,
  ensureQueues,
  enqueueDownload,
  enqueueImportStep,
  QUEUES,
  stopBoss,
  type DownloadJob,
  type ImportStepJob,
} from "./queues.ts";

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), source: "worker", message, ...extra }),
  );
};

export interface Worker {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

/** Hand an import over to the download queue, or ask for it to be advanced again. */
async function follow(boss: PgBoss, outcome: RunOutcome, priority: number): Promise<void> {
  if (outcome.handOff === QUEUES.download) {
    await enqueueDownload(boss, { importId: outcome.importId }, { priority });
  }
}

export async function startWorker(): Promise<Worker> {
  const env = serverEnv();
  const shutdown = new AbortController();
  const boss = createBoss();

  boss.on("error", (error: unknown) => {
    log("pg-boss error", { error: MMError.from(error).message });
  });

  await boss.start();
  await ensureQueues(boss);

  /* ---- import.step: advance a job up to (but not into) the download queue ---- */
  await boss.work<ImportStepJob>(
    QUEUES.importStep,
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<ImportStepJob>[]) => {
      for (const job of jobs) {
        const { importId } = job.data;
        log("import.step", { importId, jobId: job.id });
        const outcome = await runImport(importId, {
          db: db(),
          signal: shutdown.signal,
          stopBefore: QUEUES.download,
        });
        await follow(boss, outcome, 0);
      }
    },
  );

  /* ---- download: the single global slot ---- */
  await boss.work<DownloadJob>(
    QUEUES.download,
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<DownloadJob>[]) => {
      for (const job of jobs) {
        const { importId } = job.data;
        log("download", { importId, jobId: job.id });
        const result = await runStep(importId, "download", {
          db: db(),
          signal: shutdown.signal,
        });
        // Whatever happened, the step machine has already recorded it. Ask for the job to be
        // advanced again: if it failed or blocked, `runImport` will see that and stop.
        if (result.status === "done" || result.status === "skipped") {
          await enqueueImportStep(boss, { importId, reason: "download finished" });
        }
      }
    },
  );

  /* ---- registered, not implemented yet ---- */
  for (const name of [QUEUES.retag, QUEUES.scan, ...Object.keys(CRON_QUEUES)]) {
    await boss.work(name, { localConcurrency: 1 }, async (jobs: Job<object>[]) => {
      log("queue not implemented yet", { queue: name, jobs: jobs.length });
    });
  }

  for (const [name, cron] of Object.entries(CRON_QUEUES)) {
    await boss.schedule(name, cron);
  }

  /* ---- resume whatever the last worker left behind ---- */
  const orphans = await resumableImports(db());
  for (const orphan of orphans) {
    log("resuming import", { importId: orphan.id, status: orphan.status, step: orphan.step });
    await emit(
      {
        importId: orphan.id,
        type: "import.status",
        message: `Resuming at ${orphan.step} after a worker restart.`,
        data: { step: orphan.step },
      },
      db(),
    );
    if (orphan.step === QUEUES.download) {
      await enqueueDownload(boss, { importId: orphan.id }, { priority: orphan.priority });
    } else {
      await enqueueImportStep(
        boss,
        { importId: orphan.id, reason: "resume" },
        { priority: orphan.priority },
      );
    }
  }

  const settings = await loadSettings(db());
  log("worker ready", {
    fixtures: env.MM_FIXTURES,
    toolbox: toolbox().baseUrl,
    library: settings.libraryRoot === "" ? env.MM_LIBRARY_ROOT : settings.libraryRoot,
    resumed: orphans.length,
  });

  return {
    boss,
    async stop() {
      shutdown.abort();
      // `graceful` lets the step that is running finish its current write before the
      // connection goes away; anything it did not reach is still in the database.
      await stopBoss(boss);
      log("worker stopped");
    },
  };
}

/** Run as a program: `bun run worker`. */
if (import.meta.main) {
  const worker = await startWorker();
  let stopping = false;
  const halt = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("shutting down", { signal });
    void worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log("shutdown failed", { error: MMError.from(error).message });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => halt("SIGINT"));
  process.on("SIGTERM", () => halt("SIGTERM"));
  process.on("SIGHUP", () => halt("SIGHUP"));
}
