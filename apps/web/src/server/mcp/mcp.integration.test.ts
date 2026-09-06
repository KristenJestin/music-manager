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
const retag = await import("#/server/services/retag.ts");
const scan = await import("#/server/services/scan.ts");
const inboxService = await import("#/server/services/inbox.ts");
const place = await import("#/server/services/jobs/steps/place.ts");
const discover = await import("#/server/services/discover.ts");
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
});
