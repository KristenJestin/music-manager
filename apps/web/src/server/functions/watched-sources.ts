/**
 * The `/sources` pages: the list, one source, and the five things you can do to one.
 *
 * Every function declares `createServerFn` literally and takes `sessionMiddleware`, which is
 * not style — see the long note in `server/functions/base.ts`. Nothing else is exported from
 * this module for the same reason: a non-handler export survives the client split and would
 * ship Drizzle and pg-boss to the browser.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { enqueueWatchedSourceScan } from "#/server/services/queue.ts";
import {
  createWatchedSource,
  deleteWatchedSource,
  getWatchedSource,
  listWatchedSources,
  updateWatchedSource,
  watchedSourceInputSchema,
  watchedSourcePatchSchema,
  type WatchedSourceDetail,
  type WatchedSourceSummary,
} from "#/server/services/watched-sources.ts";

export const fetchWatchedSources = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ sources: readonly WatchedSourceSummary[] }> => {
    try {
      return { sources: await listWatchedSources(db()) };
    } catch (error) {
      return toFailure(error);
    }
  });

export const fetchWatchedSource = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ detail: WatchedSourceDetail | null }> => {
    try {
      return { detail: await getWatchedSource(data.id, db()) };
    } catch (error) {
      return toFailure(error);
    }
  });

export const addWatchedSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(watchedSourceInputSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    try {
      const created = await createWatchedSource(data, { db: db() });
      return { id: created.id };
    } catch (error) {
      return toFailure(error);
    }
  });

export const patchWatchedSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), patch: watchedSourcePatchSchema }))
  .handler(async ({ data }): Promise<{ id: string; autoAccept: boolean; enabled: boolean }> => {
    try {
      const updated = await updateWatchedSource(data.id, data.patch, db());
      return { id: updated.id, autoAccept: updated.autoAccept, enabled: updated.enabled };
    } catch (error) {
      return toFailure(error);
    }
  });

export const removeWatchedSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ deleted: string }> => {
    try {
      await deleteWatchedSource(data.id, db());
      return { deleted: data.id };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * "Scan now" is an **enqueue**, never a scan.
 *
 * A scan of a long channel is a flat extraction plus one import per new video, each of which
 * runs `resolve` in process. Doing that inside an HTTP request would hold the connection for
 * minutes and die with it; the worker is what owns long work here, as it does everywhere else.
 */
export const scanWatchedSourceNow = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1).optional() }))
  .handler(async ({ data }): Promise<{ queued: boolean }> => {
    try {
      const jobId = await enqueueWatchedSourceScan({
        ...(data.id === undefined ? {} : { sourceId: data.id }),
        trigger: "console",
      });
      return { queued: jobId !== null };
    } catch (error) {
      return toFailure(error);
    }
  });
