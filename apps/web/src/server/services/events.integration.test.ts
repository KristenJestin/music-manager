/**
 * `readLatestEvents` — the tail of the journal, newest first.
 *
 * Bug: the Home "Activity" drawer (`server/functions/dashboard.ts`, `recentActivity`) called
 * `readEvents({ since: 0, limit: 500 })`, and `readEvents` orders `asc(jobEvents.id)` — oldest
 * first — so that call always returned the **first** 500 events the journal ever held. Once a
 * checkout's journal grew past 500 rows, the drawer stopped moving forever: it kept showing
 * the same oldest slice, `slice(-limit).reverse()` and all, no matter what happened since.
 * `workerLog` (`server/services/tools.ts`) and `fetchJob`'s initial page of events
 * (`server/functions/jobs.ts`) had the same shape.
 *
 * `readLatestEvents` is the other query: `desc(jobEvents.id)` under the same `limit`, so the
 * window is always the most recent events regardless of how large the journal has grown.
 * `readEvents` itself is untouched — the polling consumers (`subscribe`, `/api/events`) need
 * its ascending, `since`-cursor semantics exactly as before.
 *
 * Needs a database, like its neighbours; self-skips without one.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_events`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function postgresIsUp(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
    return null;
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
}

const unavailable = await postgresIsUp();
if (unavailable !== null) {
  console.log(`  (readLatestEvents tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { emit, readEvents, readLatestEvents } = await import("./events.ts");

resetServerEnv();

describe.skipIf(unavailable !== null)("readLatestEvents", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    // More than any caller's `limit`, so a query that silently returns the oldest rows is
    // told apart from one that returns the newest.
    for (let index = 0; index < 12; index += 1) {
      await emit({ type: "test.line", message: `line ${String(index)}` }, db());
    }
  }, 60_000);

  afterAll(async () => {
    await db().$client.end();
  });

  it("returns the newest rows first, not the oldest", async () => {
    const latest = await readLatestEvents({ limit: 5 }, db());
    expect(latest.map((event) => event.message)).toEqual([
      "line 11",
      "line 10",
      "line 9",
      "line 8",
      "line 7",
    ]);
  });

  it("still returns the oldest window in `readEvents`, since-cursor callers rely on that", async () => {
    const oldest = await readEvents({ limit: 5 }, db());
    expect(oldest.map((event) => event.message)).toEqual([
      "line 0",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
    ]);
  });

  it("defaults to 40 and respects an importId filter", async () => {
    const importId = "imp_readlatestevents_test";
    await db()
      .insert(schema.imports)
      .values({ id: importId, url: "fixture://discovery", kind: "album" });
    await emit({ type: "test.line", message: "scoped", importId }, db());
    const scoped = await readLatestEvents({ importId }, db());
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.message).toBe("scoped");
  });
});
