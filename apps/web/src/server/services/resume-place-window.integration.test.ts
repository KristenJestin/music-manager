/**
 * The window `place` leaves between the toolbox's rename and the rows that record it.
 *
 * `/place` is a rename inside the container. The instant it returns, the file has left
 * `.mm-work/<import>/`; until the orchestrator writes `import_tracks.library_path` and the
 * `library_tracks` row, nothing in the database knows where it went. A worker that dies in
 * that window used to come back to a track that was neither "already downloaded" (no file in
 * the work directory) nor "already present" (no library row) — so `download` fetched it a
 * second time. That is the flake `e2e-fixture`'s scenario 1 reported about one run in five as
 * "no track was downloaded twice — 1 duplicate(s)", and a duplicate download is the one thing
 * this app is built never to do.
 *
 * The window is reproduced here without killing anything, and that is what makes the test
 * deterministic rather than one-in-five: the toolbox client's `place` is wrapped so that the
 * real move happens and the call *then* fails. The orchestrator therefore reaches exactly the
 * state a `SIGKILL` would have left — file moved, rows not written — on every run, and from a
 * direction that matters in production too, since a timeout or a dropped socket does not stop
 * the container finishing a rename it has already started.
 *
 * Then the import is resumed the way a restarted worker resumes one, from `download`, and the
 * two claims are read off the same places the E2E reads them: the number of `POST /download`
 * calls, and the album on disk.
 *
 * Needs the stack, in fixtures mode, like its neighbours:
 *   MM_TOOLBOX_FIXTURES=1 bun run stack:up
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-placewindow");
const LIBRARY_CONTAINER = "/library/.mm-placewindow";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/** A database of this file's own: vitest runs files in parallel, and a stack is not shared. */
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_placewindow`;
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
  console.log(`  (resume window tests skipped: ${unavailable})`);
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

resetServerEnv();

/** The one album the offline cassettes cover: fifteen videos, fourteen tracks. */
const SOURCE = "fixture://discovery";

describe.skipIf(unavailable !== null)("resume across place's rename window", () => {
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

  it("does not fetch a track whose file was filed but never recorded", async () => {
    const created = await imports.createFromUrl(SOURCE, {
      autoConfirm: true,
      confirmedBy: "cli --yes",
    });
    const id = created.job.id;
    await jobs.runImport(id, { stopBefore: "download" });

    const mapped = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")))
      .orderBy(asc(schema.importTracks.trackPosition));
    expect(mapped.length, "the fixture album should have several mapped tracks").toBeGreaterThan(3);

    type Instrumented = {
      download: (options: never) => AsyncGenerator<never>;
      place: (options: never) => Promise<unknown>;
    };
    const client = toolboxClient.toolbox() as unknown as Instrumented;
    const realDownload = client.download;
    const realPlace = client.place;

    /* One counter, around the real client: "downloaded twice" is counted from the calls. */
    let downloads = 0;
    client.download = (options: never): AsyncGenerator<never> => {
      const inner = realDownload.call(client, options);
      return (async function* counted(): AsyncGenerator<never> {
        // Counted on the first event, not on the call: a `409 LOCKED` throws before the
        // generator yields anything, and waiting for the single slot is a queue, not a
        // download.
        let seen = false;
        for await (const event of inner) {
          if (!seen) {
            seen = true;
            downloads += 1;
          }
          yield event;
        }
      })();
    };

    /* The window: the move happens, the call does not come back. */
    let crashed = false;
    client.place = async (options: never): Promise<unknown> => {
      const result = await realPlace.call(client, options);
      if (crashed) return result;
      crashed = true;
      throw new Error("the worker went away while /place was returning");
    };

    try {
      await jobs.runImport(id);
    } finally {
      client.place = realPlace;
    }
    expect(crashed, "the run should have gone through place at least once").toBe(true);

    const afterCrash = downloads;
    expect(afterCrash, "every track should have been fetched exactly once").toBe(mapped.length);

    /* ---- 1 · the state a killed worker is left in, asserted rather than assumed ---- */
    const [caught] = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.id, mapped[0]?.id ?? ""));
    expect(caught?.libraryPath, "place records where it is about to put the file").not.toBeNull();
    expect(
      existsSync(join(LIBRARY_HOST, caught?.libraryPath ?? "")),
      "and the container finished the rename regardless",
    ).toBe(true);
    expect(
      caught?.downloadPath === null ||
        !existsSync(join(LIBRARY_HOST, caught?.downloadPath ?? "nowhere")),
      "the work file is gone, so `already downloaded` cannot save this track",
    ).toBe(true);
    const rows = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.path, caught?.libraryPath ?? ""));
    expect(rows, "and the library row was never written, so neither can `already present`").toEqual(
      [],
    );

    /* ---- 2 · the resume: exactly what a restarted worker does ---- */
    await jobs.retryStep(id, "download");

    const [job] = await db().select().from(schema.imports).where(eq(schema.imports.id, id));
    expect(job?.status, JSON.stringify(job?.error)).toBe("done");

    expect(downloads, "the resume must not fetch a single track again").toBe(afterCrash);

    const journal = await db()
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.importId, id))
      .orderBy(asc(schema.jobEvents.id));
    const doubled = new Map<string, number>();
    for (const event of journal) {
      if (event.step !== "download" || event.type !== "track.done") continue;
      if (event.trackId === null) continue;
      doubled.set(event.trackId, (doubled.get(event.trackId) ?? 0) + 1);
    }
    expect(
      [...doubled].filter(([, times]) => times > 1),
      "no track was downloaded twice — the claim e2e-fixture makes",
    ).toEqual([]);

    /* The track caught in the window is spared for the new reason, not the old one. */
    const spared = journal.filter(
      (event) => event.trackId === caught?.id && event.type === "track.skipped",
    );
    expect(spared.map((event) => (event.data as { reason?: string }).reason)).toContain(
      "already present",
    );

    /* ---- 3 · and the album is whole, with one file per track and no orphan ---- */
    const tracks = await db()
      .select()
      .from(schema.importTracks)
      .where(and(eq(schema.importTracks.importId, id), eq(schema.importTracks.role, "mapped")));
    for (const track of tracks) {
      expect(["placed", "done"], `${track.sourceTitle} is ${track.state}`).toContain(track.state);
      expect(track.libraryPath, `${track.sourceTitle} has no library path`).not.toBeNull();
      const absolute = join(LIBRARY_HOST, track.libraryPath ?? "");
      expect(existsSync(absolute) && statSync(absolute).size > 0, absolute).toBe(true);
    }

    const opus = readdirSync(join(LIBRARY_HOST, "Daft Punk", "Discovery (2001)")).filter((name) =>
      name.endsWith(".opus"),
    );
    expect(opus.length, "one file per track, and not one more").toBe(mapped.length);

    // `place` re-ran over a track whose file had already moved. Its `library_tracks` row must
    // exist exactly once and carry the size of the file that is really there, not the
    // `downloaded_bytes` measured before `tag` and ReplayGain wrote to it.
    const filed = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.path, caught?.libraryPath ?? ""));
    expect(filed.length, "placing a track twice must leave one row").toBe(1);
    expect(filed[0]?.size).toBe(statSync(join(LIBRARY_HOST, caught?.libraryPath ?? "")).size);

    client.download = realDownload;
  }, 600_000);
});
