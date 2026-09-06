/**
 * The re-tag, from the Console (`docs/03-metadonnees.md` §8).
 *
 * Starting a run and *doing* it are separate on purpose. These functions open the run row and
 * drop it on the `retag` queue; the worker does the work. A re-tag inside an HTTP request
 * would die with the request, and a library-wide one would time out long before it finished —
 * the same reason the wizard queues the download rather than performing it.
 *
 * The dry run is the exception people ask about: it also goes on the queue, because it opens
 * every file through the toolbox and that is exactly as slow as the real thing minus the
 * write. What comes back immediately is the run id; the page then follows the run.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { RETAG_SCOPES, type RetagDiff, type RetagRun } from "#/server/db/schema/index.ts";
import { createBoss, stopBoss } from "#/worker/queues.ts";
import { enqueueRetag } from "#/worker/handlers/retag.ts";
import { cancelRun, getRun, listRuns, planRetag, runView } from "#/server/services/retag.ts";
import { filesBehindCount } from "#/server/services/quality.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { createRun } from "#/server/services/retag.ts";

export interface StartedRun {
  readonly runId: string;
  readonly total: number;
  readonly dryRun: boolean;
  readonly schemaVersion: number;
}

/**
 * Open a run and queue it.
 *
 * The boss instance is a **producer**: no supervision, no scheduler, two connections. A web
 * request that built a full pg-boss would quietly become a second worker, and `docs/06-stack.md`
 * allows exactly one.
 */
export const startRetag = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      scope: z.enum(RETAG_SCOPES).default("library"),
      targetId: z.string().nullable().default(null),
      dryRun: z.boolean().default(false),
      /** `false` re-projects everything in scope, not only what is behind. */
      onlyBehind: z.boolean().default(true),
    }),
  )
  .handler(async ({ data }): Promise<StartedRun> => {
    try {
      if (data.scope !== "library" && (data.targetId === null || data.targetId === "")) {
        throw new MMError("INVALID_INPUT", `A ${data.scope} re-tag needs a ${data.scope} id.`);
      }
      const settings = await loadSettings(db());
      const run = await createRun({
        db: db(),
        settings,
        scope: data.scope,
        targetId: data.targetId,
        dryRun: data.dryRun,
        onlyBehind: data.onlyBehind,
        trigger: "manual",
      });

      const boss = createBoss({ producer: true });
      try {
        await boss.start();
        await enqueueRetag(boss, { runId: run.id });
      } finally {
        await stopBoss(boss);
      }

      return {
        runId: run.id,
        total: run.total,
        dryRun: run.dryRun,
        schemaVersion: run.schemaVersion,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** How many files a run *would* touch, without opening one. Used to label the button. */
export const previewRetag = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      scope: z.enum(RETAG_SCOPES).default("library"),
      targetId: z.string().nullable().default(null),
      onlyBehind: z.boolean().default(true),
    }),
  )
  .handler(async ({ data }): Promise<{ files: number; behind: number; total: number }> => {
    try {
      const settings = await loadSettings(db());
      const [targets, counts] = await Promise.all([
        planRetag({
          db: db(),
          settings,
          scope: data.scope,
          targetId: data.targetId,
          onlyBehind: data.onlyBehind,
        }),
        filesBehindCount({ db: db(), settings }),
      ]);
      return { files: targets.length, behind: counts.behind, total: counts.total };
    } catch (error) {
      return toFailure(error);
    }
  });

export interface RunDiffLine {
  readonly id: string;
  readonly path: string;
  readonly added: readonly { key: string; field?: string; after?: string }[];
  readonly removed: readonly { key: string; before?: string }[];
  readonly changed: readonly { key: string; field?: string; before?: string; after?: string }[];
  readonly unchanged: number;
  readonly wrote: boolean;
  readonly schemaBefore: number | null;
  readonly schemaAfter: number | null;
  readonly error: string | null;
}

export interface RunPayload {
  readonly run: {
    readonly id: string;
    readonly scope: string;
    readonly targetId: string | null;
    readonly trigger: string;
    readonly dryRun: boolean;
    readonly status: string;
    readonly schemaVersion: number;
    readonly total: number;
    readonly done: number;
    readonly changed: number;
    readonly failed: number;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  };
  readonly diffs: readonly RunDiffLine[];
}

function toRun(run: RetagRun): RunPayload["run"] {
  return {
    id: run.id,
    scope: run.scope,
    targetId: run.targetId,
    trigger: run.trigger,
    dryRun: run.dryRun,
    status: run.status,
    schemaVersion: run.schemaVersion,
    total: run.total,
    done: run.done,
    changed: run.changed,
    failed: run.failed,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function toDiff(diff: RetagDiff): RunDiffLine {
  return {
    id: diff.id,
    path: diff.path,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged,
    wrote: diff.wrote,
    schemaBefore: diff.schemaBefore,
    schemaAfter: diff.schemaAfter,
    error: diff.error?.message ?? null,
  };
}

/** One run and its per-file diffs — the panel a dry run exists to fill. */
export const fetchRun = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<RunPayload | null> => {
    try {
      const view = await runView(data.id, {}, db());
      if (view === null) return null;
      return { run: toRun(view.run), diffs: view.diffs.map(toDiff) };
    } catch (error) {
      return toFailure(error);
    }
  });

/** Just the counters — what a progress bar polls between SSE frames. */
export const fetchRunStatus = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<RunPayload["run"] | null> => {
    try {
      const run = await getRun(data.id, db());
      return run === null ? null : toRun(run);
    } catch (error) {
      return toFailure(error);
    }
  });

export const fetchRuns = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ albumId: z.string().optional(), limit: z.number().int().default(10) }))
  .handler(async ({ data }): Promise<readonly RunPayload["run"][]> => {
    try {
      const runs = await listRuns(
        {
          limit: data.limit,
          ...(data.albumId === undefined ? {} : { albumId: data.albumId }),
        },
        db(),
      );
      return runs.map(toRun);
    } catch (error) {
      return toFailure(error);
    }
  });

/** Stop a run. The batch in flight finishes its current file and then notices. */
export const stopRetag = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ cancelled: boolean }> => {
    try {
      const run = await cancelRun(data.id, db());
      return { cancelled: run !== null };
    } catch (error) {
      return toFailure(error);
    }
  });
