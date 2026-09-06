/**
 * The server functions behind `/tools`.
 *
 * One `fetchTools` for the page load and one function per button. The page load runs every
 * probe **in parallel and never fails**: a Tools page that 500s because MusicBrainz is slow
 * would be the exact opposite of a diagnostics page. Each card carries its own error instead.
 *
 * Only handlers and types leave this module — a non-handler export would survive the client
 * split and drag Drizzle and pg-boss into the browser bundle (`server/functions/base.ts`).
 */
import { z } from "zod";
import type { JobEventPayload } from "@mm/contracts";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  navidromeStatus,
  requestRescan,
  type NavidromeStatus,
} from "#/server/services/navidrome.ts";
import { enqueueLibraryScan } from "#/server/services/queue.ts";
import { verificationSummary } from "#/server/services/verify.ts";
import {
  identifyOrphan,
  lastScan,
  libraryCounts,
  recentScans,
  reportOf,
  trashFile,
  type ScanReport,
} from "#/server/services/scan.ts";
import { loadSettings } from "#/server/services/settings.ts";
import {
  cookiesStatus,
  downloaderHealth,
  errorCatalog,
  selftest,
  serviceLatencies,
  testUrl,
  toolboxTarget,
  updateYtdlp,
  workerLog,
  type CookiesStatus,
  type DownloaderHealth,
  type ServiceLatency,
  type UrlTest,
  type YtdlpUpdateOutcome,
} from "#/server/services/tools.ts";
import type { ErrorCatalogEntry, SelfTestResult } from "#/server/toolbox/client.ts";

export interface ToolsPayload {
  readonly downloader: DownloaderHealth;
  readonly cookies: CookiesStatus;
  readonly services: readonly ServiceLatency[];
  readonly navidrome: NavidromeStatus;
  readonly errors: readonly ErrorCatalogEntry[];
  readonly errorsProblem: string | null;
  readonly scan: {
    readonly at: string | null;
    readonly durationMs: number | null;
    readonly report: ScanReport | null;
    readonly running: boolean;
  };
  readonly library: { readonly albums: number; readonly tracks: number };
  readonly verified: {
    readonly albums: number;
    readonly withMismatch: number;
    readonly lastAt: string | null;
  };
  readonly log: readonly JobEventPayload[];
  readonly toolbox: { readonly url: string; readonly authenticated: boolean };
  /** `TAG_SCHEMA_VERSION`, and how many files are behind it — P07a owns the second number. */
  readonly tagSchema: { readonly version: number; readonly behind: number | null };
}

