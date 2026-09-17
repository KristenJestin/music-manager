/**
 * Re-entering an import instead of opening a second one, against a real stack.
 *
 * The defect, measured on the owner's instance: **204 imports parked at "Waiting for the import
 * wizard" for 7 URLs**, 80 of them for one album. `createImport` counted the duplicates,
 * journalled them, and inserted a new row anyway — so every round trip through the wizard and
 * every press of "Re-fetch" cost a full yt-dlp extraction.
 *
 * `imports.reuse.test.ts` checks the decision table without a database. This checks that the
 * same rule survives a real `createImport`, a real `resolve`, and two of them at once.
 *
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import type { Import, ImportStatus } from "#/server/db/schema/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_reusetest`;
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
  console.log(`  (import-reuse integration tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const { createImport } = await import("./imports.ts");
const { collapseParkedDuplicates, countParkedDuplicates } = await import("./imports.reuse.ts");
const jobs = await import("./jobs/index.ts");

resetServerEnv();

/**
 * A source of this test's own.
 *
 * The query string is ignored by every fixture in the toolbox but `fp`, `slow` and `snapshot`,
 * and `cassetteNameOf` strips it, so this is the same fifteen recorded videos submitted under a
 * URL no other test in the file shares — which is exactly what "two different albums" means to
 * everything under test here.
 */
function source(name: string): string {
  return `fixture://discovery?case=${name}`;
}

/** What the wizard does: create or re-enter, then park where the worker will not touch it. */
async function enterWizard(url: string): Promise<{ id: string; reused: boolean }> {
  const created = await createImport(url, { db: db(), reuse: true });
  await jobs.pauseImport(created.job.id, "Waiting for the import wizard.", db());
  return { id: created.job.id, reused: created.reused };
}

async function importsFor(url: string): Promise<Import[]> {
  return await db().select().from(schema.imports).where(eq(schema.imports.url, url));
}

