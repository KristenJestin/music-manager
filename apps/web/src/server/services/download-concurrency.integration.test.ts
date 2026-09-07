/**
 * The single download slot, under the pressure that broke it.
 *
 * This file exists because of the owner's second review, C3 and C4. Two real albums were
 * importing; a Retry was pressed on the second while the first was downloading; the toolbox
 * answered `409 LOCKED` and the job went `Failed`, with
 * `A download is already running.` printed as WARN and then as ERROR between tracks.
 *
 * The cause was not the queue. pg-boss serialised correctly — the `download` queue is
 * `singleton` and one worker consumes it. The cause was that **`retryStep` ran the step in the
 * caller's process**: the Console's Retry button, the REST route and `mm retry` all ended in
 * `runImport`, so pressing Retry started a second downloader beside the worker's, inside an
 * HTTP request, where no queue could see it. `rewindTo` is the fix, and the first test below
 * is its contract, asserted without any timing at all: the retry path may **not** call the
 * toolbox.
 *
 * The second test is the owner's scenario itself — two jobs and a Retry at once — and asserts
 * the three things he actually complained about: one download at a time, no `LOCKED` line in
 * the journal, and no job that ends `failed`.
 *
 * Needs the stack, in fixtures mode, like its neighbour:
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-dltest");
const LIBRARY_CONTAINER = "/library/.mm-dltest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/**
 * A database of this file's own, derived from the checkout's.
 *
 * Not `<base>_itest`: `pipeline.integration.test.ts` drops and recreates that one in its
 * `beforeAll`, and vitest runs files in parallel. Two suites sharing a database is the same
 * mistake as two agents sharing a stack.
 */
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_dltest`;
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
  console.log(`  (download concurrency tests skipped: ${unavailable})`);
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
const { and, eq, inArray } = await import("drizzle-orm");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const queue = await import("./queue.ts");
const toolboxClient = await import("#/server/toolbox/client.ts");
const worker = await import("#/worker/index.ts");

resetServerEnv();

/**
 * The one album the offline cassettes cover, imported twice.
 *
 * `fixture://currents` would have been prettier, but only `discovery` and the `skinny-love`
 * recording are in the seeded raw cache, and a test that reaches MusicBrainz is not a test.
 * The second import carries `force`, so it downloads its fourteen tracks again instead of
 * skipping them as "already present" — which is exactly the contention this file is about.
 */
const SOURCE = "fixture://discovery";

