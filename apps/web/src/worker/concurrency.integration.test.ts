/**
 * The two concurrency numbers of the worker, and the one that is not a number at all.
 *
 * `importStepConcurrency` and `localStepConcurrency` are settings: they are judgements about
 * one machine, and raising them is how a few hundred queued imports stop being prepared four
 * a minute. **The download slot is not a setting and must never become one.** `docs/06-stack.md`
 * states it as "one orchestrator", and it is enforced three times over: the `download` queue's
 * pg-boss policy is `singleton`, its consumer is registered with `localConcurrency: 1`, and the
 * toolbox answers `409 LOCKED` to a second caller.
 *
 * This file pins the first two of those three, because they are the two that live in
 * `worker/index.ts` next to the number that just became configurable:
 *
 *  1. whatever `importStepConcurrency` says — 8 here, the maximum the schema allows — the
 *     `download` consumer is still registered with `localConcurrency: 1`;
 *  2. the `download` queue is still declared `singleton`, and a consumer registered that way
 *     really does run one handler at a time, even with six messages waiting.
 *
 * (1) is a structural assertion, taken by recording every `boss.work` call the real
 * `startWorker` makes. (2) is behavioural, against a real pg-boss: the policy is pg-boss's
 * half of the promise and no comment of ours can stand in for it.
 *
 * Needs postgres, like its neighbour `reconcile.integration.test.ts`; skips itself without
 * one. It creates and drops a database of its own name, never one it did not create.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_conc`;
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
  console.log(`  (worker concurrency tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { setSettings } = await import("#/server/services/settings.ts");
const queues = await import("./queues.ts");

resetServerEnv();

type Boss = Awaited<ReturnType<typeof queues.createBoss>>;

/** `{ localConcurrency }` as `boss.work` received it, per queue. */
type WorkOptions = { localConcurrency?: number };

describe.skipIf(unavailable !== null)("the worker's concurrency", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();
  }, 180_000);

  afterAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.end();
  }, 60_000);

  it("keeps the download slot at one however high the preparation concurrency is set", async () => {
    // The maximum the setting allows, which is the value most likely to break the invariant.
    await setSettings(
      { importStepConcurrency: 8, localStepConcurrency: 8 },
      { db: db(), setBy: "test" },
    );

    const { PgBoss } = await import("pg-boss");
    const registered = new Map<string, WorkOptions>();
    const original = PgBoss.prototype.work;
    PgBoss.prototype.work = async function patched(
      this: Boss,
      name: string,
      ...rest: unknown[]
    ): Promise<string> {
      const options = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as
        WorkOptions | Record<string, never>;
      registered.set(name, options as WorkOptions);
      return await (original as (...args: unknown[]) => Promise<string>).call(this, name, ...rest);
    } as typeof PgBoss.prototype.work;

    const { startWorker } = await import("./index.ts");
    let worker: Awaited<ReturnType<typeof startWorker>> | null = null;
    try {
      worker = await startWorker();
    } finally {
      PgBoss.prototype.work = original;
      if (worker !== null) await worker.stop();
    }

    // The load-bearing line. A future edit that reads a setting here fails this test, which is
    // the point: "one orchestrator" is the invariant, not a preference.
    expect(registered.get(queues.QUEUES.download)?.localConcurrency).toBe(1);
    // …and the two that are meant to follow their settings really did.
    expect(registered.get(queues.QUEUES.importStep)?.localConcurrency).toBe(8);
    expect(registered.get(queues.QUEUES.trackStep)?.localConcurrency).toBe(8);
  }, 180_000);

  it("runs one download handler at a time with six messages waiting", async () => {
    const producer = queues.createBoss({ producer: true });
    await producer.start();
    await queues.ensureQueues(producer);

    // pg-boss's half of the promise, read from its own catalogue rather than from our comment.
    const policy = await producer.getQueue(queues.QUEUES.download);
    expect(policy?.policy).toBe("singleton");

    for (let index = 0; index < 6; index += 1) {
      await producer.send(
        queues.QUEUES.download,
        { importId: `imp_conc_${String(index)}` },
        { retryLimit: 0 },
      );
    }

    const consumer = queues.createBoss();
    await consumer.start();
    let inFlight = 0;
    let peak = 0;
    let handled = 0;
    await consumer.work(
      queues.QUEUES.download,
      { localConcurrency: 1, pollingIntervalSeconds: 1 },
      async (jobs: unknown[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Long enough that a second handler, if one were allowed, would overlap this one.
        await new Promise((done) => setTimeout(done, 150));
        handled += jobs.length;
        inFlight -= 1;
      },
    );

    const deadline = Date.now() + 60_000;
    while (handled < 6 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    await queues.stopBoss(consumer);
    await queues.stopBoss(producer);

    expect(handled).toBe(6);
    expect(peak).toBe(1);
  }, 180_000);
});
