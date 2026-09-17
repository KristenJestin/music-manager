/**
 * `confirm-best` and `POST /imports/batch`, against a real stack.
 *
 * Both are service functions the REST route, the MCP tool and the CLI all call, so testing them
 * here tests all three — what differs between the callers is a string (`confirmedBy`) and a
 * schema, and those are covered by `api/schemas.test.ts` and `mcp/server.test.ts`.
 *
 * Same shape as `mcp.integration.test.ts`: its own database, its own corner of the library, and
 * it skips itself when the stack is not up.
 *
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-bulktest");
const LIBRARY_CONTAINER = "/library/.mm-bulktest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_bulktest`;
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
  console.log(`  (bulk-import integration tests skipped: ${unavailable})`);
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
const { MMError } = await import("@mm/contracts");
const { confirmBest, createImportsBatch, MAX_BATCH_URLS } = await import("./imports.bulk.ts");

resetServerEnv();

/** `fixture://discovery` is fifteen videos for a fourteen-track release. */
const DISCOVERY_VIDEOS = 15;

/** An import of the fixture album, resolved and parked where a confirmation means something. */
async function waitingImport(url = "fixture://discovery"): Promise<string> {
  const created = await imports.createFromUrl(url, { db: db() });
  await db()
    .update(schema.imports)
    .set({ status: "awaiting_review" })
    .where(eq(schema.imports.id, created.job.id));
  return created.job.id;
}

/**
 * The album that *is* an exact match: `fixture://currents`, thirteen videos for a thirteen-track
 * release, nothing left over on either side.
 *
 * `confirm-best` is the one door the engine confirms through alone, so it is now refused on
 * anything but an exact match (`exactnessRefusal`). Discovery — fifteen videos, fourteen tracks
 * — is therefore the *refusal* fixture from here on, and this is the one that goes through.
 */
async function waitingExactImport(): Promise<string> {
  return await waitingImport("fixture://currents");
}

/**
 * The same, for a one-video source: `fixture://skinny-love`, Birdy's cover of Bon Iver.
 *
 * The recording ranking for it is the one the cassette records, and it is decisive by a wide
 * margin (about 0.15 over the runner-up, durations one second apart, title and artist both at
 * 1) — which is exactly the shape a single that *should* be confirmed automatically has.
 */
async function waitingSingle(): Promise<string> {
  const created = await imports.createFromUrl("fixture://skinny-love", { db: db() });
  await db()
    .update(schema.imports)
    .set({ status: "awaiting_review" })
    .where(eq(schema.imports.id, created.job.id));
  return created.job.id;
}