export const fetchTools = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<ToolsPayload> => {
    try {
      const database = db();
      const settings = await loadSettings(database);
      const deps = { db: database, settings };

      // Everything at once. A slow source must not delay the rest of the page.
      const [downloader, cookies, services, navidrome, errors, scanRow, library, log] =
        await Promise.all([
          downloaderHealth(deps),
          cookiesStatus(deps),
          serviceLatencies(deps),
          navidromeStatus(deps),
          errorCatalog(deps),
          lastScan(database),
          libraryCounts(database),
          workerLog({ limit: 120 }, deps),
        ]);

      const verified = await verificationSummary(database);
      const { TAG_SCHEMA_VERSION } = await import("@mm/domain");

      return {
        downloader,
        cookies,
        services,
        navidrome,
        errors: errors.entries,
        errorsProblem: errors.error,
        scan: {
          at: scanRow?.finishedAt?.toISOString() ?? null,
          durationMs: scanRow?.durationMs ?? null,
          report: scanRow === null ? null : reportOf(scanRow),
          running: false,
        },
        library,
        verified,
        log,
        toolbox: toolboxTarget(),
        tagSchema: { version: TAG_SCHEMA_VERSION, behind: null },
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* the buttons                                                         */
/* ------------------------------------------------------------------ */

export const runYtdlpUpdate = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<YtdlpUpdateOutcome> => {
    try {
      return await updateYtdlp({ db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runSelftest = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ network: z.boolean().default(false) }).default({ network: false }))
  .handler(async ({ data }): Promise<SelfTestResult & { error: string | null }> => {
    try {
      return await selftest({ network: data.network }, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runCookiesTest = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<CookiesStatus> => {
    try {
      return await cookiesStatus({ db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runUrlTest = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ url: z.string().min(1) }))
  .handler(async ({ data }): Promise<UrlTest> => {
    try {
      return await testUrl(data.url, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runServiceLatencies = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<readonly ServiceLatency[]> => {
    try {
      return await serviceLatencies({ db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const runNavidromeRescan = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ full: z.boolean().default(false) }).default({ full: false }))
  .handler(
    async ({ data }): Promise<{ started: boolean; scanning: boolean; error: string | null }> => {
      try {
        return await requestRescan({ db: db(), full: data.full });
      } catch (error) {
        return toFailure(error);
      }
    },
  );

/* ------------------------------------------------------------------ */
/* the scan card                                                       */
/* ------------------------------------------------------------------ */

export const startScan = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({ driftLimit: z.number().int().min(0).max(100_000).optional() }).default({}),
  )
  .handler(async ({ data }): Promise<{ queued: boolean; previousScanId: string | null }> => {
    try {
      // Read *before* enqueueing: "the panel is stale until this id changes" is the only
      // honest way for the page to know the worker has finished (see `scanStatus`).
      const previous = await lastScan(db());
      const id = await enqueueLibraryScan({
        trigger: "manual",
        ...(data.driftLimit === undefined ? {} : { driftLimit: data.driftLimit }),
      });
      return { queued: id !== null, previousScanId: previous?.id ?? null };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Has the worker finished a scan yet?
 *
 * "Scan now" enqueues; the walk happens in the worker, seconds to minutes later. The page
 * invalidated its loader the instant the message was posted, so it re-read the *previous*
 * report and went on saying "never run · 0 / 0 / 0" until somebody pressed F5 (DRIVE-1 §B4).
 * A router invalidation cannot fix that — there is nothing new to read yet.
 *
 * So the button waits: it polls this, which is one indexed row, until the newest finished run
 * is not the one it started from. Cheap enough to poll, and it is the same question a person
 * answers by reloading.
 */
export const scanStatus = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ id: string | null; at: string | null; running: boolean }> => {
    try {
      const database = db();
      const [last, recent] = await Promise.all([lastScan(database), recentScans(1, database)]);
      return {
        id: last?.id ?? null,
        at: last?.startedAt.toISOString() ?? null,
        running: recent[0]?.status === "running",
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const identifyFile = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ path: z.string().min(1) }))
  .handler(async ({ data }) => {
    try {
      return await identifyOrphan(data.path, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Move a file to the trash.
 *
 * Named `trashFileAction`, and it really does move rather than unlink: a scan finding is a
 * heuristic, and a heuristic must never be allowed to destroy an original.
 */
export const trashFileAction = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ path: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ from: string; to: string }> => {
    try {
      const database = db();
      const settings = await loadSettings(database);
      const { resolvePaths } = await import("#/server/services/jobs/context.ts");
      return trashFile(resolvePaths(settings), data.path, settings.trashDir);
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Re-download a file the scan found missing, keeping the mapping.
 *
 * `docs/03-metadonnees.md` §8 is "never re-download" for *metadata*; a file that is gone from
 * the disk is the one case where the audio itself has to come back. The import track row still
 * carries its video id and its binding, so the job restarts at `download` and everything the
 * matcher decided is preserved — which is the acceptance criterion for this button.
 */
export const redownloadMissing = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ trackId: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ importId: string | null; queued: boolean }> => {
    try {
      const database = db();
      const { libraryTracks, importTracks } = await import("#/server/db/schema/index.ts");
      const { eq } = await import("drizzle-orm");
      const { enqueue } = await import("#/server/services/queue.ts");
      const { rewindTo } = await import("#/server/services/jobs/index.ts");

      const [track] = await database
        .select()
        .from(libraryTracks)
        .where(eq(libraryTracks.id, data.trackId))
        .limit(1);
      if (track === undefined || track.importId === null || track.importTrackId === null) {
        return { importId: null, queued: false };
      }

      // Put the video back to "not downloaded yet" without touching its mapping.
      await database
        .update(importTracks)
        .set({
          state: "pending",
          downloadPath: null,
          libraryPath: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(importTracks.id, track.importTrackId));

      await rewindTo(track.importId, "download", database);
      await enqueue(track.importId, "re-download of a missing file", "download");
      return { importId: track.importId, queued: true };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Fix tag drift by re-writing the projection.
 *
 * Enqueued on the `retag` queue, whose handler P07a owns: the fix for "the file says 2008 and
 * the document says 2007" is exactly the background re-tag of §8, and having two code paths
 * that write tags would be one too many.
 */
export const fixDrift = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ trackIds: z.array(z.string().min(1)).min(1) }))
  .handler(async ({ data }): Promise<{ queued: boolean; count: number; runIds: string[] }> => {
    try {
      const database = db();
      const { createRun } = await import("#/server/services/retag.ts");
      const { enqueueRetag } = await import("#/worker/handlers/retag.ts");
      const { createBoss, ensureQueues, stopBoss } = await import("#/worker/queues.ts");

      // `onlyBehind: false` — a drifted file is at the current schema version by definition;
      // what is wrong with it is the *file*, not the projection it was written from.
      const runs = [];
      for (const trackId of data.trackIds) {
        runs.push(
          await createRun({
            db: database,
            scope: "track",
            targetId: trackId,
            onlyBehind: false,
            trigger: "manual",
          }),
        );
      }

      const boss = createBoss({ producer: true });
      try {
        await boss.start();
        await ensureQueues(boss);
        for (const run of runs) await enqueueRetag(boss, { runId: run.id });
      } finally {
        await stopBoss(boss);
      }
      return { queued: true, count: data.trackIds.length, runIds: runs.map((run) => run.id) };
    } catch (error) {
      return toFailure(error);
    }
  });