describe.skipIf(unavailable !== null)("re-entering an import for a URL", () => {
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
  }, 120_000);

  /* ---------------------------------------------------------------- */
  /* the defect itself                                                 */
  /* ---------------------------------------------------------------- */

  it("entering the wizard twice with one URL leaves exactly one import", async () => {
    const url = source("twice");
    const first = await enterWizard(url);
    const second = await enterWizard(url);

    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
    expect(first.reused).toBe(false);
    expect(await importsFor(url)).toHaveLength(1);

    // And it really is the same work, not a second extraction into the same row.
    const tracks = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, first.id));
    expect(tracks).toHaveLength(15);
  }, 180_000);

  it("says so in the journal rather than switching identity in silence", async () => {
    const url = source("journal");
    const first = await enterWizard(url);
    await enterWizard(url);

    const events = await db()
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.importId, first.id));
    const reused = events.find((event) => event.type === "import.reused");
    expect(reused, "a re-entry writes its own journal line").toBeDefined();
    expect(reused?.message).toContain("rather than opening another one");
  }, 180_000);

  /* ---------------------------------------------------------------- */
  /* one per status decision                                           */
  /* ---------------------------------------------------------------- */

  /** Park an import for `url`, then force it into `status`, and enter the wizard again. */
  async function afterStatus(
    url: string,
    status: ImportStatus,
    pausedBy: "user" | "worker" | null = null,
  ): Promise<{ first: string; second: string; reused: boolean }> {
    const first = await enterWizard(url);
    await db()
      .update(schema.imports)
      .set({ status, ...(pausedBy === null ? {} : { pausedBy }) })
      .where(eq(schema.imports.id, first.id));
    const second = await enterWizard(url);
    return { first: first.id, second: second.id, reused: second.reused };
  }

  it("re-enters an import parked for the wizard", async () => {
    const outcome = await afterStatus(source("st-paused"), "paused", "user");
    expect(outcome.second).toBe(outcome.first);
    expect(outcome.reused).toBe(true);
  }, 180_000);

  it("re-enters a `pending` import — the row a concurrent caller has just inserted", async () => {
    const outcome = await afterStatus(source("st-pending"), "pending");
    expect(outcome.second).toBe(outcome.first);
    expect(outcome.reused).toBe(true);
  }, 180_000);

  it("opens a new import beside a `running` one, rather than parking a live download", async () => {
    const outcome = await afterStatus(source("st-running"), "running");
    expect(outcome.second).not.toBe(outcome.first);
    expect(outcome.reused).toBe(false);
  }, 180_000);

  it("opens a new import beside a `done` one, and reports the duplicate", async () => {
    const url = source("st-done");
    const first = await enterWizard(url);
    await db()
      .update(schema.imports)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.imports.id, first.id));

    const again = await createImport(url, { db: db(), reuse: true });
    expect(again.reused).toBe(false);
    expect(again.job.id).not.toBe(first.id);
    // The existing `duplicates` reporting is exactly what a finished import deserves.
    expect(again.duplicates.map((row) => row.id)).toContain(first.id);
  }, 180_000);

  it("opens a new import beside a `failed` one: the row is the record of the failure", async () => {
    const outcome = await afterStatus(source("st-failed"), "failed");
    expect(outcome.second).not.toBe(outcome.first);
  }, 180_000);

  it("opens a new import beside a `cancelled` one: somebody said no to that one", async () => {
    const outcome = await afterStatus(source("st-cancelled"), "cancelled");
    expect(outcome.second).not.toBe(outcome.first);
  }, 180_000);

  it("opens a new import beside one waiting on a person or on a source", async () => {
    for (const status of ["awaiting_confirm", "awaiting_review", "waiting_upstream"] as const) {
      const outcome = await afterStatus(source(`st-${status}`), status);
      expect(outcome.second, status).not.toBe(outcome.first);
    }
  }, 300_000);

  it("leaves an import the **worker** paused to the boot sweep", async () => {
    const outcome = await afterStatus(source("st-shutdown"), "paused", "worker");
    expect(outcome.second).not.toBe(outcome.first);
  }, 180_000);

  it("keeps opening a new import for every caller that has not asked to re-enter", async () => {
    // `POST /api/v1/imports`, `mm import`, MCP, a batch, a watched-source scan: unchanged.
    const url = source("no-reuse");
    const first = await createImport(url, { db: db() });
    const second = await createImport(url, { db: db() });
    expect(second.job.id).not.toBe(first.job.id);
    expect(second.reused).toBe(false);
    expect(await importsFor(url)).toHaveLength(2);
  }, 180_000);

  /* ---------------------------------------------------------------- */
  /* concurrency                                                       */
  /* ---------------------------------------------------------------- */

  it("two simultaneous entries for one URL yield one import", async () => {
    const url = source("race");
    const [left, right] = await Promise.all([
      createImport(url, { db: db(), reuse: true }),
      createImport(url, { db: db(), reuse: true }),
    ]);

    expect(await importsFor(url)).toHaveLength(1);
    expect(left.job.id).toBe(right.job.id);
    // Exactly one of the two opened it; the other waited for the resolve and re-entered.
    expect([left.reused, right.reused].filter(Boolean)).toHaveLength(1);
    // And the loser is not handed an import with no videos in it.
    const loser = left.reused ? left : right;
    const tracks = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, loser.job.id));
    expect(tracks).toHaveLength(15);
  }, 240_000);

  it("four at once still yield one import", async () => {
    const url = source("race4");
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map(async () => await createImport(url, { db: db(), reuse: true })),
    );
    expect(await importsFor(url)).toHaveLength(1);
    expect(new Set(outcomes.map((one) => one.job.id)).size).toBe(1);
  }, 240_000);

  /* ---------------------------------------------------------------- */
  /* the cleanup                                                       */
  /* ---------------------------------------------------------------- */

  it("collapses the parked siblings of a URL, keeping the newest", async () => {
    const url = source("collapse");
    // Three parked imports of one URL, made the way they were made before this branch.
    const made: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await createImport(url, { db: db(), resolveNow: false });
      await jobs.pauseImport(created.job.id, "Waiting for the import wizard.", db());
      made.push(created.job.id);
    }

    const dry = await collapseParkedDuplicates({ url, db: db() });
    expect(dry.applied).toBe(false);
    expect(dry.cancelled).toBe(2);
    // Nothing changed: a dry run is a dry run.
    let rows = await importsFor(url);
    expect(rows.filter((row) => row.status === "paused")).toHaveLength(3);

    const applied = await collapseParkedDuplicates({ url, apply: true, db: db() });
    expect(applied.applied).toBe(true);
    expect(applied.cancelled).toBe(2);

    rows = await importsFor(url);
    const kept = rows.filter((row) => row.status === "paused");
    expect(kept).toHaveLength(1);
    expect(made).toContain(kept[0]?.id);
    expect(rows.filter((row) => row.status === "cancelled")).toHaveLength(2);
    // Idempotent: there is nothing left to collapse.
    expect((await collapseParkedDuplicates({ url, apply: true, db: db() })).cancelled).toBe(0);
  }, 180_000);

  it("never collapses an import whose tracks have done work", async () => {
    const url = source("collapse-guard");
    const worked = await createImport(url, { db: db() });
    await jobs.pauseImport(worked.job.id, "Waiting for the import wizard.", db());
    const [track] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, worked.job.id))
      .limit(1);
    await db()
      .update(schema.importTracks)
      .set({ state: "downloaded", downloadPath: "/library/.mm-work/x/1.opus" })
      .where(eq(schema.importTracks.id, track?.id ?? ""));

    // Two more, idle, so the URL genuinely has siblings to collapse.
    for (let index = 0; index < 2; index += 1) {
      const created = await createImport(url, { db: db(), resolveNow: false });
      await jobs.pauseImport(created.job.id, "Waiting for the import wizard.", db());
    }

    const applied = await collapseParkedDuplicates({ url, apply: true, db: db() });
    expect(applied.cancelled).toBe(1);
    const after = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, worked.job.id));
    expect(after[0]?.status, "the import that downloaded something is untouched").toBe("paused");
  }, 180_000);

  it("counts what a collapse would cancel, for the Jobs page", async () => {
    expect(await countParkedDuplicates(db())).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