describe.skipIf(unavailable !== null)("the bulk-import service against a real stack", () => {
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
  /* confirm-best: the import that clears the bar                      */
  /* ---------------------------------------------------------------- */

  describe("confirm-best on an import that clears the bar", () => {
    it("picks a release, maps from the engine's own fit lines, and queues the job", async () => {
      const importId = await waitingExactImport();
      const outcome = await confirmBest({ importId, confirmedBy: "test", db: db() });

      expect(outcome.kind).toBe("album");
      if (outcome.chosen.kind !== "release") throw new Error("an album must choose a release");
      expect(outcome.chosen.mbid).toMatch(/[0-9a-f-]{36}/);
      // Every video bound and every track covered: the only shape the engine may confirm alone.
      expect(outcome.chosen.coverage).toBe(1);
      expect(outcome.minCoverage).toBe(0.8);
      expect(outcome.preferType).toBe("album");
      // The single's knob is reported as inapplicable rather than as a number nobody used.
      expect(outcome.minMargin).toBeNull();
      expect(outcome.candidatesConsidered).toBeGreaterThan(0);
      expect(outcome.queued).toBe(true);

      // `mapped` is what the `match` step really did, not what was sent to it.
      expect(outcome.mapped).toBe(outcome.chosen.mapped);
      expect(outcome.chosen.mapped).toBeGreaterThanOrEqual(13);
    }, 120_000);

    /*
     * The bug this whole endpoint exists to make impossible.
     *
     * A client rebuilding the mapping by hand sends `recordingMbid: null`, and `fingerprint`
     * then disagrees with the mapping it was given on every track. The fit lines carry the
     * identifiers, so the rows do too — and nothing had to be typed for that to be true.
     */
    it("writes the MusicBrainz identifiers onto the rows, not nulls", async () => {
      const importId = await waitingExactImport();
      await confirmBest({ importId, confirmedBy: "test", db: db() });

      const rows = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, importId));
      const mapped = rows.filter((row) => row.role === "mapped");

      expect(mapped.length).toBeGreaterThanOrEqual(13);
      expect(mapped.every((row) => row.recordingMbid !== null)).toBe(true);
      expect(mapped.every((row) => row.trackPosition !== null)).toBe(true);
      // Every bound line got a distinct track: the engine's assignment is 1:1 and this must not
      // quietly collapse it.
      expect(
        new Set(mapped.map((row) => `${String(row.mediumPosition)}/${String(row.trackPosition)}`))
          .size,
      ).toBe(mapped.length);
    }, 120_000);

    it("records a decisions row signed with `confirmedBy`, like the auto-confirm path", async () => {
      const importId = await waitingExactImport();
      await confirmBest({ importId, confirmedBy: "agent-zero", db: db() });
      // `confirmBest` runs `match`; `confirm` is the next step and is what writes the row.
      await jobs.runStep(importId, "confirm", { db: db() });

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(and(eq(schema.decisions.importId, importId), eq(schema.decisions.kind, "release")))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(1);

      // Never `fixtures`, never `cli --yes (unsigned)`: an automatic confirmation still names
      // the door it came through, or the audit trail cannot answer "who decided this?".
      expect(decision?.decidedBy).toBe("agent-zero");
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* confirm-best: the import that does not                            */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* confirm-best: the album that is not an exact match                */
  /* ---------------------------------------------------------------- */

  /**
   * The third owner defect, at the one door the engine confirms through alone.
   *
   * `docs/04` calls `confirm-best` "le seul chemin qui valide une release sans que personne ne
   * lise la fiche", and the MCP header names the session it was written for: 375 playlists
   * driven through it by hand. Five of the fifteen albums the owner flagged have **no release
   * of the right size in MusicBrainz at all**, and one was chosen for each of them anyway.
   * Discovery is the same shape in miniature — fifteen videos, fourteen tracks, one left over.
   */
  describe("confirm-best on an album that is not an exact match", () => {
    it("refuses rather than confirming a release that leaves a video on no track", async () => {
      const importId = await waitingImport();
      const failure = await confirmBest({ importId, confirmedBy: "test", db: db() }).catch(
        (error: unknown) => MMError.from(error),
      );

      expect(failure).toBeInstanceOf(MMError);
      const error = failure as InstanceType<typeof MMError>;
      expect(error.code).toBe("AWAITING_CONFIRM");
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/not an exact match/);
      expect(error.details?.["videos"]).toBe(DISCOVERY_VIDEOS);
      expect(error.details?.["why"]).toMatch(/video\(s\)/);
    }, 120_000);

    it("leaves the import waiting, untouched — a parked import beats a wrong album", async () => {
      const importId = await waitingImport();
      await confirmBest({ importId, confirmedBy: "test", db: db() }).catch(() => undefined);

      const job = await imports.getImport(importId, db());
      expect(job?.status).toBe("awaiting_review");
      const options = job?.options as { mapping?: unknown; autoConfirm?: unknown };
      expect(options.mapping).toBeUndefined();
      expect(options.autoConfirm).not.toBe(true);
    }, 120_000);

    /** `minCoverage` is a bar the caller may raise; it was never a way to waive the rule. */
    it("is not waived by a lower `minCoverage`", async () => {
      const importId = await waitingImport();
      const failure = await confirmBest({
        importId,
        minCoverage: 0.5,
        confirmedBy: "test",
        db: db(),
      }).catch((error: unknown) => MMError.from(error));
      expect((failure as InstanceType<typeof MMError>).message).toMatch(/not an exact match/);
    }, 120_000);
  });

  describe("confirm-best on an import that does not clear the bar", () => {
    it("refuses with a 409, names the best candidate and its coverage", async () => {
      const importId = await waitingImport();
      // 14 of 15 videos is about 93 %; nothing can reach 100 % on this fixture.
      const failure = await confirmBest({
        importId,
        minCoverage: 1,
        confirmedBy: "test",
        db: db(),
      }).catch((error: unknown) => MMError.from(error));

      expect(failure).toBeInstanceOf(MMError);
      const error = failure as InstanceType<typeof MMError>;
      expect(error.code).toBe("AWAITING_CONFIRM");
      expect(error.status).toBe(409);
      // The message has to be actionable on its own: which release, and how close it came.
      expect(error.details?.["releaseMbid"]).toMatch(/[0-9a-f-]{36}/);
      expect(typeof error.details?.["coverage"]).toBe("number");
      expect(error.details?.["minCoverage"]).toBe(1);
      expect(error.message).toMatch(/coverage/i);
    }, 120_000);

    it("leaves the import waiting, with no mapping and no release written", async () => {
      const importId = await waitingImport();
      await confirmBest({ importId, minCoverage: 1, confirmedBy: "test", db: db() }).catch(
        () => undefined,
      );

      const job = await imports.getImport(importId, db());
      expect(job?.status).toBe("awaiting_review");
      // `setImportOptions` is only reached past the bar, so nothing opened the gate either.
      const options = job?.options as { mapping?: unknown; autoConfirm?: unknown };
      expect(options.mapping).toBeUndefined();
      expect(options.autoConfirm).not.toBe(true);

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.importId, importId))
        .limit(1);
      expect(decision).toBeUndefined();
    }, 120_000);

    it("an import with no videos is a 400, not a confirmation of nothing", async () => {
      const created = await imports.createFromUrl("fixture://discovery", {
        db: db(),
        resolveNow: false,
      });
      const failure = await confirmBest({
        importId: created.job.id,
        confirmedBy: "test",
        db: db(),
      }).catch((error: unknown) => MMError.from(error));

      expect((failure as InstanceType<typeof MMError>).code).toBe("INVALID_INPUT");
    }, 60_000);

    it("an unknown import is a 404", async () => {
      const failure = await confirmBest({
        importId: "imp_00000000000000000000000000",
        confirmedBy: "test",
        db: db(),
      }).catch((error: unknown) => MMError.from(error));

      expect((failure as InstanceType<typeof MMError>).code).toBe("NOT_FOUND");
    });
  });

  /* ---------------------------------------------------------------- */
  /* confirm-best on a single: the two sides of the margin bar         */
  /* ---------------------------------------------------------------- */

  describe("confirm-best on a single", () => {
    it("confirms the recording when it is decisive, and files it under its borrow release", async () => {
      const importId = await waitingSingle();
      const outcome = await confirmBest({ importId, confirmedBy: "test", db: db() });

      expect(outcome.kind).toBe("single");
      if (outcome.chosen.kind !== "recording") throw new Error("a single must choose a recording");
      const chosen = outcome.chosen;

      // The criterion, as reported: a real margin, agreeing durations, agreeing title and artist.
      expect(chosen.mbid).toMatch(/[0-9a-f-]{36}/);
      expect(chosen.margin).not.toBeNull();
      expect(chosen.margin ?? 0).toBeGreaterThanOrEqual(outcome.minMargin ?? 0);
      expect(Math.abs(chosen.durationDelta ?? 99)).toBeLessThanOrEqual(2);
      expect(chosen.titleAgreement).toBeGreaterThanOrEqual(0.87);
      expect(chosen.artistAgreement).toBeGreaterThanOrEqual(0.87);
      // The album bar is reported as inapplicable, not as a number that happened to pass.
      expect(outcome.minCoverage).toBeNull();
      expect(outcome.preferType).toBeNull();

      // It is filed somewhere real — that is what makes the track taggable at all.
      expect(chosen.releaseMbid).toMatch(/[0-9a-f-]{36}/);
      expect(chosen.releaseTitle).not.toBe("");
      expect(outcome.mapped).toBe(1);
      expect(outcome.queued).toBe(true);
    }, 120_000);

    it("writes the recording MBID onto the one row, with no uncovered-tracks noise", async () => {
      const importId = await waitingSingle();
      const outcome = await confirmBest({ importId, confirmedBy: "test", db: db() });

      const rows = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, importId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("mapped");
      expect(rows[0]?.recordingMbid).toBe(
        outcome.chosen.kind === "recording" ? outcome.chosen.mbid : null,
      );
      expect(rows[0]?.trackPosition).not.toBeNull();

      /*
       * The borrow release is a thirteen-track album this import wants exactly one song from.
       * Reporting the other twelve as "uncovered" would be a question nobody asked — see the
       * note on `trackTotal` in `confirmBestRecording`.
       */
      expect(outcome.uncovered).toBe(0);
    }, 120_000);

    it("records a decisions row signed with `confirmedBy`, like the album path", async () => {
      const importId = await waitingSingle();
      await confirmBest({ importId, confirmedBy: "agent-one", db: db() });
      await jobs.runStep(importId, "confirm", { db: db() });

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(and(eq(schema.decisions.importId, importId), eq(schema.decisions.kind, "release")))
        .orderBy(desc(schema.decisions.createdAt))
        .limit(1);

      expect(decision?.decidedBy).toBe("agent-one");
    }, 120_000);

    it("refuses a thin margin with a 409 naming every condition it missed", async () => {
      const importId = await waitingSingle();
      // No ranking can put a full point between the top two: this is the bar being real.
      const failure = await confirmBest({
        importId,
        minMargin: 1,
        confirmedBy: "test",
        db: db(),
      }).catch((error: unknown) => MMError.from(error));

      expect(failure).toBeInstanceOf(MMError);
      const error = failure as InstanceType<typeof MMError>;
      expect(error.code).toBe("AWAITING_CONFIRM");
      expect(error.status).toBe(409);
      expect(error.details?.["recordingMbid"]).toMatch(/[0-9a-f-]{36}/);
      expect(error.details?.["minMargin"]).toBe(1);
      expect(typeof error.details?.["margin"]).toBe("number");
      // The refusal has to be actionable on its own: which condition, in words.
      expect(Array.isArray(error.details?.["failures"])).toBe(true);
      expect(error.message).toMatch(/margin/i);
    }, 120_000);

    it("leaves a refused single waiting, with no mapping, no release and no decision", async () => {
      const importId = await waitingSingle();
      await confirmBest({ importId, minMargin: 1, confirmedBy: "test", db: db() }).catch(
        () => undefined,
      );

      const job = await imports.getImport(importId, db());
      expect(job?.status).toBe("awaiting_review");
      const options = job?.options as { mapping?: unknown; autoConfirm?: unknown };
      expect(options.mapping).toBeUndefined();
      expect(options.autoConfirm).not.toBe(true);
      expect(job?.releaseMbid).toBeNull();

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.importId, importId))
        .limit(1);
      expect(decision).toBeUndefined();
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */
  /* batch                                                             */
  /* ---------------------------------------------------------------- */

  describe("createImportsBatch", () => {
    it("creates the good URLs and reports the bad one beside it", async () => {
      const urls = ["fixture://discovery", "not-a-url-at-all", "fixture://currents"];
      const outcome = await createImportsBatch({ urls, db: db(), source: "test" });

      expect(outcome.requested).toBe(3);
      expect(outcome.created).toBe(2);
      expect(outcome.failed).toBe(1);
      expect(outcome.ids).toHaveLength(2);

      // In request order, at the index they were sent — that is the whole contract.
      expect(outcome.results.map((row) => row.index)).toEqual([0, 1, 2]);
      expect(outcome.results.map((row) => row.url)).toEqual(urls);
      expect(outcome.results[0]?.ok).toBe(true);
      expect(outcome.results[1]?.ok).toBe(false);
      expect(outcome.results[2]?.ok).toBe(true);

      // The bad URL loses only itself, and says why in the app's own error shape.
      expect(outcome.results[1]?.id).toBeNull();
      expect(outcome.results[1]?.error?.code).toBe("INVALID_INPUT");
      expect(outcome.results[0]?.id).toMatch(/^imp_/);
      expect(outcome.results[2]?.id).toMatch(/^imp_/);
    }, 120_000);

    it("queues what it created, unresolved, for the worker", async () => {
      const outcome = await createImportsBatch({
        urls: ["fixture://skinny-love"],
        db: db(),
        source: "test",
      });
      const id = outcome.ids[0];
      expect(id).toBeDefined();

      const job = await imports.getImport(id as string, db());
      // A batch does not resolve in-process: a hundred extractions do not fit in one request.
      expect(job?.status).toBe("pending");
      expect(job?.step).toBe("resolve");

      const rows = await db()
        .select()
        .from(schema.importTracks)
        .where(eq(schema.importTracks.importId, id as string));
      expect(rows).toHaveLength(0);
    }, 60_000);

    it("reports an earlier import of the same URL rather than refusing it", async () => {
      const first = await createImportsBatch({
        urls: ["fixture://discovery"],
        db: db(),
        source: "test",
      });
      const second = await createImportsBatch({
        urls: ["fixture://discovery"],
        db: db(),
        source: "test",
      });
      expect(second.created).toBe(1);
      expect(second.results[0]?.duplicates).toContain(first.ids[0]);
    }, 60_000);

    it("refuses an over-long list by naming the cap, and creates nothing", async () => {
      const before = await jobs.countImports({}, db());
      const urls = Array.from({ length: MAX_BATCH_URLS + 1 }, () => "fixture://discovery");
      const failure = await createImportsBatch({ urls, db: db() }).catch((error: unknown) =>
        MMError.from(error),
      );

      const error = failure as InstanceType<typeof MMError>;
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.details?.["limit"]).toBe(MAX_BATCH_URLS);
      expect(await jobs.countImports({}, db())).toBe(before);
    }, 60_000);

    it("refuses an empty list", async () => {
      const failure = await createImportsBatch({ urls: [], db: db() }).catch((error: unknown) =>
        MMError.from(error),
      );
      expect((failure as InstanceType<typeof MMError>).code).toBe("INVALID_INPUT");
    });
  });

  /* ---------------------------------------------------------------- */
  /* pagination                                                        */
  /* ---------------------------------------------------------------- */

  describe("listImports and countImports agree", () => {
    it("counts the whole set and pages inside it", async () => {
      const total = await jobs.countImports({}, db());
      expect(total).toBeGreaterThan(2);

      const firstPage = await jobs.listImports({ limit: 2, offset: 0 }, db());
      const secondPage = await jobs.listImports({ limit: 2, offset: 2 }, db());
      expect(firstPage).toHaveLength(2);
      // Two pages of the same ordering never repeat a row: that is what `offset` has to mean
      // for `total`/`hasMore` to be worth anything.
      const ids = new Set([...firstPage, ...secondPage].map((row) => row.id));
      expect(ids.size).toBe(firstPage.length + secondPage.length);
    }, 60_000);

    it("`q` narrows both the page and the total, in SQL", async () => {
      const total = await jobs.countImports({ q: "skinny" }, db());
      const rows = await jobs.listImports({ q: "skinny", limit: 200 }, db());
      expect(rows).toHaveLength(total);
      expect(total).toBeGreaterThan(0);
      expect(rows.every((row) => row.url.includes("skinny"))).toBe(true);
    }, 60_000);
  });
});
