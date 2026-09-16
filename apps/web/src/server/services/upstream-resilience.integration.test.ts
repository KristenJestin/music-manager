/**
 * A source refuses; the import waits, and then succeeds. Against a real database.
 *
 * This is the incident, reproduced end to end and offline. `fixture://discovery?mb=503` is the
 * recorded outage this repository already owned for the wizard (decision 165); the `match`
 * step honours it too now, so the 503 arrives at the step machine as the *byte-for-byte* error
 * a real 503 produces — built by `integrations/http.ts` itself, not by a mock of it.
 *
 * What is asserted, in order:
 *
 *  1. a 503 puts the import in `waiting_upstream`, not `failed`, with a growing delay;
 *  2. the delay doubles, and the attempt counter is on the row where the Console reads it;
 *  3. when the source comes back, the import carries on — nobody pressed anything;
 *  4. a 404 fails immediately, because waiting will not invent the release;
 *  5. the cap is real: past it the job is terminal, under a code that says *upstream*;
 *  6. the bulk requeue picks up the ones a source killed, leaves the broken one alone, and
 *     does nothing the second time.
 *
 * It skips itself when the stack is down, like every other integration test here.
 */
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-upstream");
const LIBRARY_CONTAINER = "/library/.mm-upstream";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_upstream`;
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
  console.log(`  (upstream-resilience tests skipped: ${unavailable})`);
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
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const settings = await import("./settings.ts");
const { resetOutages } = await import("./matching.gateway.ts");
const { holdOf } = await import("./jobs/upstream.ts");

resetServerEnv();

/** Short enough that a whole ladder costs milliseconds; the arithmetic is unit-tested. */
const BASE_MS = 40;
const MAX_MS = 400;

/** A fresh scenario key each time: the recorded outage counts refusals per URL. */
let scenario = 0;
const outageUrl = (options: { status?: number; times?: number } = {}): string => {
  scenario += 1;
  const status = options.status ?? 503;
  const times = options.times ?? 1;
  return `fixture://discovery?mb=${String(status)}&mbtimes=${String(times)}&case=up-${String(scenario)}`;
};

/** Create an import and run it until it stops. `--yes` so `confirm` is not the thing blocking. */
async function start(url: string): Promise<string> {
  const created = await imports.createFromUrl(url, { autoConfirm: true, confirmedBy: "test" });
  return created.job.id;
}

async function row(id: string) {
  const [found] = await db().select().from(schema.imports).where(eq(schema.imports.id, id));
  if (found === undefined) throw new Error(`no import ${id}`);
  return found;
}

describe.skipIf(unavailable !== null)("a busy source is a wait, not a failure", () => {
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

    await settings.setSetting("upstreamBackoffBaseMs", BASE_MS, { setBy: "test" });
    await settings.setSetting("upstreamBackoffMaxMs", MAX_MS, { setBy: "test" });
    await settings.setSetting("upstreamMaxAttempts", 6, { setBy: "test" });
  }, 120_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetOutages();
  });

  /* ---------------------------------------------------------------- */

  it("parks the import instead of failing it, and says who and when", async () => {
    const id = await start(outageUrl({ times: 1 }));
    const outcome = await jobs.runImport(id);

    // The claim the whole branch is about.
    expect(outcome.status).toBe("waiting_upstream");
    expect(outcome.hold).not.toBeNull();
    expect(outcome.hold?.attempt).toBe(1);
    expect(outcome.hold?.source).toBe("musicbrainz");
    expect(outcome.hold?.delayMs).toBe(BASE_MS);

    const job = await row(id);
    expect(job.status).toBe("waiting_upstream");
    expect(job.step).toBe("match");
    // Where the Console and the API read it from.
    expect(job.upstreamAttempts).toBe(1);
    expect(job.nextAttemptAt).not.toBeNull();
    expect(job.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() - 1000);
    // It is not finished, so it must not look finished.
    expect(job.finishedAt).toBeNull();
    // The error is kept — it is the sentence naming the source — but the status is what stops
    // the Console painting the row red.
    expect(job.error?.code).toBe("SOURCE_UNAVAILABLE");
    expect(job.error?.status).toBe(503);
  }, 60_000);

  it("grows the delay on each refusal and then lets the import through", async () => {
    // Three refusals, then the cassette answers: the fake source of the acceptance criteria.
    const id = await start(outageUrl({ times: 3 }));
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await jobs.runImport(id);
      expect(outcome.status, `attempt ${String(attempt)} should wait, not fail`).toBe(
        "waiting_upstream",
      );
      expect(outcome.hold?.attempt).toBe(attempt);
      delays.push(outcome.hold?.delayMs ?? 0);
      expect((await row(id)).upstreamAttempts).toBe(attempt);
    }

    // Growing, and one doubling per attempt — the property, not the constants.
    expect(delays).toEqual([BASE_MS, BASE_MS * 2, BASE_MS * 4]);

    // The fourth run finds the source answering. Nobody pressed anything: this is the same
    // call the delayed queue message would have made.
    const recovered = await jobs.runImport(id);
    expect(recovered.hold).toBeNull();
    expect(recovered.status).not.toBe("failed");
    expect(recovered.status).not.toBe("waiting_upstream");

    const job = await row(id);
    // Progress clears the budget: a job that waited three times and then moved on starts from
    // zero the next time a source has a bad minute.
    expect(job.upstreamAttempts).toBe(0);
    expect(job.nextAttemptAt).toBeNull();
    expect(job.releaseMbid).not.toBeNull();
  }, 120_000);

  it("fails immediately on a 404, because waiting will not invent the release", async () => {
    const id = await start(outageUrl({ status: 404, times: 99 }));
    const outcome = await jobs.runImport(id);

    expect(outcome.status).toBe("failed");
    expect(outcome.hold).toBeNull();

    const job = await row(id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("SOURCE_NOT_FOUND");
    // Not one attempt spent: a defect must not consume the upstream budget at all.
    expect(job.upstreamAttempts).toBe(0);
    expect(job.nextAttemptAt).toBeNull();
    expect(job.finishedAt).not.toBeNull();
  }, 60_000);

  it("gives up after the cap, under a code that says the source and not the file", async () => {
    await settings.setSetting("upstreamMaxAttempts", 2, { setBy: "test" });
    try {
      const id = await start(outageUrl({ times: 99 }));
      expect((await jobs.runImport(id)).status).toBe("waiting_upstream");
      expect((await jobs.runImport(id)).status).toBe("waiting_upstream");

      const third = await jobs.runImport(id);
      expect(third.status).toBe("failed");
      expect(third.hold).toBeNull();

      const job = await row(id);
      expect(job.status).toBe("failed");
      expect(job.error?.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(job.error?.message).toContain("musicbrainz");
      expect(job.error?.message).toContain("Nothing is wrong with the files");
      // The 503 that ended it survives, for whoever has to read the row later.
      expect((job.error?.details?.["lastError"] as { code?: string } | undefined)?.code).toBe(
        "SOURCE_UNAVAILABLE",
      );
      expect(job.upstreamAttempts).toBe(2);
    } finally {
      await settings.setSetting("upstreamMaxAttempts", 6, { setBy: "test" });
    }
  }, 120_000);

  it("puts the hold on the step result, which is how the worker learns to wait", async () => {
    // The worker has the only pg-boss handle, so the delay has to travel back to it. It rides
    // on `job_steps.result`, which already reaches the journal and `mm job`.
    const id = await start(outageUrl({ times: 1 }));
    await jobs.runImport(id);

    const [step] = await db()
      .select()
      .from(schema.jobSteps)
      .where(and(eq(schema.jobSteps.importId, id), eq(schema.jobSteps.step, "match")));
    const hold = holdOf(step?.result);
    expect(hold?.delayMs).toBe(BASE_MS);
    expect(hold?.source).toBe("musicbrainz");
    expect(hold?.maxAttempts).toBe(6);
  }, 60_000);
});

