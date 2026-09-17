/**
 * `bump`, asserted where it was broken: on pg-boss's own `job` table.
 *
 * `POST /imports/{id}/bump` announced "Move an import to the front of the queue" and moved
 * nothing. `bumpImport` incremented `imports.priority`, and **no enqueue path read that column**
 * — `services/queue.ts` did not mention priority at all, and `enqueueImportStep` takes one from
 * its caller, which only the resume sweep ever passed. So the message already sitting on
 * `import.step` kept the 0 it was sent with. Ten of the owner's "bumped" imports did not move,
 * and the journal said "Priority raised to 10" every time.
 *
 * Every assertion below therefore reads the **message**, not the row. The row is asserted too,
 * because it is what the next enqueue reads, but a test that stopped there is the test that
 * would have passed against the broken version.
 *
 * The second thing this file pins down is "exactly one message". `singletonKey` deduplicates
 * nothing on a `standard` queue in pg-boss 12 (the unique index on `singleton_key` is created
 * per policy, and `standard` gets none), and the Console used to call `enqueue` after every
 * bump — so a bump of an import that already had a message left two. `reprioritiseImport` asks
 * the ledger first, which is what makes the invariant true rather than hoped for.
 *
 * No toolbox: nothing here runs a step. It needs postgres, and skips itself without one.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_bump`;
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
  console.log(`  (bump tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { desc, eq } = await import("drizzle-orm");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { newId } = await import("#/server/ids.ts");
const { bumpImport } = await import("#/server/services/jobs/index.ts");
const queues = await import("#/worker/queues.ts");

resetServerEnv();

type Boss = Awaited<ReturnType<typeof queues.createBoss>>;

interface Message {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly state: string;
}

describe.skipIf(unavailable !== null)("bump moves the message, not only the row", () => {
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
      .values({ id, url: `fixture://${id}`, kind: "album", step: "match", ...row });
    return id;
  }

  /** Every unfinished message for one import, straight off pg-boss's table. */
  async function messagesFor(importId: string): Promise<Message[]> {
    const rows = await ledger<
      { id: string; name: string; priority: number; state: string }[]
    >`select id::text as id, name, priority, state::text as state
        from pgboss.job
       where state < 'completed'
         and data->>'importId' = ${importId}
       order by name`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      priority: Number(row.priority),
      state: row.state,
    }));
  }

  /** The newest journal line for an import — what a person reads after pressing Bump. */
  async function lastEvent(importId: string): Promise<string> {
    const [row] = await db()
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.importId, importId))
      .orderBy(desc(schema.jobEvents.id))
      .limit(1);
    return row?.message ?? "";
  }

  async function priorityOf(importId: string): Promise<number> {
    const [row] = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId))
      .limit(1);
    return row?.priority ?? 0;
  }

  /* ---------------------------------------------------------------- */

  /** The defect, in one test: the message that was already queued has to carry the new number. */
  it("re-prioritises the message the import already holds", async () => {
    const id = await given({ status: "pending", step: "resolve" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "test" });

    const before = await messagesFor(id);
    expect(before).toHaveLength(1);
    expect(before[0]?.priority).toBe(0);

    const result = await bumpImport(id, 10, db());

    expect(result.priority).toBe(10);
    expect(result.queue.action).toBe("reprioritised");
    expect(result.queue.updated).toBe(1);
    expect(result.queue.queue).toBe(queues.QUEUES.importStep);

    const after = await messagesFor(id);
    // The message moved, in place: same id, new priority.
    expect(after).toHaveLength(1);
    expect(after[0]?.priority).toBe(10);
    expect(after[0]?.id).toBe(before[0]?.id);
    // And the row, which is what the next enqueue will read.
    expect(await priorityOf(id)).toBe(10);
  }, 60_000);

  it("bumps again from where it left off, message and row together", async () => {
    const id = await given({ status: "pending", step: "resolve" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "test" });

    await bumpImport(id, 10, db());
    const second = await bumpImport(id, 5, db());

    expect(second.priority).toBe(15);
    expect((await messagesFor(id))[0]?.priority).toBe(15);
  }, 60_000);

  it("sends exactly one message when the import is queueable and holds none", async () => {
    const id = await given({ status: "pending", step: "resolve" });
    expect(await messagesFor(id)).toHaveLength(0);

    const result = await bumpImport(id, 10, db());

    expect(result.queue.action).toBe("sent");
    expect(result.queue.messages).toBe(1);
    const after = await messagesFor(id);
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe(queues.QUEUES.importStep);
    expect(after[0]?.priority).toBe(10);
  }, 60_000);

  /*
   * The duplicate the old Console produced on every bump, and the proof of the premise: two
   * sends with the same `singletonKey` really are two rows on a `standard` queue.
   */
  it("collapses duplicate messages, so one import ends with exactly one", async () => {
    const id = await given({ status: "pending", step: "resolve" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "first" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "second" });
    expect(await messagesFor(id)).toHaveLength(2);

    const result = await bumpImport(id, 10, db());

    expect(result.queue.removed).toBe(1);
    expect(result.queue.messages).toBe(1);
    const after = await messagesFor(id);
    expect(after).toHaveLength(1);
    expect(after[0]?.priority).toBe(10);
  }, 60_000);

  /*
   * A message a worker is holding must not be edited or replaced: deleting a row out from under
   * a running handler is the boot-purge race of `worker/index.ts`. Bump says so instead.
   */
  it("leaves an active message alone, and says the worker already has it", async () => {
    const id = await given({ status: "running", step: "download" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "test" });
    await ledger`update pgboss.job set state = 'active'
                  where data->>'importId' = ${id}`;

    const result = await bumpImport(id, 10, db());

    expect(result.queue.action).toBe("running");
    expect(result.queue.updated).toBe(0);
    const after = await messagesFor(id);
    expect(after).toHaveLength(1);
    expect(after[0]?.state).toBe("active");
    // Untouched: pg-boss's own `update` only reaches `state < 'active'`, and so does this.
    expect(after[0]?.priority).toBe(0);
    // The row still moves — it is what the *next* message will be sent with.
    expect(await priorityOf(id)).toBe(10);
    expect(await lastEvent(id)).toMatch(/already running/i);
  }, 60_000);

  it("sends nothing for an import that has no business on a queue", async () => {
    const done = await given({ status: "done", step: "verify" });
    const byOwner = await given({ status: "paused", pausedBy: "user", step: "match" });

    for (const id of [done, byOwner]) {
      const result = await bumpImport(id, 10, db());
      expect(result.queue.action).toBe("none");
      expect(await messagesFor(id)).toHaveLength(0);
      expect(await priorityOf(id)).toBe(10);
    }
  }, 60_000);

  it("writes a journal line that says what it did to the queue", async () => {
    const id = await given({ status: "pending", step: "resolve" });
    await queues.enqueueImportStep(boss, { importId: id, reason: "test" });
    await bumpImport(id, 10, db());

    const message = await lastEvent(id);
    // "Priority raised to 10" on its own is exactly what the broken version printed.
    expect(message).toContain("Priority raised to 10");
    expect(message).toMatch(/re-prioritised/i);
    expect(message).toContain(queues.QUEUES.importStep);
  }, 60_000);
});
