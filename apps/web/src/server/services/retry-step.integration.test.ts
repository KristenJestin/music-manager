/**
 * Retrying from a chosen step, and what choosing `match` has to throw away.
 *
 * `retryJob` has taken a step since P03 and the Console never sent one, so a finished album could
 * only be retried from its resume point — `verify` — and a re-match meant `mm retry --step match`
 * in a terminal. Fifteen of the owner's finished albums were in that state.
 *
 * The half worth an integration test is not "the step rows were rewound", which `rewindTo`
 * already guaranteed. It is **that a re-match really re-matches**: `matchStep` begins by reading
 * a supplied mapping out of `imports.options` and applying it verbatim, so a rewind that left it
 * there would re-apply the very mapping somebody asked to be rid of, and "Match again" would be a
 * button that spent a step and changed nothing. `forgetMapping` is what stops that, and this file
 * asserts every column it has to clear — a re-match that keeps half the old answer is worse than
 * one that keeps all of it, because it looks like it worked.
 *
 * It drives the **service** functions rather than the server function, for the same reason
 * `imports.bulk.integration.test.ts` does: the Console, the REST route and `mm retry` are three
 * doors into one room, and the room is what can be wrong.
 *
 * Needs the stack, in fixtures mode:
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-retrytest");
const LIBRARY_CONTAINER = "/library/.mm-retrytest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_retrytest`;
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
  console.log(`  (retry-step tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { and, eq } = await import("drizzle-orm");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("#/server/services/imports.ts");
const jobs = await import("#/server/services/jobs/index.ts");
const { confirmBest } = await import("./imports.bulk.ts");
const { forgetsMapping, retryOptionsFor } = await import("./retry-plan.ts");

resetServerEnv();

/** An import of the fixture album, matched and confirmed — the state a retry acts on. */
async function confirmedImport(): Promise<string> {
  const created = await imports.createFromUrl("fixture://discovery", { db: db() });
  await db()
    .update(schema.imports)
    .set({ status: "awaiting_review" })
    .where(eq(schema.imports.id, created.job.id));
  await confirmBest({ importId: created.job.id, confirmedBy: "test", db: db() });
  return created.job.id;
}

describe.skipIf(unavailable !== null)("retrying from a chosen step", () => {
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

  it("a confirmed import really is confirmed, before anything is retried", async () => {
    const id = await confirmedImport();
    const job = await imports.getImport(id, db());
    const options = job?.options as { mapping?: unknown; autoConfirm?: unknown };

    expect(options.mapping).toBeDefined();
    expect(options.autoConfirm).toBe(true);
    expect(job?.releaseMbid).not.toBeNull();
    const mapped = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")));
    expect(mapped.length).toBeGreaterThanOrEqual(13);
  }, 120_000);

  /* The defect, in one test: choosing `match` has to rewind *and* clear. */
  it("choosing `match` rewinds to match and discards the confirmed mapping", async () => {
    const id = await confirmedImport();
    expect(forgetsMapping("match")).toBe(true);

    await jobs.forgetMapping(id, db());
    await jobs.rewindTo(id, "match", db());

    const job = await imports.getImport(id, db());
    // Rewound: the head is `match` and the row is moving again.
    expect(job?.step).toBe("match");
    expect(job?.status).toBe("running");

    // Cleared: the supplied mapping `matchStep` would have re-applied is gone, and so is the
    // signature that would have waved the *new* mapping through under the old confirmation.
    const options = job?.options as Record<string, unknown>;
    expect(options["mapping"]).toBeUndefined();
    expect(options["releaseMbid"]).toBeUndefined();
    expect(options["autoConfirm"]).toBeUndefined();
    expect(options["confirmedBy"]).toBeUndefined();
    expect(job?.releaseMbid).toBeNull();

    // And nothing downstream can still read a recording id from the discarded release.
    const rows = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.role === "unmatched")).toBe(true);
    expect(rows.every((row) => row.recordingMbid === null)).toBe(true);
    expect(rows.every((row) => row.trackPosition === null)).toBe(true);
    expect(rows.every((row) => row.confidence === null)).toBe(true);

    // The steps from `match` on are pending again; `resolve` keeps what it found.
    const steps = await db().select().from(schema.jobSteps).where(eq(schema.jobSteps.importId, id));
    const byStep = new Map(steps.map((row) => [row.step, row.status]));
    expect(byStep.get("resolve")).toBe("done");
    expect(byStep.get("match")).toBe("pending");
  }, 120_000);

  it("closes the Inbox items the discarded mapping had raised", async () => {
    const id = await confirmedImport();
    // `fixture://discovery` is fifteen videos for fourteen tracks, so `match` raises one.
    const before = await db()
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.importId, id));
    expect(before.length).toBeGreaterThan(0);

    await jobs.forgetMapping(id, db());

    const after = await db()
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.importId, id), eq(schema.inboxItems.status, "open")));
    // A question about a mapping that no longer exists is not a question.
    expect(after.filter((item) => item.type === "extra_videos")).toHaveLength(0);
    expect(after.filter((item) => item.type === "uncovered_tracks")).toHaveLength(0);
  }, 120_000);

  /* The audit trail is not the answer; erasing it would be erasing history. */
  it("keeps the decisions rows: who confirmed what, and when, stays true", async () => {
    const id = await confirmedImport();
    await jobs.runStep(id, "confirm", { db: db() });
    const before = await db()
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.importId, id));
    expect(before.length).toBeGreaterThan(0);

    await jobs.forgetMapping(id, db());

    const after = await db()
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.importId, id));
    expect(after).toHaveLength(before.length);
  }, 120_000);

  /* A harmless step must keep the mapping, or every retry would cost a MusicBrainz round trip. */
  it("choosing `tag` keeps the mapping and rewinds only the tail", async () => {
    const id = await confirmedImport();
    expect(forgetsMapping("tag")).toBe(false);

    await jobs.rewindTo(id, "tag", db());

    const job = await imports.getImport(id, db());
    expect(job?.step).toBe("tag");
    expect((job?.options as { mapping?: unknown }).mapping).toBeDefined();
    expect(job?.releaseMbid).not.toBeNull();

    const mapped = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")));
    expect(mapped.length).toBeGreaterThanOrEqual(13);
  }, 120_000);

  /* The menu and the server read one list, so what is on offer is what will be accepted. */
  it("offers a confirmed import every step it has reached, and no more", async () => {
    const id = await confirmedImport();
    const job = await imports.getImport(id, db());
    const offered = retryOptionsFor({
      status: job?.status ?? "pending",
      step: job?.step ?? "resolve",
    }).map((option) => option.step);

    expect(offered).toContain("resolve");
    expect(offered).toContain("match");
    expect(offered).not.toContain("confirm");
    // It has not downloaded anything, so nothing past `download` is on the menu.
    expect(offered).not.toContain("place");
    expect(offered).not.toContain("verify");
  }, 120_000);
});
