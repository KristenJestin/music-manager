/**
 * The worker. `bun run worker`.
 *
 * One process, one pg-boss instance, five queues. It owns no state of its own: everything it
 * needs is in Postgres, which is what lets it be killed at any moment and replaced. On start
 * it empties its own queues and then puts every unfinished import back on them — the three
 * ways a restart used to eat a job, and the rule that replaces them, are in `reconcile.ts`.
 * That is the whole of "resume", and it is why the acceptance criteria can kill this process
 * mid-download and expect the job to carry on without re-downloading anything.
 *
 * The `download` queue is consumed with a single local worker, so this process downloads one
 * file at a time whatever else it is doing.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import {
  announce,
  failSettled,
  handOverToVerify,
  nextStepOfTrack,
  pauseForReview,
  runImport,
  runStep,
  runTrackStep,
  settleImport,
  syncLocalSteps,
  upstreamPolicyOf,
  type RunOutcome,
} from "#/server/services/jobs/index.ts";
import { holdOf, type UpstreamHold } from "#/server/services/jobs/upstream.ts";
import { nonZero, reconcileImports, RECONCILE_INTERVAL_MS } from "#/worker/reconcile.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { beatWorker } from "#/server/services/status.ts";
import { toolbox } from "#/server/toolbox/client.ts";

/** How often the worker says it is alive. A third of `WORKER_STALE_MS`, so one miss is fine. */
const WORKER_BEAT_MS = 30_000;

/**
 * How often the worker re-reads the cron settings.
 *
 * A minute is the resolution of a five-field cron expression, so a change can never be missed
 * by more than the smallest interval it is able to express.
 */
const SCHEDULE_POLL_MS = 60_000;

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
import { registerWatchedSourceHandlers } from "./handlers/watched-sources.ts";

const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), source: "worker", message, ...extra }),
  );
};

/**
 * The cron expression each scheduled queue should be running, as the settings say right now.
 *
 * Four of the five are settings ("3 a.m." is not 3 a.m. for everyone); `cron.refresh-sources`
 * keeps the declared weekly default, and `mm sources refresh` is how you run it out of turn.
 */
export async function scheduleExpressions(): Promise<ReadonlyMap<string, string>> {
  const settings = await loadSettings(db());
  const chosen = new Map<string, string>();
  for (const [name, declared] of Object.entries(CRON_QUEUES)) {
    chosen.set(
      name,
      name === "cron.scan"
        ? settings.scanCron
        : name === "cron.ytdlp-update"
          ? settings.ytdlpUpdateCron
          : name === "cron.discover"
            ? settings.discoverCron
            : name === "cron.watched-sources"
              ? settings.watchedSourcesCron
              : declared,
    );
  }
  return chosen;
}

/**
 * Push the current expressions into pg-boss, writing only what changed.
 *
 * `applied` is the worker's memory of what it last wrote, so the common case — nothing edited
 * since the last poll — costs one `settings` read and no scheduler write at all.
 */
async function applySchedules(boss: PgBoss, applied: Map<string, string>): Promise<void> {
  for (const [name, expression] of await scheduleExpressions()) {
    if (applied.get(name) === expression) continue;
    await boss.schedule(name, expression);
    if (applied.has(name)) {
      log("cron schedule changed", { queue: name, cron: expression });
    }
    applied.set(name, expression);
  }
}

