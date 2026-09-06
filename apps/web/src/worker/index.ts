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
import { enqueueScan, handleScan, handleYtdlpUpdate, type ScanJob } from "./handlers/scan.ts";
import { deliver as deliverWebhook } from "#/server/services/webhooks.ts";
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
  type WebhookJob,
} from "./queues.ts";
import { queueOutdated, registerRetagHandlers } from "./handlers/retag.ts";

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

  /* ---- retag: the background re-projection of docs/03 §8 (P07a) ---- */
  await registerRetagHandlers(boss, { signal: shutdown.signal, log });

  /* ---- scan: walk the library and reconcile it with the database (P07b) ---- */
  await boss.work<ScanJob>(
    QUEUES.scan,
    { localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<ScanJob>[]) => {
      for (const job of jobs) {
        log("scan", { jobId: job.id, trigger: job.data.trigger });
        await handleScan(job, { db: db(), signal: shutdown.signal, log });
      }
    },
  );

  /* ---- the two crons P07b owns ---- */
  await boss.work("cron.scan", { localConcurrency: 1 }, async () => {
    await enqueueScan(boss, { trigger: "cron" });
  });
  await boss.work("cron.ytdlp-update", { localConcurrency: 1 }, async () => {
    await handleYtdlpUpdate({ db: db(), log });
  });

  /* ---- webhook deliveries (P08) ---- */
  //
  // The handler is deliberately thin: `deliver()` records the outcome on the row and then
  // *throws* on failure, which is what pg-boss reads as "retry me". The backoff policy is on
  // the send side (`enqueueWebhookDelivery`), so the number of attempts is one fact in one
  // place rather than a handler counter and a queue option that can drift apart.
  await boss.work<WebhookJob>(
    QUEUES.webhook,
    { localConcurrency: 4, pollingIntervalSeconds: 1 },
    async (jobs: Job<WebhookJob>[]) => {
      for (const job of jobs) {
        log("webhook.deliver", { deliveryId: job.data.deliveryId, jobId: job.id });
        await deliverWebhook(job.data.deliveryId, { db: db() });
      }
    },
  );

  /* ---- registered, not implemented yet ---- */
  const HANDLED = new Set<string>([
    QUEUES.retag,
    QUEUES.scan,
    QUEUES.webhook,
    "cron.refresh-sources",
    "cron.scan",
    "cron.ytdlp-update",
  ]);
  for (const name of [QUEUES.retag, QUEUES.scan, ...Object.keys(CRON_QUEUES)]) {
    if (HANDLED.has(name)) continue;
    await boss.work(name, { localConcurrency: 1 }, async (jobs: Job<object>[]) => {
      log("queue not implemented yet", { queue: name, jobs: jobs.length });
    });
  }

  // The nightly scan and the yt-dlp refresh follow their settings; the rest keep the
  // declared default. A cron expression is a setting because "3 a.m." is not 3 a.m. for
  // everyone, and a library scan at the wrong hour is a fan spinning up during dinner.
  const schedules = await loadSettings(db());
  for (const [name, cron] of Object.entries(CRON_QUEUES)) {
    const expression =
      name === "cron.scan"
        ? schedules.scanCron
        : name === "cron.ytdlp-update"
          ? schedules.ytdlpUpdateCron
          : cron;
    await boss.schedule(name, expression);
  }

  /* ---- resume whatever the last worker left behind ---- */
  //
  // A worker killed mid-download leaves its `download` job in the active state. The queue's
  // policy is `singleton`, so that ghost would block every later download until it expired —
  // six hours. Clearing the two queues first is safe because `docs/06-stack.md` states the
  // rule this whole design rests on: **one orchestrator**. Nothing is lost either: the jobs
  // carry only an import id, and the imports themselves are re-queued immediately below.
  // `deleteAllJobs` and not `deleteQueuedJobs`: the latter only removes jobs *before* the
  // active state, which is precisely the one the ghost is in.
  for (const queue of [QUEUES.importStep, QUEUES.download]) {
    await boss.deleteAllJobs(queue);
  }

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

  // A bump of the tag schema is noticed here rather than by a person: the version the process
  // projects to has just been read, the library says which files are behind it, and §8's whole
  // claim is that the difference is closed in the background. Nothing is queued when there is
  // nothing behind, which is the answer on every boot but the one after a bump.
  const outdated = await queueOutdated(boss, { db: db(), trigger: "schema" });
  if (outdated !== null) log("re-tag queued for files behind the tag schema", { runId: outdated });

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
