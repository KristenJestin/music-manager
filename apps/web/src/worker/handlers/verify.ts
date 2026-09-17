/**
 * The `verify.library` queue's handler: the Navidrome read-back of the whole library.
 *
 * `verify.ts`'s header has claimed since P07 that this is how "Verify library" works — *"one
 * scan and then every album, so it goes on the queue and the page follows the journal"* — and
 * until now it was not true. The server function ran `verifyLibrary` inline, in the HTTP
 * request the button made, and `verifyLibrary` is a Navidrome rescan (up to
 * `navidromeWaitTimeoutMs`, four minutes by default) followed by six or seven Subsonic calls
 * **per album**, serially, with no cap. Six hundred albums is a quarter of an hour. No request
 * timeout is the right number for that, and raising one to cover it would be pretending that
 * a fifteen-minute HTTP request is a thing.
 *
 * So the comment is now the implementation. `verifyAll` enqueues and returns; this walks the
 * library in the worker; and the page follows the journal, which is where `verifyAlbum` has
 * always written its per-album line anyway.
 *
 * A failure is logged and swallowed rather than rethrown, for the same reason as `handleScan`:
 * pg-boss would retry it, and a read-back that failed because Navidrome is down will fail
 * identically thirty seconds later. What happened is already a journal row.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { emit } from "#/server/services/events.ts";
import { verifyLibrary } from "#/server/services/verify.ts";

/** The queue's name. Owned here, next to the handler, like `scan`'s. */
export const VERIFY_QUEUE = "verify.library";

export interface VerifyJob {
  /** `manual`, `cli`. There is no cron for this one. */
  readonly trigger?: string;
  /** Ask Navidrome to rescan first. Defaults to `navidromeRescanOnVerify`. */
  readonly rescan?: boolean;
}

export interface VerifyHandlerDeps {
  readonly db?: Database;
  readonly signal?: AbortSignal;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
}

export async function handleVerifyLibrary(
  job: Job<VerifyJob>,
  deps: VerifyHandlerDeps = {},
): Promise<void> {
  const db = deps.db ?? defaultDb();
  const log = deps.log ?? (() => {});

  await emit(
    {
      type: "verify.started",
      message: "Reading the library back from Navidrome.",
      data: { trigger: job.data.trigger ?? "manual" },
    },
    db,
  );

  try {
    const report = await verifyLibrary({
      db,
      ...(job.data.rescan === undefined ? {} : { rescan: job.data.rescan }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      /*
       * Every album's line goes to the journal, which is what "the page follows the journal"
       * means: `/api/events` already streams these, and a run that takes a quarter of an hour
       * is a run somebody wants to watch rather than wait for in silence.
       */
      say: async (message) => {
        await emit({ type: "verify.progress", message }, db);
      },
    });
    log("verify done", {
      verified: report.verified,
      clean: report.clean,
      mismatch: report.withMismatch,
      notFound: report.notFound,
    });
    await emit(
      {
        type: "verify.done",
        message:
          `Read back ${String(report.verified)} album(s): ${String(report.clean)} clean, ` +
          `${String(report.withMismatch)} with a mismatch, ${String(report.notFound)} not indexed.`,
        data: {
          total: report.total,
          verified: report.verified,
          clean: report.clean,
          withMismatch: report.withMismatch,
          notFound: report.notFound,
        },
      },
      db,
    );
  } catch (error) {
    const failure = MMError.from(error);
    log("verify failed", { code: failure.code, message: failure.message });
    await emit(
      {
        type: "verify.failed",
        level: "error",
        message: failure.message,
        data: failure.toBody() as unknown as Record<string, unknown>,
      },
      db,
    );
  }
}

/**
 * Put one library read-back on the queue.
 *
 * `singletonKey` fixes it at one in flight for the whole installation, which is the same rule
 * `scan` follows and for the same reason: two whole-library read-backs at once would double
 * every Subsonic call and agree with each other about nothing.
 */
export async function enqueueVerify(boss: PgBoss, job: VerifyJob = {}): Promise<string | null> {
  return await boss.send(VERIFY_QUEUE, job, {
    singletonKey: "verify-library",
    retryLimit: 0,
    // A six-hundred-album read-back behind a four-minute rescan wait must not be reclaimed
    // while it is still running. Same ceiling as a download, and for the same reason.
    expireInSeconds: 6 * 60 * 60,
  });
}