export interface Worker {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Put one import back on the queue after a source refused it.
 *
 * The delay is pg-boss's, not a timer in this process: the worker may be restarted or
 * replaced during the wait, and `imports.next_attempt_at` is what makes that survivable. The
 * `singletonKey` is the import, so a Retry pressed meanwhile replaces this message rather
 * than racing it.
 */
async function holdOn(
  boss: PgBoss,
  importId: string,
  hold: UpstreamHold,
  priority = 0,
): Promise<void> {
  log("waiting on a source", {
    importId,
    source: hold.source,
    attempt: hold.attempt,
    of: hold.maxAttempts,
    inSeconds: Math.round(hold.delayMs / 1000),
  });
  await enqueueImportStep(
    boss,
    { importId, reason: `upstream backoff (attempt ${String(hold.attempt)})` },
    { priority, startAfterSeconds: hold.delayMs / 1000 },
  );
}

/** Hand an import over to the download queue, or ask for it to be advanced again. */
async function follow(boss: PgBoss, outcome: RunOutcome, priority: number): Promise<void> {
  if (outcome.hold !== null) {
    await holdOn(boss, outcome.importId, outcome.hold, priority);
    return;
  }
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
        // The same rule as on the serial path, applied where a *track* is what broke: a `tag`
        // that could not reach MusicBrainz is a wait, and the tracks it broke go back on the
        // line. `failSettled` does the classifying; the queue handle lives here.
        const policy = upstreamPolicyOf(await loadSettings(db()));
        const { step, result, hold } = await failSettled(db(), importId, settlement.tracks, policy);
        if (hold !== null) {
          await holdOn(boss, importId, hold);
          return;
        }
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
        // A download refused by the toolbox or by a source that is busy: `runStep` has already
        // parked the job, and this queue's job is only to ask for it again at the right time.
        const held = holdOf(result.data);
        if (held !== null) {
          await holdOn(boss, importId, held);
          continue;
        }
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
            const tailHold = holdOf(tail.data);
            if (tailHold !== null) {
              await holdOn(boss, importId, tailHold);
              continue;
            }
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

  /* ---- watched sources: the six-hourly scan of the playlists and channels ---- */
  await registerWatchedSourceHandlers(boss, { db: db(), signal: shutdown.signal, log, boss });

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
    "cron.watched-sources",
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
  const applied = new Map<string, string>();
  await applySchedules(boss, applied);

  /*
   * Re-read them once a minute.
   *
   * The expressions were read exactly once, at boot. Editing `scanCron` or `discoverCron` in
   * the Console therefore changed a row and nothing else, and the worker went on running the
   * old schedule until somebody restarted it — with no page saying so, which is the worst
   * version of that bug. `boss.schedule` is an upsert keyed by queue name, so re-applying an
   * unchanged expression is free; `applied` is what keeps us from writing when nothing moved.
   */
  const rescheduler = setInterval(() => {
    void applySchedules(boss, applied).catch((error: unknown) => {
      log("could not re-read the cron schedules", { error: MMError.from(error).message });
    });
  }, SCHEDULE_POLL_MS);
  rescheduler.unref?.();

  /* ---- resume whatever the last worker left behind ---- */
  //
  // The queues were emptied above, before the first consumer was registered. What is left to
  // do is put the *imports* back on them, which is the whole of "resume". `reconcile.ts` owns
  // the rule and the three reasons; this is the boot occurrence of it.
  const boot = await reconcileImports(boss, { db: db(), trigger: "boot", log });
  log("resume sweep", {
    trigger: boot.trigger,
    resumed: boot.resumed,
    skipped: boot.skipped,
    ...nonZero(boot.byReason),
  });

  /*
   * …and again every two minutes, because a boot is not the only way a message goes missing.
   *
   * `retryLimit: 0` is the right policy — a half-done download must not restart itself — but
   * it also means that a handler which dies without completing its job leaves nothing behind
   * to try again, and the import would wait for the next deploy. That is exactly what the
   * owner's external poller was covering, and it belongs in here.
   *
   * Three things keep it from becoming the bug it is meant to fix. It only looks at rows that
   * have not moved for ten minutes, so it never races the work this same process is doing. It
   * reads pg-boss's ledger before sending, so an import that already holds a message is left
   * alone. And it starts only after the boot sweep has returned, so the two cannot interleave.
   */
  const reconciler = setInterval(() => {
    void reconcileImports(boss, { db: db(), trigger: "periodic", log })
      .then((report) => {
        // Silent when it found nothing to do, which is every run on a healthy installation.
        if (report.resumed === 0) return;
        log("resume sweep", {
          trigger: report.trigger,
          resumed: report.resumed,
          skipped: report.skipped,
          ...nonZero(report.byReason),
        });
      })
      .catch((error: unknown) => {
        log("reconciliation sweep failed", { error: MMError.from(error).message });
      });
  }, RECONCILE_INTERVAL_MS);
  reconciler.unref?.();

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
    resumed: boot.resumed,
    resumedBy: nonZero(boot.byReason),
  });

  return {
    boss,
    async stop() {
      shutdown.abort();
      clearInterval(heartbeat);
      clearInterval(rescheduler);
      clearInterval(reconciler);
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
