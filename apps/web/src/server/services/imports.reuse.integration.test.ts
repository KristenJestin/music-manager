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

  /**
   * Park an import for `url`, force it into `status`, and enter the wizard again.
   *
   * `matched` writes the `job_steps` row a state implies. It is not decoration: a `running`
   * import with nothing past `resolve` in `job_steps` **is** a creation in flight and is
   * re-entered on purpose, so a test that forced only the status would be describing a row
   * that cannot exist — `awaiting_confirm` without a `match` having run is not a state the
   * pipeline can produce.
   */
  async function afterStatus(
    url: string,
    status: ImportStatus,
    options: { pausedBy?: "user" | "worker"; matched?: boolean } = {},
  ): Promise<{ first: string; second: string; reused: boolean }> {
    const first = await enterWizard(url);
    await db()
      .update(schema.imports)
      .set({ status, ...(options.pausedBy === undefined ? {} : { pausedBy: options.pausedBy }) })
      .where(eq(schema.imports.id, first.id));
    if (options.matched === true) {
      await db()
        .insert(schema.jobSteps)
        .values({ id: `stp_${first.id}`, importId: first.id, step: "match", status: "running" });
    }
    const second = await enterWizard(url);
    return { first: first.id, second: second.id, reused: second.reused };
  }

  it("re-enters an import parked for the wizard", async () => {
    const outcome = await afterStatus(source("st-paused"), "paused", { pausedBy: "user" });
    expect(outcome.second).toBe(outcome.first);
    expect(outcome.reused).toBe(true);
  }, 180_000);

  it("re-enters a `pending` import — the row a concurrent caller has just inserted", async () => {
    const outcome = await afterStatus(source("st-pending"), "pending");
    expect(outcome.second).toBe(outcome.first);
    expect(outcome.reused).toBe(true);
  }, 180_000);

  it("opens a new import beside a `running` one the worker has started on", async () => {
    const outcome = await afterStatus(source("st-running"), "running", { matched: true });
    expect(outcome.second).not.toBe(outcome.first);
    expect(outcome.reused).toBe(false);
  }, 180_000);

  it("re-enters a `running` one nothing has begun: that is the creation in flight", async () => {
    // The row the owner's four duplicates were: `runStep` wears `running` for the whole of
    // `resolve`, and a successful `resolve` leaves it `running` at `match`.
    const outcome = await afterStatus(source("st-creating"), "running");
    expect(outcome.second).toBe(outcome.first);
    expect(outcome.reused).toBe(true);
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
      const outcome = await afterStatus(source(`st-${status}`), status, { matched: true });
      expect(outcome.second, status).not.toBe(outcome.first);
    }
  }, 300_000);

  it("leaves an import the **worker** paused to the boot sweep", async () => {
    const outcome = await afterStatus(source("st-shutdown"), "paused", { pausedBy: "worker" });
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

  /**
   * The cause the owner found, and it is not the round trip.
   *
   * He watched **four identical imports** of one playlist arrive at once, all `Paused` at
   * `0/13`, all created "just now", without having refreshed anything. The wizard's loader
   * creates in its `?url=` branch and only swaps the address bar for `?importId=` *after*
   * `resolveSource` returns — and on his playlist that took a minute. For that whole minute
   * anything that re-enters the loader is another creation, and the match poll's
   * `router.invalidate()` fires every four seconds.
   *
   * So the window is reproduced rather than assumed: `?extractslow=2500` makes the toolbox
   * take two and a half seconds to answer `/extract`, and three more entries arrive inside it
   * at roughly the poll's cadence. A test with a fast resolve passes either way and proves
   * nothing, which is exactly why this one asks for a slow one.
   *
   * This is the **stronger** race of the two: the re-entries land while the first call is
   * inside `resolve`, i.e. after its insert has committed but long before it has finished —
   * and, for the first of them, possibly before the insert has committed at all. The advisory
   * lock covers both, because it is taken *before* the select and released only by the commit.
   */
  it("a slow resolve re-entered three times during it still leaves one import", async () => {
    const url = source("poll") + "&extractslow=2500";
    const started = Date.now();

    let openedFor = 0;
    const first = createImport(url, { db: db(), reuse: true }).then((result) => {
      openedFor = Date.now() - started;
      return result;
    });
    // Three re-entries inside the extraction, at about the wizard's own poll cadence.
    const later: Promise<Awaited<typeof first>>[] = [];
    for (const delay of [400, 1_200, 2_000]) {
      later.push(
        new Promise((go) => setTimeout(go, delay)).then(
          async () => await createImport(url, { db: db(), reuse: true }),
        ),
      );
    }
    const outcomes = await Promise.all([first, ...later]);

    /*
     * The window really was open, measured on the creating call itself.
     *
     * Without this the test would pass on an eight-millisecond extraction — every re-entry
     * would arrive long after the first had finished, which is a different situation with the
     * same assertion. That is the trap the owner's report names: a fast resolve proves nothing.
     */
    expect(openedFor, "the creating call must still have been resolving").toBeGreaterThan(2_000);
    expect(await importsFor(url)).toHaveLength(1);
    expect(new Set(outcomes.map((one) => one.job.id)).size).toBe(1);
    expect(outcomes.filter((one) => one.reused)).toHaveLength(3);

    // And every one of them was handed a resolved import, not an empty shell: a re-entry that
    // returned a source with no videos would be a different bug wearing the same fix.
    const tracks = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, outcomes[0]?.job.id ?? ""));
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