describe.skipIf(unavailable !== null)("the single download slot", () => {
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
  }, 180_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */

  it("a Retry queues the job; it never downloads in the caller's process", async () => {
    const created = await imports.createFromUrl(SOURCE, { autoConfirm: true });
    const id = created.job.id;
    // Bring it to the edge of `download` the way the worker does, and stop there.
    const outcome = await jobs.runImport(id, { stopBefore: "download" });
    expect(outcome.handOff).toBe("download");

    /*
     * The whole of C3, as an assertion with no clock in it: whatever the Console's Retry
     * button does, it must not reach the toolbox. Before the fix this called `runImport`, the
     * download step ran here, and `download` was called once per track — beside the worker's
     * own download of another album, which is what earned the owner his `409 LOCKED`.
     */
    type Downloader = { download: (options: never) => AsyncGenerator<never> };
    const client = toolboxClient.toolbox() as unknown as Downloader;
    const real = client.download;
    let downloads = 0;
    client.download = (options: never) => {
      downloads += 1;
      return real.call(client, options);
    };
    try {
      // Exactly the body of `retryJob` in `server/functions/jobs.ts`.
      const from = await jobs.resumeStepOf(id);
      expect(from).toBe("download");
      await jobs.rewindTo(id, from);
      await queue.enqueue(id, "test retry", from);
    } finally {
      client.download = real;
    }

    expect(downloads, "a Retry must queue, never download").toBe(0);

    // And the rows say "queued", not "ran": no worker is running in this test.
    const steps = await jobs.stepsOf(id);
    const download = steps.find((entry) => entry.step === "download");
    expect(download?.row?.status ?? "pending").toBe("pending");
    const job = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .then((rows) => rows[0]);
    expect(job?.status).toBe("running");
    expect(job?.step).toBe("download");

    // Leave nothing queued behind: the next test starts a real worker, and it resumes every
    // job it finds — including this one, which would muddy its assertions.
    await jobs.cancelImport(id);

    /*
     * And the other half of the same rule: a `download` message that outlives the job it names
     * must not be honoured. The message enqueued four lines above is still on the queue — the
     * Console cancelling an import does not reach into pg-boss — so the next worker to start
     * will find it. `runStep` is what the download queue calls, and it is the only entry point
     * into the pipeline that never checked whether the job was still wanted: it downloaded the
     * cancelled album, held the single global slot for the length of it, and then wrote
     * `imports.status` back to `running`, resurrecting a job the owner had cancelled.
     */
    let refusedDownloads = 0;
    client.download = (options: never) => {
      refusedDownloads += 1;
      return real.call(client, options);
    };
    try {
      // `skipIfStopped` is exactly what the worker's download handler passes.
      const outcome = await jobs.runStep(id, "download", { skipIfStopped: true });
      expect(outcome.status).toBe("skipped");
      expect((outcome.data as { refused?: string } | undefined)?.refused).toBe("cancelled");
    } finally {
      client.download = real;
    }
    expect(refusedDownloads, "a cancelled job must not take the download slot").toBe(0);

    const after = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .then((rows) => rows[0]);
    expect(after?.status, "a refused step must not revive the job").toBe("cancelled");
  }, 180_000);

  /* ---------------------------------------------------------------- */

  it("serialises two jobs and a Retry fired at the same time, and fails none of them", async () => {
    const ids: string[] = [];
    for (const force of [false, true]) {
      const created = await imports.createFromUrl(SOURCE, { autoConfirm: true, force });
      const outcome = await jobs.runImport(created.job.id, { stopBefore: "download" });
      expect(outcome.handOff, `the import should be waiting for the download queue`).toBe(
        "download",
      );
      ids.push(created.job.id);
    }
    const [first, second] = ids as [string, string];

    // The worker picks both up on start (they are `running` at `download`), which is the same
    // path a restart takes. Nothing about this test is special-cased in the worker.
    const running = await worker.startWorker();
    try {
      // The owner's gesture: Retry, on the other job, while the first one downloads. Fired
      // three times in a row for good measure — he pressed it "plein de fois".
      await waitUntil(
        async () => (await eventCount(first, "track.started")) > 0,
        "the first download to start",
        60_000,
      );
      for (let press = 0; press < 3; press += 1) {
        await jobs.rewindTo(second, "download");
        await queue.enqueue(second, "test retry", "download");
        await sleep(150);
      }

      await waitUntil(
        async () => await bothSettled(ids),
        "both imports to reach a terminal state",
        300_000,
      );
    } finally {
      await running.stop();
    }

    /* ---- 1. no job failed ---- */
    const rows = await db().select().from(schema.imports).where(inArray(schema.imports.id, ids));
    for (const row of rows) {
      expect(row.status, `${row.url}: ${JSON.stringify(row.error)}`).not.toBe("failed");
    }

    /* ---- 2. no `LOCKED` anywhere in the journal, at any level ---- */
    const journal = await db()
      .select()
      .from(schema.jobEvents)
      .where(inArray(schema.jobEvents.importId, ids));
    const locked = journal.filter(
      (event) =>
        event.message.includes("already running") ||
        (event.data as { code?: string } | null)?.code === "LOCKED",
    );
    expect(locked.map((event) => `${event.level} ${event.type} ${event.message}`)).toEqual([]);

    // Nor any failed track, which is how the owner's album lost its fourth song.
    const failures = journal.filter((event) => event.type === "track.failed");
    expect(failures.map((event) => event.message)).toEqual([]);

    /* ---- 3. one download at a time, as pg-boss recorded it ---- */
    // The queue's own ledger, read directly: two rows whose [started, completed] intervals
    // overlap are two downloads at once, whatever the journal says.
    const ledger = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
    const slots = await ledger<{ started_on: Date | null; completed_on: Date | null }[]>`
      select started_on, completed_on from pgboss.job
      where name = 'download' and started_on is not null
      order by started_on
    `;
    await ledger.end();
    const windows = slots.map((row) => ({
      from: row.started_on === null ? 0 : row.started_on.getTime(),
      to: row.completed_on === null ? Number.MAX_SAFE_INTEGER : row.completed_on.getTime(),
    }));
    expect(windows.length, "both imports should have taken the slot").toBeGreaterThanOrEqual(2);
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1];
      const current = windows[index];
      if (previous === undefined || current === undefined) continue;
      expect(current.from, "two downloads held the slot at once").toBeGreaterThanOrEqual(
        previous.to,
      );
    }
  }, 600_000);
});

/* ------------------------------------------------------------------ */

async function eventCount(importId: string, type: string): Promise<number> {
  const rows = await db()
    .select()
    .from(schema.jobEvents)
    .where(and(eq(schema.jobEvents.importId, importId), eq(schema.jobEvents.type, type)));
  return rows.length;
}

async function bothSettled(ids: readonly string[]): Promise<boolean> {
  const rows = await db()
    .select()
    .from(schema.imports)
    .where(inArray(schema.imports.id, [...ids]));
  return (
    rows.length === ids.length &&
    rows.every((row) => ["done", "failed", "cancelled"].includes(row.status))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
