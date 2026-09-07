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
  announce,
  failSettled,
  handOverToVerify,
  nextStepOfTrack,
  pauseForReview,
  resumableImports,
  runImport,
  runStep,
  runTrackStep,
  settleImport,
  syncLocalSteps,
  type RunOutcome,
} from "#/server/services/jobs/index.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { beatWorker } from "#/server/services/status.ts";
import { toolbox } from "#/server/toolbox/client.ts";

/** How often the worker says it is alive. A third of `WORKER_STALE_MS`, so one miss is fine. */
const WORKER_BEAT_MS = 30_000;
import { enqueueScan, handleScan, handleYtdlpUpdate, type ScanJob } from "./handlers/scan.ts";
import { deliver as deliverWebhook } from "#/server/services/webhooks.ts";
import {
  createBoss,
  CRON_QUEUES,
  ensureQueues,
  enqueueDownload,
  enqueueImportStep,
  enqueueTrackStep,
  QUEUES,
  stopBoss,
  type DownloadJob,
  type ImportStepJob,
  type TrackStepJob,
  type WebhookJob,
} from "./queues.ts";
import { queueOutdated, registerRetagHandlers } from "./handlers/retag.ts";
import { cleanupEmptyRetagRuns } from "#/server/services/retag.ts";
import { registerMigrateHandlers } from "./handlers/migrate.ts";
import { registerDiscoverHandlers } from "./handlers/discover.ts";

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

  /* ---- clear what the last worker left behind, *before* consuming anything ---- */
  //
  // A worker killed mid-download leaves its `download` job in the active state. The queue's
  // policy is `singleton`, so that ghost would block every later download until it expired —
  // six hours. Clearing the two queues is safe because `docs/06-stack.md` states the rule this
  // whole design rests on: **one orchestrator**. Nothing is lost either: the jobs carry only an
  // import id, and the imports themselves are re-queued at the end of this function.
  // `deleteAllJobs` and not `deleteQueuedJobs`: the latter only removes jobs *before* the
  // active state, which is precisely the one the ghost is in.
  //
  // **This must happen before the first `boss.work`.** It used to sit after all of them, and
  // registering a consumer starts a poller immediately — so the worker raced its own cleanup
  // and won often enough to matter: it picked up the very ghost it was about to delete, ran a
  // `download` step for it, and then deleted the queue row out from under its own running
  // handler. On this checkout that meant a *cancelled* import taking the single download slot
  // for a minute while two legitimate jobs sat in `created`, which is the owner's C4 —
  // "les pistes sortent en 3 fois" — with a different first domino.
  for (const queue of [QUEUES.importStep, QUEUES.download, QUEUES.trackStep]) {
    await boss.deleteAllJobs(queue);
  }

  // A run with nothing in scope is closed on arrival since 2026-09-07 (`createRun`), but a row
  // opened before that fix is still `pending` and nothing will ever queue it — `total = 0` means
  // no caller calls `enqueueRetagRun`. One sweep here closes any that are left over.
  const closedEmptyRuns = await cleanupEmptyRetagRuns(db());
  if (closedEmptyRuns > 0) {
    log("closed stale empty re-tag run(s)", { count: closedEmptyRuns });
  }

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

  /**
   * Decide what an import does now that one of its tracks has stopped moving.
   *
   * Called after every per-track step and at the end of `download`. `settleImport` answers
   * `wait` for as long as anything is still in flight, so this is a cheap read most of the
   * time; the three other answers are the only ways an import ends on the pipelined path.
   */
  const advance = async (importId: string): Promise<void> => {
    const settlement = await settleImport(db(), importId);
    switch (settlement.action) {
      case "wait":
        return;
      case "review":
        // The owner's D5, literally: a fingerprint disagreement pauses *its track*, and the
        // import turns `awaiting_review` only once everything else has finished — never while
        // there are still files to fetch.
        log("awaiting review", { importId, mismatches: settlement.tracks });
        await pauseForReview(db(), importId, settlement.tracks);
        return;
      case "failed": {
        const { step, result } = await failSettled(db(), importId, settlement.tracks);
        log("import failed", { importId, step, tracks: settlement.tracks });
        await announce(db(), importId, step, "failed", result);
        return;
      }
      case "finish":
        // `trackId: null` is the album-wide tail of `tag`: one value per album-scope field and
        // ReplayGain over the whole record, neither of which a single track can answer.
        await enqueueTrackStep(boss, { importId, trackId: null, step: "tag" });
        return;
    }
  };

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
          // The message may name a job the owner cancelled or paused after it was queued;
          // pg-boss cannot know that, and the single download slot is too scarce to spend on
          // an album nobody is waiting for.
          skipIfStopped: true,
          // The pipelining hook (decision 147). One file lands, one `track.step` message goes
          // out, and the loop moves straight on to the next download: this callback is the
          // entire mechanism, and its absence is why `runImport` — the CLI and the tests — is
          // still a strictly serial pipeline.
          onTrackDownloaded: async (trackId: string) => {
            // The row decides, not the caller: a `download` that runs a second time (a Retry
            // pressed mid-album) re-announces every file it finds, and announcing a track that
            // is already being tagged as needing `fingerprint` would put a second chain behind
            // it — two `place` jobs for one file, the second finding it already moved.
            const step = await nextStepOfTrack(db(), trackId);
            if (step === null) return;
            await enqueueTrackStep(boss, { importId, trackId, step });
          },
        });
        const refused = (result.data as { refused?: string } | undefined)?.refused !== undefined;
        if (refused) continue;
        if (result.status === "done" || result.status === "skipped") {
          // The tracks are already on the `track.step` queue; `advance` only concludes the
          // import when the last of them has finished, and answers `wait` until then.
          await syncLocalSteps(db(), importId);
          await advance(importId);
        }
      }
    },
  );

  /* ---- track.step: fingerprint → tag → place, per track, several tracks at once ---- */
  //
  // `localConcurrency` is a setting because it is a judgement about *this* machine: these steps
  // are fpcalc, mutagen and a rename, so they are cheap, but they all go through the one
  // toolbox container and a number that is too high only moves the queue inside it.
  const pacing = await loadSettings(db());
  //
  // **One step at a time per track, whatever the concurrency.** The database guard
  // (`hasPassed`) refuses a step a track has already been through, but two *concurrent* runs of
  // the same step would both pass it and then race on the same file — `place` moving it twice,
  // `tag` writing it twice. Several tracks at once is the point; the same track twice never is.
  // One process consumes this queue (`docs/06-stack.md`, one orchestrator), so a set of ids is
  // the whole of the exclusion.
  const inFlight = new Set<string>();
  await boss.work<TrackStepJob>(
    QUEUES.trackStep,
    { localConcurrency: pacing.localStepConcurrency, pollingIntervalSeconds: 1 },
    async (jobs: Job<TrackStepJob>[]) => {
      for (const job of jobs) {
        const { importId, trackId, step } = job.data;
        // The album-wide tail runs once. Two tracks that finish within the same second both
        // ask for it, and `singletonKey` only deduplicates messages that are still *queued* —
        // so the second one used to arrive while the first was measuring ReplayGain and run
        // rsgain over the whole album a second time.
        const key = trackId ?? `${importId}:album`;
        if (inFlight.has(key)) {
          log("track.step already in flight", { importId, trackId, step });
          continue;
        }
        inFlight.add(key);
        try {
          if (trackId === null) {
            log("track.step album tail", { importId, jobId: job.id });
            const tail = await runStep(importId, "tag", {
              db: db(),
              signal: shutdown.signal,
              skipIfStopped: true,
            });
            // A failure is already on `job_steps` and in the journal; nothing to verify.
            if (tail.status !== "done" && tail.status !== "skipped") continue;
            if ((tail.data as { refused?: string } | undefined)?.refused !== undefined) continue;
            await handOverToVerify(db(), importId);
            await enqueueImportStep(boss, { importId, reason: "every track placed" });
            continue;
          }
          /*
           * **One message carries the whole chain**, rather than one message per step.
           *
           * A round trip through the queue costs up to a poll — a second — and three of them
           * per track is a minute of nothing happening on a fourteen-track album, which would
           * have made the pipelined path *slower* than the serial one it replaces. Looping
           * here costs nothing and makes the order within a track a property of the loop
           * rather than of the queue. Parallelism is unchanged: `localConcurrency` handlers
           * each drive one track.
           */
          log("track.step", { importId, trackId, step, jobId: job.id });
          let current: TrackStepJob["step"] | null = step;
          while (current !== null) {
            const outcome = await runTrackStep(importId, trackId, current, {
              db: db(),
              signal: shutdown.signal,
            });
            current = outcome.next;
            if (shutdown.signal.aborted) break;
          }
        } finally {
          inFlight.delete(key);
        }
        if (trackId !== null) await advance(importId);
      }
    },
  );

  /* ---- retag: the background re-projection of docs/03 §8 (P07a) ---- */
  await registerRetagHandlers(boss, { signal: shutdown.signal, log });

  /* ---- migrate: take over a v1 library and database (P11) ---- */
  await registerMigrateHandlers(boss, { db: db(), signal: shutdown.signal, log });

  /* ---- discover: the nightly recommendation refresh (P09) ---- */
  await registerDiscoverHandlers(boss, { db: db(), signal: shutdown.signal, log });

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
    "cron.discover",
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
          : name === "cron.discover"
            ? schedules.discoverCron
            : cron;
    await boss.schedule(name, expression);
  }

  /* ---- resume whatever the last worker left behind ---- */
  //
  // The queues were emptied above, before the first consumer was registered. What is left to
  // do is put the *imports* back on them, which is the whole of "resume".
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

  /*
   * The heartbeat. Nothing else in the system could answer "is anything draining the queues?",
   * so `get_status` could not either — and "queued" reads exactly like "running" from outside.
   * One row, overwritten; `unref()` so this timer is never the reason the process stays up.
   */
  await beatWorker(db());
  const heartbeat = setInterval(() => {
    void beatWorker(db()).catch((error: unknown) => {
      log("heartbeat failed", { error: MMError.from(error).message });
    });
  }, WORKER_BEAT_MS);
  heartbeat.unref?.();

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
      clearInterval(heartbeat);
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