describe.skipIf(unavailable !== null)("requeueing the ones a source killed", () => {
  beforeEach(() => {
    resetOutages();
  });

  it("selects the source failures, leaves the broken import alone, and is idempotent", async () => {
    // The historical shape, which is the point: these rows were written before
    // `UPSTREAM_UNAVAILABLE` existed. `SOURCE_UNAVAILABLE` with `status: 503` is what the 45
    // actually carry, and `classifyFailure` is what recognises them.
    await settings.setSetting("upstreamMaxAttempts", 0, { setBy: "test" });
    let killed: string;
    let broken: string;
    try {
      killed = await start(outageUrl({ times: 99 }));
      expect((await jobs.runImport(killed)).status).toBe("failed");
      broken = await start(outageUrl({ status: 404, times: 99 }));
      expect((await jobs.runImport(broken)).status).toBe("failed");
    } finally {
      await settings.setSetting("upstreamMaxAttempts", 6, { setBy: "test" });
    }

    const found = await jobs.upstreamFailures(db());
    const ids = found.map((failure) => failure.id);
    expect(ids).toContain(killed);
    expect(ids, "a 404 is not an outage and must never be swept up with one").not.toContain(broken);

    const planned = await jobs.requeueUpstreamFailures({}, db());
    expect(planned.map((job) => job.id)).toEqual(ids);
    // Back where it stopped, not back to `resolve`: whatever came down is still on disk.
    expect(planned.every((job) => job.restartAt === "match")).toBe(true);

    const requeued = await row(killed);
    expect(requeued.status).toBe("running");
    expect(requeued.error).toBeNull();
    // A fresh ladder. Inheriting an exhausted one would make the retry one attempt long.
    expect(requeued.upstreamAttempts).toBe(0);
    expect(requeued.nextAttemptAt).toBeNull();

    // Idempotent: they are no longer `failed`, so a second sweep finds nothing.
    expect(await jobs.requeueUpstreamFailures({}, db())).toEqual([]);
    // And the genuinely broken one is still sitting there, waiting for a human.
    expect((await row(broken)).status).toBe("failed");
  }, 120_000);

  it("lists without touching anything when asked to dry-run", async () => {
    await settings.setSetting("upstreamMaxAttempts", 0, { setBy: "test" });
    let killed: string;
    try {
      killed = await start(outageUrl({ times: 99 }));
      expect((await jobs.runImport(killed)).status).toBe("failed");
    } finally {
      await settings.setSetting("upstreamMaxAttempts", 6, { setBy: "test" });
    }

    const planned = await jobs.requeueUpstreamFailures({ dryRun: true }, db());
    expect(planned.map((job) => job.id)).toContain(killed);
    expect((await row(killed)).status).toBe("failed");

    // Cleaned up so the suite's order cannot matter to whoever adds the next test.
    await jobs.requeueUpstreamFailures({}, db());
  }, 120_000);
});
