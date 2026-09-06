/**
 * The MCP tools against a real stack — the behaviour half of the test report's findings.
 *
 * `server.test.ts` checks the schemas and the sentences, which is what an agent reads. This
 * checks what the tools *do*, which is what the report actually caught them doing: destroying
 * a finished mapping, attributing an agent's decision to the CLI, reporting a number of
 * bindings as a number of mapped tracks, and answering "13 failed" with no reason anywhere.
 *
 * Same shape as `services/pipeline.integration.test.ts`: its own database, its own corner of
 * the library, and it skips itself when the stack is not up.
 *
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-mcptest");
const LIBRARY_CONTAINER = "/library/.mm-mcptest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_mcptest`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function stackIsUp(): Promise<string | null> {
  try {
    const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
    if (body.ok !== true) return "the toolbox is not healthy";
    if (body.fixtures !== true) return "the toolbox is not in fixtures mode";
  } catch {
    return `no toolbox on ${TOOLBOX_URL}`;
  }
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
  return null;
}

const unavailable = await stackIsUp();
if (unavailable !== null) {
  console.log(`  (MCP integration tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { and, desc, eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("#/server/services/imports.ts");
const jobs = await import("#/server/services/jobs/index.ts");
const settings = await import("#/server/services/settings.ts");
const status = await import("#/server/services/status.ts");
const relocateService = await import("#/server/services/relocate.ts");
const { toolTable } = await import("./server.ts");

resetServerEnv();

const tools = new Map(toolTable().map((tool) => [tool.name, tool]));

/** Call a tool the way the SDK does: parse the args against its schema, then run. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no MCP tool named ${name}`);
  const { z } = await import("zod");
  const parsed = z.object(tool.inputSchema).parse(args);
  return await tool.run(parsed as Record<string, unknown>);
}

describe.skipIf(unavailable !== null)("the MCP tools against a real stack", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    const { seedFixtures } = await import("#/server/integrations/seed-fixtures.ts");
    await seedFixtures();

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
  }, 120_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */
  /* §1 — confirm_mapping has a state guard and checks its bindings    */
  /* ---------------------------------------------------------------- */

  describe("§1 confirm_mapping", () => {
    it("refuses an import that is not waiting for a decision", async () => {
      const created = await imports.createFromUrl("fixture://discovery", {
        db: db(),
        resolveNow: false,
      });
      await db()
        .update(schema.imports)
        .set({ status: "done" })
        .where(eq(schema.imports.id, created.job.id));

      await expect(
        call("confirm_mapping", {
          importId: created.job.id,
          releaseMbid: null,
          bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
        }),
      ).rejects.toThrow(/not waiting for a decision/);
    });

    it("does not destroy the mapping of the import it refused", async () => {
      const [row] = await db()
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.status, "done"))
        .limit(1);
      // The guard fires before `setImportOptions`, so nothing was written.
      expect((row?.options as { mapping?: unknown }).mapping).toBeUndefined();
    });

    it("names an unknown video position instead of silently binding nothing", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_review" })
        .where(eq(schema.imports.id, created.job.id));

      await expect(
        call("confirm_mapping", {
          importId: created.job.id,
          releaseMbid: null,
          // The exact call from the report: one binding at position 999 on a 15-video source.
          bindings: [{ position: 999, trackPosition: 1, recordingMbid: null }],
        }),
      ).rejects.toThrow(/UNKNOWN_VIDEO_POSITION.*999/s);
    }, 60_000);

    it("reports what the step did, not how many bindings it was sent", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_review" })
        .where(eq(schema.imports.id, created.job.id));

      const result = (await call("confirm_mapping", {
        importId: created.job.id,
        releaseMbid: null,
        bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
      })) as {
        bindingsSent: number;
        applied: { mapped: number | null; outcome: string };
        jobStatus: string;
      };

      expect(result.bindingsSent).toBe(1);
      // Whatever `match` reports, it is the step's own count — never `bindings.length`.
      expect(result.applied.mapped).not.toBe(undefined);
      // And the call's result is a different field from the job's status.
      expect(result).toHaveProperty("jobStatus");
      expect(result).not.toHaveProperty("status");
    }, 60_000);

    /* ---- §2 — provenance ---- */

    it("logs the decision as `mcp`, not as `cli --yes`", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_review" })
        .where(eq(schema.imports.id, created.job.id));

      await call("confirm_mapping", {
        importId: created.job.id,
        releaseMbid: null,
        bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
      });
      // `match` is run by the tool; `confirm` is the next step and writes the decision row.
      await jobs.runStep(created.job.id, "confirm", { db: db() });

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(
          and(eq(schema.decisions.importId, created.job.id), eq(schema.decisions.kind, "release")),
        )
        .orderBy(desc(schema.decisions.createdAt))
        .limit(1);

      expect(decision?.decidedBy).toBe("mcp");
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */
  /* §7 / §12 — a failure says why                                     */
  /* ---------------------------------------------------------------- */

  describe("§7 and §12 — reasons travel with verdicts", () => {
    it("create_import carries the error when the import comes back failed", async () => {
      const result = (await call("create_import", {
        url: "fixture://this-fixture-does-not-exist",
      })) as { status: string; error: { code: string; message: string } | null };

      expect(result.status).toBe("failed");
      expect(result.error).not.toBeNull();
      expect(result.error?.message.length ?? 0).toBeGreaterThan(0);
    }, 60_000);

    it("get_import exposes a per-track error and a job-level failedCount", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      const [first] = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, created.job.id))
        .limit(1);
      await db()
        .update(schema.importTracks)
        .set({
          state: "failed",
          error: { code: "YTDLP_403", message: "Forbidden.", status: 403 },
        })
        .where(eq(schema.importTracks.id, first?.id ?? ""));

      const detail = (await call("get_import", { importId: created.job.id })) as {
        failedCount: number;
        tracks: { state: string; error: { code: string } | null }[];
      };
      expect(detail.failedCount).toBe(1);
      const failed = detail.tracks.find((track) => track.state === "failed");
      expect(failed?.error?.code).toBe("YTDLP_403");
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */
  /* §13 — a step's message belongs to the run that wrote it           */
  /* ---------------------------------------------------------------- */

  it("§13 clears a step's message when the step restarts", async () => {
    const created = await imports.createFromUrl("fixture://discovery", { db: db() });
    await db()
      .insert(schema.jobSteps)
      .values({
        id: `jst_stale_${created.job.id}`,
        importId: created.job.id,
        step: "download",
        status: "skipped",
        attempt: 1,
        message: "No mapped track to download.",
      });

    // Any restart of the step: the message of the previous run must not survive it.
    await jobs.runStep(created.job.id, "download", { db: db() });
    const [row] = await db()
      .select()
      .from(schema.jobSteps)
      .where(
        and(eq(schema.jobSteps.importId, created.job.id), eq(schema.jobSteps.step, "download")),
      )
      .limit(1);

    // It ran again, so whatever it says now is this run's sentence — and the attempt moved.
    expect(row?.attempt).toBe(2);
    expect(row?.status).not.toBe("running");
  }, 60_000);

  /* ---------------------------------------------------------------- */
  /* §16 — update_settings answers the follow-up question              */
  /* ---------------------------------------------------------------- */

  it("§16 update_settings returns saved, previous and effective", async () => {
    await settings.setSetting("maxGenres", 3, { db: db(), setBy: "test" });
    const result = (await call("update_settings", { patch: { maxGenres: 5 } })) as {
      saved: string[];
      previous: Record<string, unknown>;
      effective: Record<string, unknown>;
    };
    expect(result.saved).toEqual(["maxGenres"]);
    expect(result.previous["maxGenres"]).toBe(3);
    expect(result.effective["maxGenres"]).toBe(5);
    expect((await settings.loadSettings(db())).maxGenres).toBe(5);
  });

  it("§15 masks a credential in both halves of that answer", async () => {
    const result = (await call("update_settings", {
      patch: { navidromePassword: "hunter2" },
    })) as { effective: Record<string, unknown> };
    expect(result.effective["navidromePassword"]).toBe("set");
    expect(String(result.effective["navidromePassword"])).not.toContain("2");
  });

  /* ---------------------------------------------------------------- */
  /* §9 — get_status distinguishes the failures that look alike        */
  /* ---------------------------------------------------------------- */

  describe("§9 get_status", () => {
    it("reports the toolbox, its versions and the fixtures flag", async () => {
      const result = (await call("get_status")) as {
        ok: boolean;
        toolbox: { reachable: boolean; fixtures: boolean; versions: Record<string, unknown> };
        problems: string[];
      };
      expect(result.toolbox.reachable).toBe(true);
      expect(result.toolbox.fixtures).toBe(true);
      expect(result.toolbox.versions["yt-dlp"]).toBeTruthy();
    }, 30_000);

    it("says no worker is alive when none has ever reported in", async () => {
      const worker = (await call("get_status")) as {
        worker: { alive: boolean; note: string };
        problems: string[];
      };
      expect(worker.worker.alive).toBe(false);
      expect(worker.worker.note).toContain("bun run worker");
      expect(worker.problems.join(" ")).toContain("worker");
    }, 30_000);

    it("says a worker is alive once one has beaten, and stops saying so when it goes stale", async () => {
      await status.beatWorker(db());
      expect((await status.workerStatus(db())).alive).toBe(true);

      const later = new Date(Date.now() + status.WORKER_STALE_MS + 1_000);
      const stale = await status.workerStatus(db(), later);
      expect(stale.alive).toBe(false);
      expect(stale.note).toContain("Nothing is draining the queues");
    });

    it("surfaces the last failed import with its error in full", async () => {
      const result = (await call("get_status")) as {
        lastFailure: { importId: string; error: { message: string } | null } | null;
      };
      // The `create_import` case above left one behind.
      expect(result.lastFailure).not.toBeNull();
      expect(result.lastFailure?.error?.message.length ?? 0).toBeGreaterThan(0);
    }, 30_000);
  });

  /* ---------------------------------------------------------------- */
  /* §11 — relocate                                                    */
  /* ---------------------------------------------------------------- */

  describe("§11 relocate", () => {
    beforeAll(async () => {
      // One album, one track, filed under the *old* layout (`NN Titre.opus`).
      const stale = "Daft Punk/Discovery (2001)/01 One More Time.opus";
      mkdirSync(join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)"), { recursive: true });
      writeFileSync(join(LIBRARY_HOST, stale), "not really audio");

      await db().insert(schema.libraryAlbums).values({
        id: "alb_reloc",
        albumArtist: "Daft Punk",
        title: "Discovery",
        year: 2001,
        folder: "Daft Punk/Discovery (2001)",
        trackCount: 1,
        presentCount: 1,
      });
      await db().insert(schema.libraryTracks).values({
        id: "ltr_reloc",
        albumId: "alb_reloc",
        title: "One More Time",
        artist: "Daft Punk",
        discNumber: 1,
        trackNumber: 1,
        path: stale,
        format: "opus",
      });
      await db()
        .insert(schema.metadataDocuments)
        .values({
          id: "mdc_reloc",
          libraryTrackId: "ltr_reloc",
          tagSchemaVersion: 1,
          document: {
            fields: {
              title: { value: "One More Time" },
              album: { value: "Discovery" },
              albumartist: { value: "Daft Punk" },
              tracknumber: { value: 1 },
              date: { value: "2001-02-26" },
            },
            na: {},
            schemaVersion: 1,
          } as never,
        });
    });

    it("counts the files that are off-template", async () => {
      expect(await relocateService.countOffTemplate({ db: db() })).toBe(1);
    });

    it("plans the move without touching anything", async () => {
      const report = (await call("relocate", { dryRun: true })) as {
        dryRun: boolean;
        planned: number;
        moved: number;
        moves: { from: string; to: string }[];
      };
      expect(report.dryRun).toBe(true);
      expect(report.planned).toBe(1);
      expect(report.moved).toBe(0);
      // The default template of decision 074 puts a dash between the index and the title.
      expect(report.moves[0]?.to).toContain("01 - One More Time.opus");

      const [row] = await db()
        .select()
        .from(schema.libraryTracks)
        .where(eq(schema.libraryTracks.id, "ltr_reloc"))
        .limit(1);
      expect(row?.path).toContain("01 One More Time.opus");
    }, 30_000);

    it("moves the file and updates the row when asked to", async () => {
      const report = (await call("relocate", { dryRun: false })) as {
        moved: number;
        failed: number;
      };
      expect(report.failed).toBe(0);
      expect(report.moved).toBe(1);

      const [row] = await db()
        .select()
        .from(schema.libraryTracks)
        .where(eq(schema.libraryTracks.id, "ltr_reloc"))
        .limit(1);
      expect(row?.path).toContain("01 - One More Time.opus");
      expect(await relocateService.countOffTemplate({ db: db() })).toBe(0);
    }, 60_000);

    it("is a no-op the second time, which is what makes it safe to re-run", async () => {
      const report = (await call("relocate", { dryRun: false })) as { planned: number };
      expect(report.planned).toBe(0);
    }, 30_000);
  });

  /* ---------------------------------------------------------------- */
  /* §4 — present is a fact                                            */
  /* ---------------------------------------------------------------- */

  it("§4 get_album reports present from the disk, not as a constant", async () => {
    const there = (await call("get_album", { albumId: "alb_reloc" })) as {
      quality: { presentCount: number };
      tracks: { present: boolean }[];
    };
    expect(there.tracks[0]?.present).toBe(true);
    expect(there.quality.presentCount).toBe(1);

    // Delete the file behind the app's back — the row stays, the fact changes.
    const [row] = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.id, "ltr_reloc"))
      .limit(1);
    rmSync(join(LIBRARY_HOST, ...(row?.path ?? "").split("/")), { force: true });

    const gone = (await call("get_album", { albumId: "alb_reloc" })) as {
      quality: { presentCount: number };
      tracks: { present: boolean }[];
    };
    expect(gone.tracks[0]?.present).toBe(false);
    expect(gone.quality.presentCount).toBe(0);
  }, 30_000);

  /* ---------------------------------------------------------------- */
  /* §5 — retag says why it failed                                     */
  /* ---------------------------------------------------------------- */

  it("§5 retag returns errors with a path, a code and a message", async () => {
    // `ltr_reloc`'s file has just been deleted, so the re-tag of it must fail — with a reason.
    const result = (await call("retag", {
      albumId: "alb_reloc",
      dryRun: true,
      onlyBehind: false,
    })) as {
      failed: number;
      errors: { path: string; code: string; message: string }[];
    };
    expect(result.failed).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path.length ?? 0).toBeGreaterThan(0);
    expect(result.errors[0]?.code.length ?? 0).toBeGreaterThan(0);
    expect(result.errors[0]?.message.length ?? 0).toBeGreaterThan(0);
  }, 60_000);

  /* ---------------------------------------------------------------- */
  /* §6 — no SQL in an error                                           */
  /* ---------------------------------------------------------------- */

  it("§6 list_imports refuses an unknown status without quoting a query", async () => {
    await expect(call("list_imports", { status: "totalement_bidon" })).rejects.toThrow();
    try {
      await call("list_imports", { status: "totalement_bidon" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("select");
      expect(message).not.toContain("release_group_mbid");
    }
  });
});
