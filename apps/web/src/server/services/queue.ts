/**
 * Putting an import back on a queue, from the web process.
 *
 * Its own module rather than a helper inside `server/functions/jobs.ts`, and that is not
 * tidiness: a **non-handler export** of a server-function module survives the client split,
 * and this one drags `pg-boss`, `postgres` and the whole environment schema into the browser
 * bundle with it. Only the handler bodies are replaced by RPC stubs; anything else the module
 * exports is ordinary code, and ordinary code that imports a Postgres driver is a broken
 * build. Keeping it here means the functions import it *for use inside a handler only*, and
 * the import disappears with the handler.
 *
 * A short-lived producer client per call, rather than one held open by the web process: the
 * Console enqueues a handful of times an hour, and a connection that exists only while it is
 * needed cannot leak when the request that opened it is abandoned.
 */
import type { StepName } from "#/server/db/schema/enums.ts";
import {
  createBoss,
  ensureQueues,
  enqueueDownload,
  enqueueImportStep,
  stopBoss,
} from "#/worker/queues.ts";

/**
 * Ask for a library scan (P07b).
 *
 * The queue is `singleton`, so pressing "Scan now" while the nightly run is going joins it
 * rather than starting a second walk of the same tree.
 */
export async function enqueueLibraryScan(
  job: { trigger?: string; driftLimit?: number } = {},
): Promise<string | null> {
  const boss = createBoss({ producer: true });
  try {
    await boss.start();
    await ensureQueues(boss);
    return await boss.send("scan", job, { singletonKey: "library-scan", retryLimit: 0 });
  } finally {
    await stopBoss(boss);
  }
}

export async function enqueue(importId: string, reason: string, step?: StepName): Promise<void> {
  const boss = createBoss({ producer: true });
  try {
    await boss.start();
    // The web process may well be the first thing to run: pg-boss refuses to send to a queue
    // that was never declared, and the worker is what usually declares them.
    await ensureQueues(boss);
    if (step === "download") await enqueueDownload(boss, { importId });
    else {
      await enqueueImportStep(boss, {
        importId,
        reason,
        ...(step === undefined ? {} : { step }),
      });
    }
  } finally {
    await stopBoss(boss);
  }
}
