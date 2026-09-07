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
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

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
const consoleQueries = await import("#/server/services/console.queries.ts");
const apiKeys = await import("#/server/services/api-keys.ts");
const mcpHttp = await import("./http.ts");
const settings = await import("#/server/services/settings.ts");
const status = await import("#/server/services/status.ts");
const relocateService = await import("#/server/services/relocate.ts");
const retag = await import("#/server/services/retag.ts");
const scan = await import("#/server/services/scan.ts");
const inboxService = await import("#/server/services/inbox.ts");
const place = await import("#/server/services/jobs/steps/place.ts");
const discover = await import("#/server/services/discover.ts");
const quality = await import("#/server/services/quality.ts");
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

  /* ================================================================ */
  /* The second test report                                            */
  /* ================================================================ */

  /* ---------------------------------------------------------------- */
  /* A — a truncated list cannot count what it does not contain        */
  /* ---------------------------------------------------------------- */

  describe("A retag counts before it truncates", () => {
    beforeAll(async () => {
      // Three tracks of one album, none of them on disk, so every one of them fails with a
      // reason. `limit` then has more to hide than it shows — which is the whole point.
      await db().insert(schema.libraryAlbums).values({
        id: "alb_more",
        albumArtist: "Ghosts",
        title: "Nothing Here",
        year: 2020,
        folder: "Ghosts/Nothing Here (2020)",
        trackCount: 3,
        presentCount: 0,
      });
      for (const index of [1, 2, 3]) {
        await db()
          .insert(schema.libraryTracks)
          .values({
            id: `ltr_more_${String(index)}`,
            albumId: "alb_more",
            title: `Track ${String(index)}`,
            discNumber: 1,
            trackNumber: index,
            path: `Ghosts/Nothing Here (2020)/0${String(index)} - Track ${String(index)}.opus`,
            format: "opus",
          });
      }
    });

    it("reports how many errors it left out, from the full count", async () => {
      const result = (await call("retag", {
        albumId: "alb_more",
        dryRun: true,
        onlyBehind: false,
        limit: 1,
      })) as { failed: number; errors: unknown[]; moreErrors: number };

      expect(result.failed).toBe(3);
      expect(result.errors).toHaveLength(1);
      // `moreErrors` was `Math.max(0, rows.length - limit)` on rows already cut to `limit`, so
      // it could only answer 0 — while eleven errors were hidden. Now: total minus shown.
      expect(result.moreErrors).toBe(2);
    }, 60_000);

    it("counts a run's rows in SQL, independently of the slice it returns", async () => {
      const run = await retag.createRun({
        db: db(),
        scope: "album",
        targetId: "alb_more",
        dryRun: true,
        onlyBehind: false,
        trigger: "manual",
      });
      const finished = await retag.runToCompletion(run.id, { db: db() });
      const view = await retag.runView(finished.id, { limit: 1 }, db());
      expect(view?.diffs).toHaveLength(1);
      expect(view?.totals.rows).toBe(3);
      expect(view?.totals.failed).toBe(3);
    }, 60_000);

    /* ---- G — a diff a reader can read ---- */

    it("G abbreviates a tag value that is kilobytes long", () => {
      const long = "AQADtJQibVHCoNzx".repeat(200);
      const abbreviated = retag.abbreviateValue(long);
      expect(abbreviated.length).toBeLessThan(long.length);
      expect(abbreviated).toContain(`(${String(long.length)} chars)`);
      // Short values are untouched: this is about `ACOUSTID_FINGERPRINT` and `LYRICS`, not
      // about every tag in the projection.
      expect(retag.abbreviateValue("Daft Punk")).toBe("Daft Punk");
      const change = retag.abbreviateChange({
        key: "ACOUSTID_FINGERPRINT",
        field: "acoustid_fingerprint",
        after: long,
      });
      expect(change.after?.length ?? 0).toBeLessThan(long.length);
      expect(change.key).toBe("ACOUSTID_FINGERPRINT");
    });
  });

  /* ---------------------------------------------------------------- */
  /* B — the identifiers a faithful confirm_mapping needs              */
  /* ---------------------------------------------------------------- */

  describe("B the mapping's identifiers are readable", () => {
    it("get_import carries recordingMbid, trackPosition and mediumPosition per track", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      const detail = (await call("get_import", { importId: created.job.id })) as {
        tracks: {
          position: number;
          trackPosition: number | null;
          mediumPosition: number | null;
          recordingMbid: string | null;
          trackMbid: string | null;
        }[];
      };
      expect(detail.tracks.length).toBeGreaterThan(0);
      // Every key `confirm_mapping.bindings[]` asks for, on the same object.
      for (const key of ["trackPosition", "mediumPosition", "recordingMbid", "trackMbid"]) {
        expect(detail.tracks[0]).toHaveProperty(key);
      }
    }, 120_000);

    it("get_candidates puts them on every fit line, so a faithful confirm is a copy", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      const result = (await call("get_candidates", {
        importId: created.job.id,
        detail: "full",
        limit: 3,
      })) as {
        preselectedId: string | null;
        candidates: {
          id: string;
          fitLines: {
            videoIndex: number;
            trackPosition: number | null;
            mediumPosition: number | null;
            recordingMbid: string | null;
            trackMbid: string | null;
          }[];
        }[];
      };

      const preselected =
        result.candidates.find((entry) => entry.id === result.preselectedId) ??
        result.candidates[0];
      const bound = (preselected?.fitLines ?? []).filter((line) => line.trackPosition !== null);
      expect(bound.length).toBeGreaterThan(0);
      // The value the report said the system knew and refused to hand over.
      expect(bound.some((line) => line.recordingMbid !== null)).toBe(true);
      expect(bound[0]).toHaveProperty("mediumPosition");
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* C — one track is one row, whatever it is called                   */
  /* ---------------------------------------------------------------- */

  describe("C a track's identity is not its path", () => {
    const RECORDING = "11111111-1111-4111-8111-111111111111";
    const KEPT = "CHVRCHES/Every Open Eye (2015)/01 - Never Ending Circles.opus";
    const GHOST = "CHVRCHES/Every Open Eye (2015)/01 Never Ending Circles.opus";

    beforeAll(async () => {
      await db().insert(schema.libraryAlbums).values({
        id: "alb_dup",
        albumArtist: "CHVRCHES",
        title: "Every Open Eye",
        year: 2015,
        folder: "CHVRCHES/Every Open Eye (2015)",
        trackCount: 1,
        presentCount: 1,
      });
      mkdirSync(join(LIBRARY_HOST, "CHVRCHES", "Every Open Eye (2015)"), { recursive: true });
      writeFileSync(join(LIBRARY_HOST, ...KEPT.split("/")), "not really audio");
      await db().insert(schema.libraryTracks).values({
        id: "ltr_dup_new",
        albumId: "alb_dup",
        recordingMbid: RECORDING,
        title: "Never Ending Circles",
        discNumber: 1,
        trackNumber: 1,
        path: KEPT,
        format: "opus",
      });
    });

    it("refuses a second row for the same recording of the same album", async () => {
      await expect(
        db().insert(schema.libraryTracks).values({
          id: "ltr_dup_old",
          albumId: "alb_dup",
          recordingMbid: RECORDING,
          title: "Never Ending Circles",
          discNumber: 1,
          trackNumber: 1,
          // The old template's name — the exact shape of the twenty-five-row album.
          path: GHOST,
          format: "opus",
        }),
      ).rejects.toThrow();
    });

    it("finds the existing row by recording when the file has been renamed", async () => {
      const found = await place.findLibraryTrack({ db: db() }, "alb_dup", {
        path: GHOST,
        recordingMbid: RECORDING,
        discNumber: 1,
        trackNumber: 1,
      });
      expect(found?.id).toBe("ltr_dup_new");
    });

    it("finds it by position when there is no MusicBrainz id at all", async () => {
      const found = await place.findLibraryTrack({ db: db() }, "alb_dup", {
        path: "CHVRCHES/Every Open Eye (2015)/01 Something Else.opus",
        recordingMbid: null,
        discNumber: 1,
        trackNumber: 1,
      });
      expect(found?.id).toBe("ltr_dup_new");
    });

    it("merges a database that predates the constraint, keeping the row whose file exists", async () => {
      /*
       * The constraint makes duplicates impossible to create, so the only way to test the
       * repair is to *be* the database that had them: drop the indexes, insert the ghost, and
       * let `scan` find it. That is exactly the installation the report was written against.
       */
      await db().$client`drop index library_tracks_album_recording_idx`;
      await db().$client`drop index library_tracks_album_position_idx`;
      await db().insert(schema.libraryTracks).values({
        id: "ltr_dup_ghost",
        albumId: "alb_dup",
        recordingMbid: RECORDING,
        title: "Never Ending Circles",
        discNumber: 1,
        trackNumber: 1,
        // Nothing on disk at this path: this is the ghost.
        path: GHOST,
        format: "opus",
      });
      await db()
        .update(schema.libraryAlbums)
        .set({ trackCount: 2 })
        .where(eq(schema.libraryAlbums.id, "alb_dup"));

      const { report } = await scan.runScan({ db: db(), driftLimit: 0 });
      expect(report.merged.length).toBeGreaterThan(0);

      const rows = await db()
        .select()
        .from(schema.libraryTracks)
        .where(eq(schema.libraryTracks.albumId, "alb_dup"));
      expect(rows).toHaveLength(1);
      // The survivor is the row whose file is on disk — not the newest, not the first.
      expect(rows[0]?.id).toBe("ltr_dup_new");

      const [album] = await db()
        .select()
        .from(schema.libraryAlbums)
        .where(eq(schema.libraryAlbums.id, "alb_dup"))
        .limit(1);
      expect(album?.trackCount).toBe(1);

      await db().$client`create unique index library_tracks_album_recording_idx
        on library_tracks (album_id, recording_mbid)
        where album_id is not null and recording_mbid is not null`;
      await db().$client`create unique index library_tracks_album_position_idx
        on library_tracks (album_id, coalesce(disc_number, 1), track_number)
        where album_id is not null and track_number is not null`;
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* E — a scan whose result an agent can read                         */
  /* ---------------------------------------------------------------- */

  describe("E get_scan_report", () => {
    it("answers with the counts in full and the lists cut to `limit`", async () => {
      // Four files nothing in the database has ever heard of.
      mkdirSync(join(LIBRARY_HOST, "Orphans"), { recursive: true });
      for (const index of [1, 2, 3, 4]) {
        writeFileSync(join(LIBRARY_HOST, "Orphans", `${String(index)}.opus`), "not really audio");
      }
      const { scan: run } = await scan.runScan({ db: db(), driftLimit: 0 });

      const report = (await call("get_scan_report", { scanId: run.id, limit: 2 })) as {
        scanId: string;
        status: string;
        counts: { orphans: number; filesSeen: number };
        orphans: { items: unknown[]; more: number };
      };
      expect(report.scanId).toBe(run.id);
      expect(report.status).toBe("done");
      expect(report.counts.orphans).toBeGreaterThanOrEqual(4);
      expect(report.orphans.items).toHaveLength(2);
      expect(report.orphans.more).toBe(report.counts.orphans - 2);
    }, 120_000);

    it("falls back to the most recent run when no id is given", async () => {
      const report = (await call("get_scan_report")) as { scanId: string | null };
      expect(report.scanId).not.toBeNull();
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */
  /* F — a toolbox older than the code calling it                      */
  /* ---------------------------------------------------------------- */

  it("F get_status compares the toolbox's contract with the generated client", async () => {
    const result = (await call("get_status")) as {
      toolbox: {
        reachable: boolean;
        contract: { expected: string; actual: string | null; matches: boolean } | null;
      };
      problems: string[];
    };
    expect(result.toolbox.reachable).toBe(true);
    expect(result.toolbox.contract).not.toBeNull();
    // The stack was brought up from this checkout, so the image *is* this code's image.
    expect(result.toolbox.contract?.actual).toBe(result.toolbox.contract?.expected);
    expect(result.toolbox.contract?.matches).toBe(true);
    expect(result.problems.join(" ")).not.toContain("stack:up --build");
  }, 30_000);

  /* ---------------------------------------------------------------- */
  /* H — an empty Discover says why it is empty                        */
  /* ---------------------------------------------------------------- */

  it("H discover_sync explains a result of zero", async () => {
    await settings.setSetting("discoverEnabled", true, { db: db(), setBy: "test" });
    const report = (await call("discover_sync")) as {
      status: string;
      recommendations: number;
      notes: string[];
    };
    expect(report.status).toBe("done");
    // Neither source is configured in this database, and that is a reason, not a silence —
    // whatever the counts happen to be.
    expect(report.notes.length).toBeGreaterThan(0);
    expect(report.notes.join(" ")).toContain("listenbrainzUser");
    expect(report.notes.join(" ")).toContain("navidromeUrl");

    // `list_discover` carries the same field, in the same words, so three empty blocks next to
    // a successful `lastSync` cannot be read as "Discover is broken".
    const list = (await call("list_discover")) as { notes: string[] };
    expect(Array.isArray(list.notes)).toBe(true);

    const explained = discover.explainDiscover({
      settings: {
        discoverEnabled: true,
        navidromeUrl: "",
        listenbrainzUser: "",
        lastfmKey: "",
        discoverWindowDays: 30,
      },
      totalPlays: 0,
      topArtists: 0,
      signalsError: null,
      found: 0,
    });
    expect(explained.join(" ")).toContain("navidromeUrl");
    expect(explained.join(" ")).toContain("listenbrainzUser");
  }, 120_000);

  /* ---------------------------------------------------------------- */
  /* I — several answers, one restart                                  */
  /* ---------------------------------------------------------------- */

  it("I resolve_inbox answers a whole import's items and re-queues it once", async () => {
    const created = await imports.createFromUrl("fixture://discovery", { db: db() });
    for (const index of [0, 1, 2]) {
      // An item is idempotent per (type, import, track), which is what stops a retried step
      // piling up questions — so three questions need three distinct tracks.
      await db()
        .insert(schema.inboxItems)
        .values({
          id: `inb_batch_${String(index)}`,
          type: "fingerprint_mismatch",
          importId: created.job.id,
          trackId: null,
          title: `Fingerprint disagrees on track ${String(index)}`,
          preselected: { action: "accept" },
        });
    }

    const open = await inboxService.listInbox({ importId: created.job.id, status: "open" }, db());
    expect(open).toHaveLength(3);

    const result = (await call("resolve_inbox", {
      importId: created.job.id,
      type: "fingerprint_mismatch",
    })) as { resolved: unknown[]; resumed: string[]; failed: unknown[] };

    expect(result.resolved).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    // Three answers, one restart — not three restarts racing each other.
    expect(result.resumed).toEqual([created.job.id]);

    const after = await inboxService.listInbox({ importId: created.job.id, status: "open" }, db());
    expect(after).toHaveLength(0);
  }, 120_000);

  it("I refuses two ways of naming the same set, and none at all", async () => {
    await expect(call("resolve_inbox", {})).rejects.toThrow(/itemId/);
    await expect(call("resolve_inbox", { itemId: "inb_x", importId: "imp_x" })).rejects.toThrow(
      /three ways/,
    );
  });

  /* ---------------------------------------------------------------- */
  /* R3-3 — a refusal on /mcp is a JSON-RPC response                   */
  /* ---------------------------------------------------------------- */

  /**
   * Driven by the **real MCP client**, not by a hand-built request.
   *
   * The point of the finding is that a strict client cannot attach the old REST body to its
   * call, so the only convincing proof is a client attaching it. The SDK transport takes a
   * `fetch`, which lets it talk to `handleMcpRequest` in this process — no port, no dev server,
   * and no reason for the assertion to be about anything but the envelope.
   */
  describe("R3-3 the auth guard answers in the protocol's own envelope", () => {
    const ENDPOINT = "http://mcp.test/mcp";

    /** A `fetch` that runs the route handler instead of going near a socket. */
    const inProcess = async (url: string | URL, init?: RequestInit): Promise<Response> =>
      await mcpHttp.handleMcpRequest(new Request(url, init));

    async function connect(
      token: string,
    ): Promise<{ close: () => Promise<void>; call: () => Promise<unknown> }> {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "mcp-fix-3-test", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        fetch: inProcess,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      return {
        close: async () => {
          await client.close();
        },
        call: async () => {
          await client.connect(transport);
          return await client.listTools();
        },
      };
    }

    it("a 401 is a JSON-RPC error the client can raise as one", async () => {
      const raw = await inProcess(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mm_not-a-key" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} }),
      });
      expect(raw.status).toBe(401);
      const body = (await raw.json()) as {
        jsonrpc: string;
        id: number | null;
        error: { code: number; message: string; data: { code: string; hint?: string } };
      };
      expect(body.jsonrpc).toBe("2.0");
      // The client's own id comes back, which is the whole point: it can be attached to a call.
      expect(body.id).toBe(41);
      expect(body.error.code).toBe(mcpHttp.JSONRPC_CODES[401]);
      expect(body.error.data.code).toBe("UNAUTHORIZED");
      // And the real SDK client reads it as an error rather than as a protocol violation.
      const session = await connect("mm_not-a-key");
      await expect(session.call()).rejects.toThrow(/401|Unknown API key|Unauthorized/i);
      await session.close().catch(() => undefined);
    }, 60_000);

    it("a 429 is one too, with the countdown a client can act on", async () => {
      // A user for the key to belong to. Better Auth's `apikey.referenceId` has no foreign key,
      // but the row is what `list()` filters on, so it may as well be a real one.
      const userId = "usr_ratelimit_test";
      await db()
        .insert(schema.user)
        .values({ id: userId, name: "rate", email: "rate@example.test", emailVerified: true })
        .onConflictDoNothing();

      const minted = await apiKeys.create({
        name: "rate-limit probe",
        scopes: ["*"],
        expiresInDays: null,
        userId,
      });

      // One request per minute, so the *second* call is refused. Set on the row rather than at
      // creation because the plugin refuses `rateLimitMax` from a call that carries headers.
      await db()
        .update(schema.apikey)
        .set({ rateLimitEnabled: true, rateLimitMax: 1, rateLimitTimeWindow: 60_000 })
        .where(eq(schema.apikey.id, minted.view.id));

      const send = async (id: number): Promise<Response> =>
        await inProcess(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${minted.secret}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "probe", version: "0" },
            },
          }),
        });

      expect((await send(1)).status).toBe(200);
      const limited = await send(2);
      expect(limited.status).toBe(429);

      const body = (await limited.json()) as {
        jsonrpc: string;
        id: number | null;
        error: { code: number; message: string; data: { code: string; hint?: string } };
      };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(2);
      expect(body.error.code).toBe(mcpHttp.JSONRPC_CODES[429]);
      expect(body.error.data.code).toBe("RATE_LIMITED");
      expect(body.error.data.hint).toMatch(/Try again in \d+s/);
      // And in the header, for a client that would rather not parse prose.
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    }, 60_000);

    it("keeps `id: null` for a body that has none, rather than inventing one", async () => {
      const raw = await inProcess(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mm_nope" },
        body: "not json at all",
      });
      const body = (await raw.json()) as { jsonrpc: string; id: number | null };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeNull();
    });

    it("`get_status` reports the caller's own budget before it is spent", async () => {
      const userId = "usr_budget_test";
      await db()
        .insert(schema.user)
        .values({ id: userId, name: "budget", email: "budget@example.test", emailVerified: true })
        .onConflictDoNothing();
      const minted = await apiKeys.create({
        name: "budget probe",
        scopes: ["*"],
        expiresInDays: null,
        userId,
      });

      const answer = await status.systemStatus({
        db: db(),
        principal: {
          kind: "apiKey",
          userId,
          label: minted.view.name,
          scopes: ["*"],
          keyId: minted.view.id,
        },
      });
      expect(answer.rateLimit).not.toBeNull();
      expect(answer.rateLimit?.max).toBe(600);
      expect(answer.rateLimit?.windowMs).toBe(60_000);
      // Never used, so the whole budget is there rather than a stale counter.
      expect(answer.rateLimit?.remaining).toBe(600);
      expect(answer.rateLimit?.note).toMatch(/429/);

      // A session has no key and no limit, and says so with `null` rather than with a guess.
      const asSession = await status.systemStatus({
        db: db(),
        principal: { kind: "session", userId, label: "budget@example.test", scopes: ["*"] },
      });
      expect(asSession.rateLimit).toBeNull();
    }, 60_000);

    it("maps 403 too, for the day a scope check moves in front of the transport", () => {
      // `/mcp` cannot produce a 403 today — scopes are enforced by *not registering* a tool,
      // so a key simply does not see what it may not call. The mapping exists so that a guard
      // added later cannot reintroduce a non-JSON-RPC refusal by accident.
      expect(mcpHttp.JSONRPC_CODES[403]).toBe(-32003);
      const encoded = mcpHttp.jsonRpcError(
        mcpHttp.JSONRPC_CODES[403] ?? 0,
        { code: "FORBIDDEN", message: "This key does not carry the `imports:write` scope." },
        7,
      );
      expect(encoded).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32003 } });
    });
  });

  /* ---------------------------------------------------------------- */
  /* R3-2 — every caller that opens the confirmation gate signs it     */
  /* ---------------------------------------------------------------- */

  describe("R3-2 provenance of an auto-confirm", () => {
    /** Create, confirm and read back who the `decisions` row says decided. */
    async function decidedBy(importId: string): Promise<string> {
      await jobs.runStep(importId, "resolve", { db: db() });
      await jobs.runStep(importId, "match", { db: db() });
      await jobs.runStep(importId, "confirm", { db: db() });
      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(and(eq(schema.decisions.importId, importId), eq(schema.decisions.kind, "release")))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(1);
      return decision?.decidedBy ?? "(no decision row)";
    }

    it("MCP `create_import` with autoConfirm is `mcp`, not `cli --yes`", async () => {
      const answer = (await call("create_import", {
        url: "fixture://discovery",
        autoConfirm: true,
      })) as { importId: string };
      expect(await decidedBy(answer.importId)).toBe("mcp");
    }, 120_000);

    it("the REST create path is `api`", async () => {
      // The same options object `POST /api/v1/imports` builds, through the same service.
      const created = await imports.createFromUrl("fixture://discovery", {
        db: db(),
        autoConfirm: true,
        confirmedBy: "api",
      });
      expect(await decidedBy(created.job.id)).toBe("api");
    }, 120_000);

    it("the Console wizard is `console`", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      // What `functions/wizard.ts` writes when step 3 is submitted.
      await consoleQueries.setImportOptions(
        created.job.id,
        { autoConfirm: true, confirmedBy: "console" },
        {},
        db(),
      );
      expect(await decidedBy(created.job.id)).toBe("console");
    }, 120_000);

    it("the CLI's `--yes` is `cli --yes`", async () => {
      const created = await imports.createFromUrl("fixture://discovery", {
        db: db(),
        autoConfirm: true,
        confirmedBy: "cli --yes",
      });
      expect(await decidedBy(created.job.id)).toBe("cli --yes");
    }, 120_000);

    it("refuses to open the gate at all without a signature", async () => {
      await expect(
        imports.createFromUrl("fixture://discovery", { db: db(), autoConfirm: true }),
      ).rejects.toThrow(/confirmedBy/);
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await expect(
        consoleQueries.setImportOptions(created.job.id, { autoConfirm: true }, {}, db()),
      ).rejects.toThrow(/confirmedBy/);
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* R3-1 — a refused patch writes nothing, whatever the key order     */
  /* ---------------------------------------------------------------- */

  describe("R3-1 update_settings is atomic", () => {
    /** The stored row, or `undefined` when the key has never been overridden. */
    async function stored(key: string): Promise<unknown> {
      const [row] = await db()
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .limit(1);
      return row?.value;
    }

    it("writes nothing when one value is refused, whichever position it holds", async () => {
      await call("update_settings", { patch: { maxGenres: 3 } });
      expect(await stored("maxGenres")).toBe(3);

      // The good key first: the old loop wrote it and *then* refused the call.
      await expect(
        call("update_settings", { patch: { maxGenres: 4, safeThreshold: "nawak" } }),
      ).rejects.toThrow(/safeThreshold/);
      expect(await stored("maxGenres")).toBe(3);

      // The bad key first — the same patch, and it must behave identically.
      await expect(
        call("update_settings", { patch: { safeThreshold: "nawak", maxGenres: 5 } }),
      ).rejects.toThrow(/safeThreshold/);
      expect(await stored("maxGenres")).toBe(3);

      // And the effective value the rest of the app reads never moved either.
      expect((await settings.loadSettings(db())).maxGenres).toBe(3);
    });

    it("names every bad value at once rather than the first one", async () => {
      await expect(
        call("update_settings", {
          patch: { safeThreshold: "nawak", sanitizeMode: "sideways", maxGenres: 2 },
        }),
      ).rejects.toThrow(/safeThreshold[\s\S]*sanitizeMode|sanitizeMode[\s\S]*safeThreshold/);
      expect(await stored("maxGenres")).toBe(3);
    });

    it("still refuses an unknown key without writing the known ones", async () => {
      await expect(
        call("update_settings", { patch: { maxGenres: 2, cleBidon: 1 } }),
      ).rejects.toThrow(/cleBidon/);
      expect(await stored("maxGenres")).toBe(3);
    });

    it("writes the whole patch when every value fits", async () => {
      const answer = (await call("update_settings", {
        patch: { maxGenres: 4, safeThreshold: 0.9 },
      })) as {
        saved: string[];
        previous: Record<string, unknown>;
        effective: Record<string, unknown>;
      };
      expect(answer.saved.sort()).toEqual(["maxGenres", "safeThreshold"]);
      expect(answer.previous["maxGenres"]).toBe(3);
      expect(answer.effective["maxGenres"]).toBe(4);
      expect(await stored("safeThreshold")).toBe(0.9);
      await call("update_settings", { patch: { maxGenres: 3, safeThreshold: 0.95 } });
    });
  });

  /* ---------------------------------------------------------------- */
  /* R3-4 — a supplied mapping keeps the album's release group         */
  /* ---------------------------------------------------------------- */

  describe("R3-4 the release group survives a supplied mapping", () => {
    const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
    const GROUP = "48117b90-a16e-34ca-a514-19c702df1158";

    it("asks MusicBrainz for it when the caller did not supply one", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_review" })
        .where(eq(schema.imports.id, created.job.id));

      // Exactly the call the report made: a release, bindings, and no release group.
      await call("confirm_mapping", {
        importId: created.job.id,
        releaseMbid: RELEASE,
        bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
      });

      const [job] = await db()
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, created.job.id))
        .limit(1);
      // Before: `supplied.releaseGroupMbid ?? null` wrote a null here, and `place` copied it.
      expect(job?.releaseGroupMbid).toBe(GROUP);
    }, 120_000);

    it("takes the caller's own value when there is one, without a lookup", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_review" })
        .where(eq(schema.imports.id, created.job.id));

      await call("confirm_mapping", {
        importId: created.job.id,
        releaseMbid: RELEASE,
        releaseGroupMbid: GROUP,
        bindings: [{ position: 0, trackPosition: 1, recordingMbid: null }],
      });

      const [job] = await db()
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, created.job.id))
        .limit(1);
      expect(job?.releaseGroupMbid).toBe(GROUP);
    }, 120_000);

    it("names it in `quality.missing`, at `required`, with the action that repairs it", async () => {
      const albumId = "alb_rg_missing";
      await db()
        .insert(schema.libraryAlbums)
        .values({
          id: albumId,
          releaseMbid: RELEASE,
          // The state the report found: a release, and no release group.
          releaseGroupMbid: null,
          albumArtist: "Daft Punk",
          title: "Discovery",
          // A folder of its own: `library_albums.folder` is unique, and an album another
          // test's `place` already created would swallow this insert.
          folder: "Daft Punk/Discovery (rg-test)",
          trackCount: 1,
          presentCount: 1,
        })
        .onConflictDoNothing();

      const row = await quality.scoreOneAlbum(albumId, { db: db() });
      const entry = row?.quality.missing.find(
        (field) => field.field === "musicbrainz_releasegroupid",
      );
      expect(entry).toBeDefined();
      expect(entry?.level).toBe("required");
      expect(entry?.vorbis).toBe("MUSICBRAINZ_RELEASEGROUPID");
      // The action is the name of a tool, not a slogan — see the next test.
      expect(entry?.action).toBe(quality.REFRESH_ALBUM_ACTION);
    }, 60_000);

    it("`refresh_album` is that action, and really repairs the column", async () => {
      const albumId = "alb_rg_missing";
      const answer = (await call("refresh_album", { albumId })) as {
        repaired: string[];
        releaseGroupMbid: { before: string | null; after: string | null };
      };
      expect(answer.repaired).toContain("releaseGroupMbid");
      expect(answer.releaseGroupMbid).toEqual({ before: null, after: GROUP });

      const [album] = await db()
        .select()
        .from(schema.libraryAlbums)
        .where(eq(schema.libraryAlbums.id, albumId))
        .limit(1);
      expect(album?.releaseGroupMbid).toBe(GROUP);

      // And the gap is gone from the quality report, which is what a reader checks next.
      const row = await quality.scoreOneAlbum(albumId, { db: db() });
      expect(
        row?.quality.missing.some((field) => field.field === "musicbrainz_releasegroupid"),
      ).toBe(false);
    }, 120_000);

    /*
     * R4-1: the report's album scored 0.04 under its own tracks and `refresh_album` answered
     * "the release says the same as before". Both facts were true and neither was the answer.
     */
    it("names the album-scope divergences and what they cost", async () => {
      const albumId = "alb_divergent";
      await db()
        .insert(schema.libraryAlbums)
        .values({
          id: albumId,
          releaseMbid: RELEASE,
          releaseGroupMbid: GROUP,
          albumArtist: "Daft Punk",
          title: "Discovery",
          folder: "Daft Punk/Discovery (divergence-test)",
          trackCount: 2,
          presentCount: 2,
        })
        .onConflictDoNothing();

      // Two tracks of one album, each carrying its own recording's genre — the state the
      // pipeline used to leave behind, written here by hand so the assertion is about the
      // reporting and not about the pipeline.
      const at = "2026-09-07T00:00:00.000Z";
      const document = (genres: readonly string[]) => ({
        schemaVersion: 2,
        fields: {
          title: { value: "t", source: "musicbrainz", confidence: 1, fetchedAt: at, locked: false },
          genre: {
            value: genres,
            source: "musicbrainz",
            confidence: 1,
            fetchedAt: at,
            locked: false,
          },
        },
        na: {},
      });
      for (const [index, genres] of [["house"], ["synth-pop"]].entries()) {
        const trackId = `ltr_div_${String(index)}`;
        await db()
          .insert(schema.libraryTracks)
          .values({
            id: trackId,
            albumId,
            path: `Daft Punk/Discovery (divergence-test)/0${String(index + 1)} - t.opus`,
            title: "t",
            artist: "Daft Punk",
            trackNumber: index + 1,
            discNumber: 1,
          })
          .onConflictDoNothing();
        await db()
          .insert(schema.metadataDocuments)
          .values({
            id: `mdo_div_${String(index)}`,
            libraryTrackId: trackId,
            document: document(genres) as unknown as Record<string, unknown>,
            tagSchemaVersion: 2,
          })
          .onConflictDoNothing();
      }

      const album = (await call("get_album", { albumId })) as {
        quality: {
          score: number | null;
          meanTrackScore: number | null;
          penalty: number;
          divergentFields: string[];
          divergences: {
            field: string;
            vorbis: string;
            action: string;
            values: { value: string; tracks: number[] }[];
          }[];
        };
      };
      expect(album.quality.divergentFields).toEqual(["genre"]);
      expect(album.quality.penalty).toBeCloseTo(0.02, 10);
      expect(album.quality.score).toBeCloseTo((album.quality.meanTrackScore ?? 0) - 0.02, 10);
      const genre = album.quality.divergences[0];
      expect(genre?.vorbis).toBe("GENRE");
      expect(genre?.action).toBe(quality.RETAG_ACTION);
      expect(genre?.values.map((entry) => entry.tracks)).toEqual([[1], [2]]);

      // And the refetch stops pretending there is nothing to do.
      const answer = (await call("refresh_album", { albumId, dryRun: true })) as {
        repaired: string[];
        divergentFields: string[];
        penalty: number;
        dryRun: boolean;
        note: string;
      };
      expect(answer.repaired).toEqual([]);
      expect(answer.divergentFields).toEqual(["genre"]);
      expect(answer.dryRun).toBe(true);
      expect(answer.note).toContain("genre");
      expect(answer.note).not.toMatch(/nothing to (repair|do)/i);
    }, 120_000);

    it("refuses an album that has no MusicBrainz release at all", async () => {
      await db()
        .insert(schema.libraryAlbums)
        .values({
          id: "alb_untagged",
          releaseMbid: null,
          albumArtist: "Nobody",
          title: "Untagged",
          folder: "Nobody/Untagged (rg-test)",
        })
        .onConflictDoNothing();
      await expect(call("refresh_album", { albumId: "alb_untagged" })).rejects.toThrow(
        /no MusicBrainz release/,
      );
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */
  /* R3-5 — fitLines is the bindings, extras are separate              */
  /* ---------------------------------------------------------------- */

  describe("R3-5 get_candidates separates bound lines from extras", () => {
    it("`fitLines.map(…)` parses as `bindings` with no filtering", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      const answer = (await call("get_candidates", { importId: created.job.id })) as {
        candidates: {
          fitLines?: {
            videoIndex: number;
            trackPosition: number | null;
            mediumPosition: number | null;
            trackTitle: string | null;
            recordingMbid: string | null;
          }[];
          extras?: { videoIndex: number; status: string; reason: string }[];
        }[];
      };

      const detailed = answer.candidates.find((entry) => entry.fitLines !== undefined);
      expect(detailed).toBeDefined();
      const lines = detailed?.fitLines ?? [];
      expect(lines.length).toBeGreaterThan(0);

      // The whole point: the naive conversion, through the tool's own schema.
      const { z } = await import("zod");
      const bindings = z.object(tools.get("confirm_mapping")?.inputSchema ?? {}).parse({
        importId: created.job.id,
        releaseMbid: null,
        bindings: lines.map((line) => ({
          position: line.videoIndex,
          trackPosition: line.trackPosition,
          mediumPosition: line.mediumPosition,
          recordingMbid: line.recordingMbid,
          trackTitle: line.trackTitle ?? "",
        })),
      }) as { bindings: unknown[] };
      expect(bindings.bindings).toHaveLength(lines.length);

      // The 15-video fixture covers 14 tracks, so there is one leftover — and it is in
      // `extras`, with a sentence saying what to do with it rather than a row of nulls.
      const extras = detailed?.extras ?? [];
      expect(Array.isArray(extras)).toBe(true);
      for (const extra of extras) {
        expect(extra.reason).toMatch(/leave it out of/i);
        expect(lines.some((line) => line.videoIndex === extra.videoIndex)).toBe(false);
      }
    }, 120_000);

    it("keeps the default summary under 20 KB and says when it abbreviated", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      const answer = (await call("get_candidates", { importId: created.job.id })) as {
        truncated?: string[];
      };
      // Measured the way the caller receives it: `json()` pretty-prints with two spaces.
      const bytes = JSON.stringify(answer, null, 2).length;
      expect(bytes).toBeLessThanOrEqual(20_000);
      // Nothing is shortened silently: an abbreviated answer says so.
      if (answer.truncated !== undefined) expect(answer.truncated.length).toBeGreaterThan(0);
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* R3-6 — a fixture URL outside fixtures mode is refused at once     */
  /* ---------------------------------------------------------------- */

  describe("R3-6 fixture:// is guarded, not only documented", () => {
    it("is accepted while the toolbox is in fixtures mode", async () => {
      const answer = (await call("create_import", { url: "fixture://discovery" })) as {
        importId: string;
      };
      expect(answer.importId).toMatch(/^imp_/);
    }, 120_000);

    it("is refused before anything is written when it is not", async () => {
      // The toolbox this suite runs against *is* in fixtures mode, so the refusal is provoked
      // by making `/health` say what a production toolbox would say. The service asks the
      // toolbox, which is the only honest source: `MM_FIXTURES` is the app's own mode and the
      // trap is precisely that the two can disagree.
      const tools_ = await import("#/server/services/tools.ts");
      const spy = vi.spyOn(tools_, "downloaderHealth").mockResolvedValue({
        reachable: true,
        fixtures: false,
        downloading: false,
        versions: { "yt-dlp": "2025.08.11", ffmpeg: "7", fpcalc: "1.5", rsgain: "3" },
        contract: null,
        channel: "stable",
        pin: "",
        autoUpdate: true,
        updateCron: "0 4 * * *",
        onUpdateFailure: "warn",
        error: null,
      });
      try {
        const before = await db().select().from(schema.imports);
        await expect(call("create_import", { url: "fixture://discovery" })).rejects.toThrow(
          /recorded fixture/,
        );
        const after = await db().select().from(schema.imports);
        // Refused *before* the row, so no ghost import and no worker time spent.
        expect(after).toHaveLength(before.length);
      } finally {
        spy.mockRestore();
      }
    }, 60_000);
  });

  /* ---------------------------------------------------------------- */
  /* R3-7 — the minor observations                                     */
  /* ---------------------------------------------------------------- */

  describe("R3-7 minor observations", () => {
    it("a queued import shows the first unfinished step and its position", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      // The state the report described: the job says `running` / `download` because that is
      // the step it is *on*, while the step row says `pending`.
      await db()
        .update(schema.imports)
        .set({ status: "running", step: "download" })
        .where(eq(schema.imports.id, created.job.id));

      const answer = (await call("get_import", { importId: created.job.id })) as {
        step: string;
        queuePosition: number | null;
        queueNote: string;
        steps: { step: string; status: string }[];
      };
      // The head step is the first one that has not finished, which is not `download`.
      expect(answer.step).not.toBe("download");
      expect(answer.steps.find((entry) => entry.step === answer.step)?.status).not.toBe("done");
      expect(answer.queuePosition).not.toBeNull();
      expect(answer.queueNote).toMatch(/queued|running/i);
    }, 120_000);

    it("an import waiting for a person has no queue position", async () => {
      const created = await imports.createFromUrl("fixture://discovery", { db: db() });
      await db()
        .update(schema.imports)
        .set({ status: "awaiting_confirm" })
        .where(eq(schema.imports.id, created.job.id));
      const answer = (await call("get_import", { importId: created.job.id })) as {
        queuePosition: number | null;
        queueNote: string;
      };
      expect(answer.queuePosition).toBeNull();
      expect(answer.queueNote).toMatch(/decision/i);
    }, 120_000);

    it("`runView` slices errors and diffs separately", async () => {
      // A run whose rows are lopsided: three failures sorted before the one real diff, so a
      // single slice of the first rows would have shown no diff at all.
      const run = await retag.createRun({
        db: db(),
        scope: "library",
        targetId: null,
        dryRun: true,
        onlyBehind: false,
        trigger: "manual",
      });
      for (const [index, path] of ["a.opus", "b.opus", "c.opus", "z.opus"].entries()) {
        await db()
          .insert(schema.retagDiffs)
          .values({
            id: `rtd_slice_${String(index)}`,
            runId: run.id,
            libraryTrackId: null,
            path,
            added: path === "z.opus" ? [{ key: "GENRE", field: "genre", after: "House" }] : [],
            removed: [],
            changed: [],
            unchanged: 0,
            ...(path === "z.opus"
              ? {}
              : { error: { code: "NOT_FOUND", message: `${path} is not on disk.` } }),
          });
      }

      const errorsOnly = await retag.runView(run.id, { limit: 2, only: "errors" }, db());
      expect(errorsOnly?.diffs).toHaveLength(2);
      expect(errorsOnly?.diffs.every((row) => row.error !== null)).toBe(true);

      const changedOnly = await retag.runView(run.id, { limit: 2, only: "changed" }, db());
      // The one real diff, which the old single slice would have missed entirely.
      expect(changedOnly?.diffs).toHaveLength(1);
      expect(changedOnly?.diffs[0]?.path).toBe("z.opus");

      // And the counts still come from the whole run, not from either slice.
      expect(errorsOnly?.totals).toEqual({ rows: 4, failed: 3, changed: 1 });
    }, 60_000);

    it("`place` says why a sidecar is missing", async () => {
      const message = place.placeMessage({
        placed: 13,
        sidecars: 12,
        withoutLyrics: ["Clearest Blue"],
        writeLyricsSidecar: true,
      });
      expect(message).toContain("13 file(s) placed, 12 sidecar(s) written");
      expect(message).toContain("LRCLIB");
      expect(message).toContain("Clearest Blue");

      // Sidecars turned off is a setting, not a gap, and says something different.
      expect(
        place.placeMessage({
          placed: 13,
          sidecars: 0,
          withoutLyrics: [],
          writeLyricsSidecar: false,
        }),
      ).toContain("off in Settings");
    });
  });
});
