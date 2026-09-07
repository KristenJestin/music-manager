/**
 * The owner's D5, as a chronology.
 *
 * Until decision 147 an import ran its steps over the *album*: every track downloaded, then
 * every track fingerprinted, then every track tagged, then every track filed. The machine sat
 * idle for the whole of the download and the network sat idle for the whole of the rest, and
 * on a fourteen-track record that is minutes.
 *
 * Two claims are asserted here, and both are read off `job_events`' own sequence rather than a
 * wall clock, so the test cannot flake on a slow container:
 *
 *  1. **The steps overlap.** Some track's download *starts* before an earlier track has
 *     finished being filed. That is the definition of pipelining, and it is exactly what the
 *     owner asked to see proven.
 *  2. **Nothing is downloaded twice.** The toolbox client is instrumented, and `POST /download`
 *     is called once per track that had no file — never once more, whatever the chaining does.
 *
 * A third, quieter claim rides along: the album still ends `done`, having been through
 * `verify`, with every track filed. Pipelining that loses a track is not pipelining.
 *
 * The download is slowed down on purpose (`SLOW_DOWNLOAD_MS`). In fixtures mode a "download"
 * is the copy of a five-second Opus sample and the jitter is zero, so fourteen of them finish
 * inside a second — faster than pg-boss's one-second poll, which would make an overlap
 * unobservable for a reason that has nothing to do with the code under test. The delay is
 * added in *this file*, around the client, and changes nothing about the orchestration.
 *
 * Needs the stack, in fixtures mode, like its two neighbours:
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-pipetest");
const LIBRARY_CONTAINER = "/library/.mm-pipetest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/** A database of this file's own: vitest runs files in parallel, and a stack is not shared. */
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_pipetest`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

/** How long one fixture download is made to take, so the overlap has room to happen. */
const SLOW_DOWNLOAD_MS = 600;

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
  console.log(`  (track pipelining tests skipped: ${unavailable})`);
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
const { and, asc, eq } = await import("drizzle-orm");
const imports = await import("./imports.ts");
const jobs = await import("./jobs/index.ts");
const toolboxClient = await import("#/server/toolbox/client.ts");
const worker = await import("#/worker/index.ts");

resetServerEnv();

/** The one album the offline cassettes cover: fifteen videos, fourteen tracks. */
const SOURCE = "fixture://discovery";

describe.skipIf(unavailable !== null)("per-track pipelining", () => {
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

  it("fingerprints, tags and files track N while track N+1 is still downloading", async () => {
    const created = await imports.createFromUrl(SOURCE, {
      autoConfirm: true,
      confirmedBy: "cli --yes",
    });
    const id = created.job.id;
    const outcome = await jobs.runImport(id, { stopBefore: "download" });
    expect(outcome.handOff, "the import should be waiting for the download queue").toBe("download");

    const mapped = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")));
    expect(mapped.length, "the fixture album should have several mapped tracks").toBeGreaterThan(3);

    /*
     * One counter and one delay, around the real client.
     *
     * The counter is the whole of "no double download": the chaining fires a `track.step`
     * message per finished file, and the one thing that must never do is send a track back to
     * `download`. The delay is explained at the top of the file.
     */
    type Downloader = { download: (options: never) => AsyncGenerator<never> };
    const client = toolboxClient.toolbox() as unknown as Downloader;
    const real = client.download;
    let downloads = 0;
    client.download = (options: never): AsyncGenerator<never> => {
      const inner = real.call(client, options);
      return (async function* slow(): AsyncGenerator<never> {
        await sleep(SLOW_DOWNLOAD_MS);
        // Counted on the **first event**, not on the call: a `409 LOCKED` throws before the
        // generator yields anything, and a wait for the single slot is a queue, not a
        // download (decision 122). The neighbouring suite shares this toolbox.
        let counted = false;
        for await (const event of inner) {
          if (!counted) {
            counted = true;
            downloads += 1;
          }
          yield event;
        }
      })();
    };

    const running = await worker.startWorker();
    try {
      await waitUntil(
        async () => await settled(id),
        "the import to reach a terminal state",
        300_000,
      );
    } finally {
      await running.stop();
      client.download = real;
    }

    /* ---- 1 · the album finished, through `verify` ---- */
    const [job] = await db().select().from(schema.imports).where(eq(schema.imports.id, id));
    expect(job?.status, `${JSON.stringify(job?.error)}`).toBe("done");
    expect(job?.step).toBe("verify");

    const tracks = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")));
    for (const track of tracks) {
      expect(["placed", "done", "skipped"], `${track.sourceTitle} is ${track.state}`).toContain(
        track.state,
      );
    }

    /* ---- 2 · no double download ---- */
    expect(downloads, "one download per track, and not one more").toBe(mapped.length);

    /* ---- 3 · the chronology: a download started before an earlier track was filed ---- */
    //
    // Read off `job_events.id`, which is a sequence: no clock, no tolerance, no flake.
    const journal = await db()
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.importId, id))
      .orderBy(asc(schema.jobEvents.id));

    const downloadStarted = new Map<string, number>();
    const placeFinished = new Map<string, number>();
    for (const event of journal) {
      const trackId = event.trackId;
      if (trackId === null) continue;
      if (event.step === "download" && event.type === "track.started") {
        if (!downloadStarted.has(trackId)) downloadStarted.set(trackId, Number(event.id));
      }
      if (event.step === "place" && event.type === "track.done") {
        placeFinished.set(trackId, Number(event.id));
      }
    }
    expect(downloadStarted.size, "every track should have opened a download").toBe(mapped.length);
    expect(placeFinished.size, "every track should have been filed").toBe(mapped.length);

    const overlaps = [...placeFinished].flatMap(([placedTrack, filedAt]) => {
      const startedAt = downloadStarted.get(placedTrack);
      if (startedAt === undefined) return [];
      return [...downloadStarted]
        .filter(([other, otherStart]) => other !== placedTrack && otherStart > startedAt)
        .filter(([, otherStart]) => otherStart < filedAt)
        .map(([other]) => `${other} started downloading before ${placedTrack} was filed`);
    });
    expect(
      overlaps.length,
      "no download overlapped an earlier track's placement — the pipeline is still serial",
    ).toBeGreaterThan(0);

    /* ---- 4 · and the downloads themselves never overlapped each other ---- */
    //
    // The single slot is not negotiable (docs/06-stack.md). One track's `track.done` at
    // `download` must come before the next track's `track.started` at `download`.
    const downloadLines = journal.filter(
      (event) =>
        event.step === "download" &&
        event.trackId !== null &&
        (event.type === "track.started" || event.type === "track.done"),
    );
    let open: string | null = null;
    for (const event of downloadLines) {
      if (event.type === "track.started") {
        expect(open, `two downloads at once: ${String(open)} and ${String(event.trackId)}`).toBe(
          null,
        );
        open = event.trackId;
      } else if (event.trackId === open) {
        open = null;
      }
    }
  }, 600_000);
});

/* ------------------------------------------------------------------ */

async function settled(importId: string): Promise<boolean> {
  const [row] = await db().select().from(schema.imports).where(eq(schema.imports.id, importId));
  return row !== undefined && ["done", "failed", "cancelled"].includes(row.status);
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
