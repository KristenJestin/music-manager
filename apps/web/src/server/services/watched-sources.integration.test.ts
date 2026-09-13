/**
 * Watched sources against a real Postgres and a real toolbox in fixtures mode.
 *
 * The unit tests next door prove the filters and the auto-accept gate decide correctly. What
 * only a database can prove is the part the feature actually rests on: that scanning the same
 * listing twice discovers nothing the second time, that a listing which has grown by one video
 * discovers exactly one, and that the gate a scan opens ends where it says it does — `done` for
 * a source that opted in, `awaiting_confirm` plus an Inbox item for one that did not.
 *
 * It skips itself when the stack is down, like every other integration suite here:
 *
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-watched-itest");
const LIBRARY_CONTAINER = "/library/.mm-watched-itest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_watched_itest`;
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
  console.log(`  (watched-source integration tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { and, eq } = await import("drizzle-orm");
const jobs = await import("./jobs/index.ts");
const watched = await import("./watched-sources.ts");

resetServerEnv();

describe.skipIf(unavailable !== null)("watched sources against a real stack", () => {
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

    if (existsSync(LIBRARY_HOST)) rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
  }, 120_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */

  describe("the diff", () => {
    let sourceId = "";

    it("imports every reachable video of the first snapshot, and skips the private one", async () => {
      const source = await watched.createWatchedSource(
        { url: "fixture://watched?snapshot=1", label: "Snapshot" },
        { db: db() },
      );
      sourceId = source.id;

      const report = await watched.scanSource(sourceId, { db: db() });
      expect(report.status).toBe("ok");
      expect(report.listed).toBe(3);
      expect(report.discovered).toBe(3);
      expect(report.imported).toBe(2);
      expect(report.skipped).toBe(1);

      const items = await db()
        .select()
        .from(schema.watchedSourceItems)
        .where(eq(schema.watchedSourceItems.sourceId, sourceId));
      expect(items).toHaveLength(3);
      const priv = items.find((item) => item.videoId === "wsvPPPPPPPP");
      expect(priv?.status).toBe("skipped");
      expect(priv?.reason).toContain("Unavailable");
    }, 120_000);

    it("discovers nothing the second time, and opens no second import", async () => {
      const report = await watched.scanSource(sourceId, { db: db() });
      expect(report.discovered).toBe(0);
      expect(report.imported).toBe(0);

      const items = await db()
        .select()
        .from(schema.watchedSourceItems)
        .where(eq(schema.watchedSourceItems.sourceId, sourceId));
      expect(items).toHaveLength(3);
    }, 120_000);

    it("discovers exactly one when the listing has grown by one", async () => {
      // The same source, pointed at tomorrow's listing. Everything it has already seen is
      // still there; one video is not.
      await db()
        .update(schema.watchedSources)
        .set({ url: "fixture://watched?snapshot=2" })
        .where(eq(schema.watchedSources.id, sourceId));

      const report = await watched.scanSource(sourceId, { db: db() });
      expect(report.listed).toBe(4);
      expect(report.discovered).toBe(1);
      expect(report.imported).toBe(1);

      const items = await db()
        .select()
        .from(schema.watchedSourceItems)
        .where(eq(schema.watchedSourceItems.sourceId, sourceId));
      expect(items).toHaveLength(4);
      expect(items.map((item) => item.videoId)).toContain("wsvCCCCCCCC");
    }, 120_000);

    it("marks the source scanned, with no error", async () => {
      const [row] = await db()
        .select()
        .from(schema.watchedSources)
        .where(eq(schema.watchedSources.id, sourceId));
      expect(row?.lastScanStatus).toBe("ok");
      expect(row?.lastError).toBeNull();
      expect(row?.lastScanAt).not.toBeNull();
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the filters", () => {
    it("skips a video the duration floor refuses, with the reason on the row", async () => {
      const source = await watched.createWatchedSource(
        { url: "fixture://watched?snapshot=1&case=duration", minDuration: 600 },
        { db: db() },
      );
      const report = await watched.scanSource(source.id, { db: db() });
      expect(report.imported).toBe(0);
      expect(report.skipped).toBe(3);

      const items = await db()
        .select()
        .from(schema.watchedSourceItems)
        .where(eq(schema.watchedSourceItems.sourceId, source.id));
      const refused = items.find((item) => item.videoId === "wsvAAAAAAAA");
      expect(refused?.reason).toContain("600s floor");
    }, 120_000);
  });

  /* ---------------------------------------------------------------- */

  describe("the auto-accept gate", () => {
    /**
     * Fixtures mode confirms every ordinary import automatically, which is what makes the
     * offline run possible. A watched-source import must **not** inherit that: it is decided
     * by its source's policy in every mode, and this is where that claim is checked rather
     * than asserted in a comment.
     */
    it("takes a source that opted in all the way to done", async () => {
      const source = await watched.createWatchedSource(
        { url: "fixture://watched?snapshot=1&case=trusted", autoAccept: true, label: "Trusted" },
        { db: db() },
      );
      const report = await watched.scanSource(source.id, { db: db() });
      const importId = report.importIds[0];
      expect(importId).toBeDefined();

      const outcome = await jobs.runImport(importId ?? "");
      expect(outcome.status).toBe("done");

      const [decision] = await db()
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.importId, importId ?? ""));
      expect(decision?.decidedBy).toBe("watched-source");
    }, 300_000);

    it("parks a source that did not opt in, and opens an Inbox item pointing at it", async () => {
      const source = await watched.createWatchedSource(
        {
          url: "fixture://watched?snapshot=1&case=untrusted",
          autoAccept: false,
          label: "Untrusted",
        },
        { db: db() },
      );
      const report = await watched.scanSource(source.id, { db: db() });
      const importId = report.importIds[0] ?? "";

      const outcome = await jobs.runImport(importId);
      expect(outcome.status).toBe("awaiting_confirm");
      expect(outcome.step).toBe("confirm");

      const [item] = await db()
        .select()
        .from(schema.inboxItems)
        .where(
          and(
            eq(schema.inboxItems.importId, importId),
            eq(schema.inboxItems.type, "source_new_video"),
          ),
        );
      expect(item).toBeDefined();
      expect(item?.payload["watchedSourceId"]).toBe(source.id);
      expect(item?.summary).toContain("auto-accept is off");

      // Nothing was downloaded: the gate is before `download`, which is the whole point.
      const steps = await jobs.stepsOf(importId);
      expect(steps.find((entry) => entry.step === "download")?.row).toBeNull();
    }, 300_000);
  });

  /* ---------------------------------------------------------------- */

  describe("CRUD", () => {
    it("refuses a second source for the same URL, and names the one that exists", async () => {
      const url = "fixture://watched?snapshot=2&dup=1";
      await watched.createWatchedSource({ url }, { db: db() });
      await expect(watched.createWatchedSource({ url }, { db: db() })).rejects.toThrow(
        /already watched/,
      );
    });

    it("keeps the imports when the source is forgotten", async () => {
      const source = await watched.createWatchedSource(
        { url: "fixture://watched?snapshot=1&keep=1" },
        { db: db() },
      );
      const report = await watched.scanSource(source.id, { db: db() });
      const importId = report.importIds[0] ?? "";
      expect(importId).not.toBe("");

      await watched.deleteWatchedSource(source.id, db());

      const [job] = await db().select().from(schema.imports).where(eq(schema.imports.id, importId));
      expect(job).toBeDefined();

      const items = await db()
        .select()
        .from(schema.watchedSourceItems)
        .where(eq(schema.watchedSourceItems.sourceId, source.id));
      expect(items).toHaveLength(0);
    }, 120_000);
  });
});
