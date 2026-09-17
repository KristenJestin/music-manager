/**
 * The confirmation gate, against a real Postgres: the question it asks, and the answer that
 * was missing.
 *
 * `confirm` is the one deliberately blocking step, and an import parked on it was reachable
 * from `/api/v1`, MCP and `mm` and from nowhere in the browser. Three claims here, and each
 * one of them is a row somewhere rather than a rendering:
 *
 *  1. **blocking says so in the Inbox.** The step used to park the job and tell nobody, so the
 *     review queue — which reads `inbox_items` — could not show it. Only the watched-source
 *     branch ever raised an item;
 *  2. **the item is idempotent.** Re-running the step re-opens the same question rather than a
 *     second one, which matters a great deal on a job that is retried;
 *  3. **the decision is written and signed.** `confirmProposed` opens the gate, the step writes
 *     `decisions` with `kind: "release"` and `decidedBy: "console"` — never `user`, never
 *     `cli --yes (unsigned)` — and the item that was asking is answered rather than left open.
 *
 * Offline: no toolbox, no network, no files. The steps either side of `confirm` are never run.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_confirmgate`;
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
if (unavailable !== null) console.log(`  (confirm gate integration tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
/*
 * **Fixtures off, on purpose.**
 *
 * `confirmStep` treats fixtures mode as an automatic yes — the offline end-to-end run and the
 * demo have nobody to ask — so the blocking branch, which is the whole subject of this file,
 * is unreachable with `MM_FIXTURES=1`. That is also why the Playwright suite drives this
 * through a watched source, the one path that blocks in every mode.
 */
process.env["MM_FIXTURES"] = "0";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { createDatabase } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { confirmProposed } = await import("./confirm.ts");
const { listInbox } = await import("./inbox.ts");
const { runStep } = await import("./jobs/index.ts");

resetServerEnv();

/**
 * Two connections, not the client default of ten.
 *
 * The postgres this runs against is shared — one server, one database per checkout, several
 * agents at once — and a test file that opens a pool of ten for a handful of queries is how a
 * suite starts failing with "sorry, too many clients already" in whichever file happened to be
 * last.
 */
const database = createDatabase(TEST_URL, 2);

const IMPORT_ID = "imp_confirmgate";
const RELEASE = "0cbe4a8e-1111-4222-8333-444444444444";

beforeAll(async () => {
  if (unavailable !== null) return;

  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const client = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(client), { migrationsFolder: resolve(REPO_ROOT, "apps/web/drizzle") });
  await client.end();

  await database.insert(schema.imports).values({
    id: IMPORT_ID,
    url: "https://music.youtube.com/playlist?list=OLAK5uy_confirmgate",
    kind: "album",
    status: "running",
    step: "confirm",
    title: "Drive",
    artist: "Tiësto & Ava Max",
    releaseMbid: RELEASE,
    options: {},
  });
  await database.insert(schema.importTracks).values({
    id: "imt_confirmgate_1",
    importId: IMPORT_ID,
    position: 0,
    videoId: "vid_confirmgate",
    url: "https://www.youtube.com/watch?v=vid_confirmgate",
    sourceTitle: "Tiësto & Ava Max - The Motto",
    sourceDuration: 165,
    role: "mapped",
    trackPosition: 1,
    trackTitle: "The Motto",
    recordingMbid: "ce7465ed-1111-4222-8333-444444444444",
    confidence: 0.97,
    raw: {},
  });
}, 120_000);

describe.skipIf(unavailable !== null)("the confirmation gate", () => {
  it("raises an Inbox item when it blocks, so the review queue can see the import", async () => {
    const result = await runStep(IMPORT_ID, "confirm", { db: database });
    expect(result.status).toBe("blocked");
    expect(result.blockedAs).toBe("awaiting_confirm");

    const open = await listInbox({ importId: IMPORT_ID, status: "open" }, database);
    const item = open.find((row) => row.type === "awaiting_confirm");
    expect(item, "confirm blocked without asking anybody").toBeDefined();
    expect(item?.title).toContain("Drive");
    // Decision 002: the item carries the answer the algorithm would take.
    expect(item?.preselected).toMatchObject({ action: "confirm" });
    // And what the card renders the mapping from.
    expect(Array.isArray(item?.payload["tracks"])).toBe(true);
  });

  it("re-opens the same question when the step runs again, never a second one", async () => {
    await runStep(IMPORT_ID, "confirm", { db: database });
    const open = await listInbox({ importId: IMPORT_ID, status: "open" }, database);
    expect(open.filter((row) => row.type === "awaiting_confirm")).toHaveLength(1);
  });

  it("refuses to confirm an import that is not waiting for one", async () => {
    await expect(confirmProposed("imp_nothing_like_this", "console", database)).rejects.toThrow(
      /No import with id/,
    );
  });

  it("confirms from the Console, answers the item, and signs the decision", async () => {
    const { job, mapped } = await confirmProposed(IMPORT_ID, "console", database);
    expect(mapped).toBe(1);
    expect(job.options.autoConfirm).toBe(true);
    // `assertSigned`: the gate may not be opened anonymously.
    expect(job.options.confirmedBy).toBe("console");

    // The question is answered, so the review queue empties rather than keeping a card whose
    // import has already started.
    const stillOpen = await listInbox({ importId: IMPORT_ID, status: "open" }, database);
    expect(stillOpen.some((row) => row.type === "awaiting_confirm")).toBe(false);

    // Running the step now goes through, because the gate is open — and that is where the
    // `decisions` row is written, by the same code the wizard, the API and `--yes` go through.
    const result = await runStep(IMPORT_ID, "confirm", { db: database });
    expect(result.status).toBe("done");

    const [decision] = await database
      .select()
      .from(schema.decisions)
      .where(and(eq(schema.decisions.importId, IMPORT_ID), eq(schema.decisions.kind, "release")));

    expect(decision, "a confirmation that logs nothing is not a confirmation").toBeDefined();
    // Never `user` and never `cli --yes (unsigned)`: the audit trail has to be able to answer
    // "which of my albums did nobody look at?" with one query.
    expect(decision?.decidedBy).toBe("console");
    expect(decision?.subject).toBe(RELEASE);
    expect(decision?.choice).toMatchObject({ releaseMbid: RELEASE, tracks: 1 });
  });
});
