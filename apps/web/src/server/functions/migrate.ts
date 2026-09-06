/**
 * The server functions behind Tools › Migrate from v1 (P11).
 *
 * Four handlers and nothing else: a non-handler export from a server-function module survives
 * the client split and would drag Drizzle, pg-boss and the v1 reader into the browser bundle
 * (`server/functions/base.ts`). pg-boss in particular is reached through a dynamic import
 * *inside* a handler, the way `services/queue.ts` explains.
 *
 * Two rules the Console must not be able to bend, both enforced on this side:
 *
 *  - **the connection string never comes back.** It goes in, it is used, and what the page
 *    reads afterwards is `dbLabel` — the same string with its password replaced. A secret that
 *    is round-tripped through a form value ends up in a screenshot eventually;
 *  - **a real run is queued on the worker, never run in a request.** A migration is minutes on
 *    a fixture and hours on a real library; a server function that did it would be a request
 *    nobody can close.
 *
 * The dry run is queued too, for the same reason: previewing a real library means probing
 * every file in it.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  acknowledgeBackup,
  backupAcknowledged,
  listRuns,
  reportOf,
  type MigrationReport,
} from "#/server/migration/v1/index.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { loadSettings } from "#/server/services/settings.ts";

export interface MigrationRunView {
  readonly id: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly renameToTemplate: boolean;
  /** The v1 connection string with its password removed. Never the real one. */
  readonly database: string;
  readonly library: string;
  readonly message: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly migrated: number;
  readonly importsCreated: number;
  readonly orphanFiles: number;
  readonly failed: number;
  readonly writes: number;
  readonly report: MigrationReport | null;
}

export interface MigrationPayload {
  /** When somebody last confirmed they had a backup, ISO-8601. `null` blocks a real run. */
  readonly backupAcknowledgedAt: string | null;
  /** The v2 library root — the directory a real migration's `--library` has to be. */
  readonly libraryRoot: string;
  /** The newest run first. The first entry is what the card shows. */
  readonly runs: readonly MigrationRunView[];
  /** True while a run is in flight, so the card can follow it instead of offering to start one. */
  readonly running: boolean;
}

export const fetchMigration = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<MigrationPayload> => {
    try {
      const database = db();
      const settings = await loadSettings(database);
      const rows = await listRuns(10, database);
      const runs = rows.map((run): MigrationRunView => ({
        id: run.id,
        status: run.status,
        dryRun: run.dryRun,
        renameToTemplate: run.renameToTemplate,
        database: run.dbLabel,
        library: run.libraryPath,
        message: run.message,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
        durationMs: run.durationMs,
        migrated: run.migrated,
        importsCreated: run.importsCreated,
        orphanFiles: run.orphanFiles,
        failed: run.failed,
        writes: run.writes,
        report: reportOf(run),
      }));
      return {
        backupAcknowledgedAt: await backupAcknowledged(database),
        libraryRoot: resolvePaths(settings).host,
        runs,
        running: runs.some((run) => run.status === "running" || run.status === "pending"),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** Confirm a backup exists. Deliberately its own action, so it is a decision with a date. */
export const confirmMigrationBackup = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ at: string }> => {
    try {
      const at = new Date();
      await acknowledgeBackup(db(), at);
      return { at: at.toISOString() };
    } catch (error) {
      return toFailure(error);
    }
  });

const startInput = z.object({
  /** `postgres://user:password@host:5432/v1`. Used once, never stored unredacted. */
  dbUrl: z.string().min(1),
  libraryPath: z.string().min(1),
  dryRun: z.boolean().default(true),
  renameToTemplate: z.boolean().default(false),
  limit: z.number().int().min(1).max(1_000_000).optional(),
  resume: z.boolean().default(false),
  verify: z.boolean().default(false),
});

export const startMigration = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(startInput)
  .handler(async ({ data }): Promise<{ queued: boolean }> => {
    try {
      // A real run needs the acknowledgement already on file. `runMigration` checks it too —
      // this is the early, friendly refusal, before a job is queued that would only fail.
      if (!data.dryRun && (await backupAcknowledged(db())) === null) {
        return toFailure(
          new Error("Confirm you have a backup of the library before running a real migration."),
        );
      }

      const { createBoss, ensureQueues, stopBoss } = await import("#/worker/queues.ts");
      const { enqueueMigrate } = await import("#/worker/handlers/migrate.ts");
      const boss = createBoss({ producer: true });
      try {
        await boss.start();
        await ensureQueues(boss);
        const id = await enqueueMigrate(boss, {
          dbUrl: data.dbUrl,
          libraryPath: data.libraryPath,
          dryRun: data.dryRun,
          renameToTemplate: data.renameToTemplate,
          ...(data.limit === undefined ? {} : { limit: data.limit }),
          resume: data.resume,
          verify: data.verify,
          trigger: "console",
        });
        return { queued: id !== null };
      } finally {
        await stopBoss(boss);
      }
    } catch (error) {
      return toFailure(error);
    }
  });
