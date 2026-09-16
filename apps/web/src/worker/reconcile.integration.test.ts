/**
 * The boot sweep, against a real database and a real pg-boss.
 *
 * Every assertion here is one of the ways a container restart used to amputate the in-flight
 * batch, written as a row and a queue rather than as a mock:
 *
 *  1. an import the *worker* paused on its way out is resumed;
 *  2. an import the *owner* paused is not — a deploy is not permission to restart it;
 *  3. a `waiting_upstream` row whose `next_attempt_at` has passed departs now;
 *  4. one whose `next_attempt_at` is in the future departs after the remaining wait, not
 *     immediately and not from zero;
 *  5. a `running` row with no job left — the worker killed mid-step — is resumed;
 *  6. `done`, `cancelled` and `failed` are never touched;
 *  7. two sweeps in a row produce one message per import, not two.
 *
 * (7) is not a formality. `enqueueImportStep` passes `singletonKey: importId`, which on
 * pg-boss 12 deduplicates nothing on a `standard` queue — the unique indexes on
 * `singleton_key` are created per policy, and `standard` gets none. The sweep therefore reads
 * pg-boss's ledger before it sends, and this test is what says so.
 *
 * No toolbox: nothing here runs a step. It needs postgres, and skips itself without one.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_resume`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function postgresIsUp(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
  return null;
}

const unavailable = await postgresIsUp();
if (unavailable !== null) {
  console.log(`  (resume sweep tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { eq } = await import("drizzle-orm");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { newId } = await import("#/server/ids.ts");
const { pauseImport } = await import("#/server/services/jobs/index.ts");
const queues = await import("./queues.ts");
const { reconcileImports } = await import("./reconcile.ts");

resetServerEnv();

type Boss = Awaited<ReturnType<typeof queues.createBoss>>;

describe.skipIf(unavailable !== null)("the boot reconciliation sweep", () => {
  let boss: Boss;
  let ledger: ReturnType<typeof postgres>;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    // A producer: it creates the pg-boss schema and sends, and consumes nothing. Nothing may
    // drain these queues during the test, or "exactly one message" would be unobservable.
    boss = queues.createBoss({ producer: true });
    await boss.start();
    await queues.ensureQueues(boss);
    ledger = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  }, 180_000);

  afterAll(async () => {
    await queues.stopBoss(boss);
    await ledger.end();
  });

  beforeEach(async () => {
    for (const queue of queues.IMPORT_QUEUES) await boss.deleteAllJobs(queue);
    await db().delete(schema.jobEvents);
    await db().delete(schema.imports);
  });

  /** One import row, in whatever state the test is about. */
  async function given(
    row: Partial<typeof schema.imports.$inferInsert> & {
      status: (typeof schema.imports.$inferInsert)["status"];
    },
  ): Promise<string> {
    const id = newId("import");
    await db()
      .insert(schema.imports)
      .values({
        id,
        url: `fixture://${id}`,
        kind: "album",
        step: "match",
        ...row,
      });
    return id;
  }

  /** Every message on the three import queues, with the delay pg-boss recorded for it. */
  async function queued(): Promise<{ name: string; importId: string; startAfter: Date }[]> {
    const rows = await ledger<{ name: string; import_id: string; start_after: Date }[]>`
      select name, data->>'importId' as import_id, start_after
        from pgboss.job
       where state < 'completed'
       order by name, start_after`;
    return rows.map((row) => ({
      name: row.name,
      importId: row.import_id,
      startAfter: row.start_after,
    }));
  }

  async function messagesFor(id: string): Promise<{ name: string; startAfter: Date }[]> {
    return (await queued())
      .filter((job) => job.importId === id)
      .map(({ name, startAfter }) => ({ name, startAfter }));
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .limit(1);
    return row?.status ?? "gone";
  }

  /* ---------------------------------------------------------------- */

  it("resumes a pause the worker imposed and leaves the owner's alone", async () => {
    const byWorker = await given({ status: "running" });
    const byOwner = await given({ status: "running" });
    // Through the real function, not by writing the column: the discriminator has to survive
    // the path the shutdown and the Console actually take.
    await pauseImport(byWorker, "the worker is shutting down", db(), "worker");
    await pauseImport(byOwner, "Paused from the Console.", db());

    expect(await statusOf(byWorker)).toBe("paused");
    expect(await statusOf(byOwner)).toBe("paused");

    const report = await reconcileImports(boss, { db: db() });

    expect(report.resumed).toBe(1);
    expect(report.byReason["paused-by-shutdown"]).toBe(1);
    expect(await messagesFor(byWorker)).toHaveLength(1);

    /*
     * The one that must never regress. An import the owner stopped is stopped; a reboot is
     * not a person, and a deploy is not a Resume button.
     */
    expect(await messagesFor(byOwner)).toEqual([]);
  });

  it("sends a due `waiting_upstream` row now and a future one late", async () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const due = await given({
      status: "waiting_upstream",
      upstreamAttempts: 3,
      nextAttemptAt: new Date(now.getTime() - 61 * 60 * 1000),
    });
    const later = await given({
      status: "waiting_upstream",
      upstreamAttempts: 2,
      nextAttemptAt: new Date(now.getTime() + 10 * 60 * 1000),
    });

    const report = await reconcileImports(boss, { db: db(), now });

    // The whole point of the branch: `waiting_upstream` was never selected, so the code that
    // honours `next_attempt_at` — which has been there all along — never ran once.
    expect(report.byReason["waiting-upstream-due"]).toBe(2);

    const [dueJob] = await messagesFor(due);
    const [lateJob] = await messagesFor(later);
    expect(dueJob).toBeDefined();
    expect(lateJob).toBeDefined();
    // An hour in the past departs immediately; ten minutes in the future waits out what is
    // left of them, rather than restarting the ladder or ignoring it.
    expect((dueJob?.startAfter.getTime() ?? 0) - Date.now()).toBeLessThan(5_000);
    const delayMs = (lateJob?.startAfter.getTime() ?? 0) - Date.now();
    expect(delayMs).toBeGreaterThan(8 * 60 * 1000);
    expect(delayMs).toBeLessThan(12 * 60 * 1000);
  });

  it("resumes a `running` import with no job left, on the queue its step names", async () => {
    const midStep = await given({ status: "running", step: "match" });
    const midDownload = await given({ status: "running", step: "download" });
    const pending = await given({ status: "pending", step: "resolve" });

    const report = await reconcileImports(boss, { db: db() });

    expect(report.byReason["running-orphan"]).toBe(3);
    expect(await messagesFor(midStep)).toEqual([
      { name: queues.QUEUES.importStep, startAfter: expect.any(Date) },
    ]);
    // A job killed inside `download` goes back to the single global slot, not through the
    // step runner, or it would queue behind itself.
    expect(await messagesFor(midDownload)).toEqual([
      { name: queues.QUEUES.download, startAfter: expect.any(Date) },
    ]);
    expect(await messagesFor(pending)).toHaveLength(1);
  });

  it("never touches a finished import, nor one waiting on a human", async () => {
    const untouchable = [
      await given({ status: "done", finishedAt: new Date() }),
      await given({ status: "cancelled", finishedAt: new Date() }),
      await given({ status: "failed", finishedAt: new Date() }),
      await given({ status: "awaiting_confirm", step: "confirm" }),
      await given({ status: "awaiting_review", step: "fingerprint" }),
    ];

    const report = await reconcileImports(boss, { db: db() });

    expect(report.resumed).toBe(0);
    expect(await queued()).toEqual([]);
    for (const id of untouchable) expect(await messagesFor(id)).toEqual([]);
  });

  it("run twice, enqueues once — and leaves a surviving message alone", async () => {
    const orphan = await given({ status: "running", step: "match" });
    const waiting = await given({
      status: "waiting_upstream",
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const first = await reconcileImports(boss, { db: db() });
    expect(first.resumed).toBe(2);
    expect(first.skipped).toBe(0);

    /*
     * The second pass stands in for the case the boot purge does not cover: a sweep running
     * against a queue that still holds messages, which a future reordering of the boot
     * sequence could produce at any time. Both imports already have one, so both are counted
     * as skipped and neither is sent a second.
     */
    const second = await reconcileImports(boss, { db: db() });
    expect(second.resumed).toBe(0);
    expect(second.skipped).toBe(2);

    expect(await messagesFor(orphan)).toHaveLength(1);
    expect(await messagesFor(waiting)).toHaveLength(1);
  });

  it("writes one journal line per resumed import, carrying its reason", async () => {
    const paused = await given({ status: "running" });
    await pauseImport(paused, "the worker is shutting down", db(), "worker");
    const orphan = await given({ status: "running", step: "tag" });

    await reconcileImports(boss, { db: db() });

    const events = await db()
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.type, "import.status"));
    const reasons = new Map(
      events.map((event) => [
        event.importId,
        (event.data as { reason?: string } | null)?.reason ?? null,
      ]),
    );
    expect(reasons.get(paused)).toBe("paused-by-shutdown");
    expect(reasons.get(orphan)).toBe("running-orphan");
  });

  /* ---- the periodic pass ------------------------------------------ */

  it("periodically, only a row that has stopped moving is a candidate", async () => {
    const fresh = await given({ status: "running", step: "match" });
    const stale = await given({ status: "running", step: "match" });
    await db()
      .update(schema.imports)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.imports.id, stale));

    const report = await reconcileImports(boss, { db: db(), trigger: "periodic" });

    // The import this very worker is running was updated a moment ago, so the sweep it shares
    // a process with cannot steal it. Only the one nobody has touched for an hour moves.
    expect(report.resumed).toBe(1);
    expect(await messagesFor(stale)).toHaveLength(1);
    expect(await messagesFor(fresh)).toEqual([]);
  });

  it("periodically, an import that already holds a live job is left alone", async () => {
    const stale = await given({ status: "running", step: "match" });
    await db()
      .update(schema.imports)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.imports.id, stale));
    await queues.enqueueImportStep(boss, { importId: stale, reason: "already queued" });

    const report = await reconcileImports(boss, { db: db(), trigger: "periodic" });

    expect(report.resumed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(await messagesFor(stale)).toHaveLength(1);
  });
});
