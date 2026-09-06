/**
 * The `scan` queue's handler, and the two crons P07 fills in.
 *
 * They live here rather than inline in `worker/index.ts` for one reason: `index.ts` is the
 * process, and a process file that also holds business logic is a file two phases end up
 * editing at once. A handler is a function of `(job, deps)`; the worker only wires it.
 *
 * The scan queue's policy is `singleton` (`worker/queues.ts`), so a manual "Scan now" while
 * the nightly run is going does not walk the library twice.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { emit } from "#/server/services/events.ts";
import { runScan, type ScanReport } from "#/server/services/scan.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { updateYtdlp } from "#/server/services/tools.ts";

export interface ScanJob {
  /** `cron`, `manual`, `cli`. */
  readonly trigger?: string;
  /** Cap on how many tracked files get probed for tag drift. */
  readonly driftLimit?: number;
}

export interface HandlerDeps {
  readonly db?: Database;
  readonly signal?: AbortSignal;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Run one scan.
 *
 * A failure is logged and swallowed rather than thrown: pg-boss would retry it, and a scan
 * that fails because a disk is unmounted will fail identically thirty seconds later. The run
 * row already carries the error, which is where somebody would look.
 */
export async function handleScan(
  job: Job<ScanJob>,
  deps: HandlerDeps = {},
): Promise<ScanReport | null> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? (() => {});
  const settings = await loadSettings(db);

  if (job.data.trigger === "cron" && !settings.scanEnabled) {
    log("scan skipped: disabled in settings");
    return null;
  }

  try {
    const { report } = await runScan({
      db,
      settings,
      trigger: job.data.trigger ?? "manual",
      ...(job.data.driftLimit === undefined ? {} : { driftLimit: job.data.driftLimit }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      say: async (message) => {
        log("scan", { message });
      },
    });
    log("scan done", {
      files: report.filesSeen,
      orphans: report.orphans.length,
      missing: report.missing.length,
      drift: report.drift.length,
    });
    return report;
  } catch (error) {
    const failure = MMError.from(error);
    log("scan failed", { error: failure.message });
    await emit(
      { type: "scan.failed", level: "error", message: `The library scan failed: ${failure.message}` },
      db,
    );
    return null;
  }
}

/**
 * The nightly yt-dlp refresh (decision 012).
 *
 * A stale downloader is the single largest cause of breakage in v1, so this runs whether or
 * not anybody is looking. The update itself happens in the toolbox, which owns the binary;
 * all this does is ask, and record the answer.
 */
export async function handleYtdlpUpdate(deps: HandlerDeps = {}): Promise<void> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? (() => {});
  const settings = await loadSettings(db);
  if (!settings.ytdlpAutoUpdate) {
    log("yt-dlp auto-update is off");
    return;
  }
  try {
    const result = await updateYtdlp({ db, settings });
    log("yt-dlp update", { from: result.from, to: result.to, updated: result.updated });
  } catch (error) {
    log("yt-dlp update failed", { error: MMError.from(error).message });
  }
}

/** Put a scan on the queue. Used by the Console, the CLI and the cron alike. */
export async function enqueueScan(
  boss: PgBoss,
  job: ScanJob = {},
): Promise<string | null> {
  return await boss.send("scan", job, { singletonKey: "library-scan", retryLimit: 0 });
}
