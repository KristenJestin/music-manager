/**
 * The position allocator against a real Postgres, because the rule is half a query.
 *
 * `positions.test.ts` proves the arithmetic. What cannot be proved without a database is the
 * part that actually went wrong on a production library: *what the album already holds*, read
 * at the moment of the write, with `coalesce(disc_number, 1)` meaning what the unique index
 * means by it — and what happens when the answer is stale by the time the row is inserted.
 *
 * The album under test is the one from the incident's shape: **1, 2, 4, 25, 26**, a hole and a
 * tail, five rows whose highest position is 26.
 *
 *   docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_positionstest`;
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
if (unavailable !== null) console.log(`  (position integration tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { newId } = await import("#/server/ids.ts");
const { eq } = await import("drizzle-orm");
const { freeAlbumPosition, insertLibraryTrack, isPositionCollision, positionsTaken } =
  await import("./positions.ts");

resetServerEnv();

const ALBUM = "alb_positionstest_0000000000";
const OTHER = "alb_positionstest_1111111111";

/** 1, 2, 4, 25, 26 — the hole and the tail, on the disc the index calls 1. */
const HOLE_AND_TAIL = [1, 2, 4, 25, 26] as const;

async function seedAlbum(albumId: string, folder: string): Promise<void> {
  await db()
    .insert(schema.libraryAlbums)
    .values({ id: albumId, albumArtist: "Skip the Use", title: "Can Be Late", folder });
}

/**
 * The album's rows, with **no disc number at all**.
 *
 * That is the production shape and the one that matters: the index groups by
 * `coalesce(disc_number, 1)`, so these five rows are on disc 1 without ever saying so, and an
 * allocator that filters on the column rather than on the coalesce sees an empty album.
 */
async function seedPositions(albumId: string, positions: readonly number[]): Promise<void> {
  for (const position of positions) {
    await db()
      .insert(schema.libraryTracks)
      .values({
        id: newId("libraryTrack"),
        albumId,
        title: `track ${String(position)}`,
        path: `${albumId}/${String(position)}.opus`,
        trackNumber: position,
        discNumber: null,
      });
  }
}

beforeAll(async () => {
  if (unavailable !== null) return;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const sql = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(sql), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
  await sql.end();
}, 120_000);

beforeEach(async () => {
  if (unavailable !== null) return;
  const sql = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(`truncate table library_tracks, library_albums restart identity cascade`);
  await sql.end();
});

/*
 * The test database is dropped on the way *in*, not on the way out.
 *
 * `db()` is a pooled client and the pool is still open when the suite ends, so a drop in
 * `afterAll` waits on connections nothing is going to close and times the hook out. Dropping
 * it at the start of the next run costs nothing and cannot hang — which is also what the
 * migration suites next door do. Only ever this exact name, never a pattern: other checkouts
 * run their own databases from the same family at the same time.
 */

describe.skipIf(unavailable !== null)("positionsTaken", () => {
  it("reads the disc the index means, so a null disc number is disc 1", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);

    // Asked for disc 1 and asked for "no disc": the same five rows both times.
    expect(
      [...(await positionsTaken(db(), { albumId: ALBUM, discNumber: 1 }))].sort((a, b) => a - b),
    ).toEqual([1, 2, 4, 25, 26]);
    expect(
      [...(await positionsTaken(db(), { albumId: ALBUM, discNumber: null }))].sort((a, b) => a - b),
    ).toEqual([1, 2, 4, 25, 26]);
    // Disc 2 is a different disc and holds nothing.
    expect(await positionsTaken(db(), { albumId: ALBUM, discNumber: 2 })).toEqual(new Set());
  }, 30_000);

  it("is scoped to one album", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedAlbum(OTHER, "Skip the Use/Can Be Late (2013)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);
    await seedPositions(OTHER, [7, 8]);

    expect(
      [...(await positionsTaken(db(), { albumId: OTHER, discNumber: null }))].sort((a, b) => a - b),
    ).toEqual([7, 8]);
  }, 30_000);

  it("does not count the row it is computing for: a row never collides with itself", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, [1, 2]);
    const [held] = await db()
      .select({ id: schema.libraryTracks.id })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.trackNumber, 2));

    const taken = await positionsTaken(db(), {
      albumId: ALBUM,
      discNumber: null,
      exceptTrackId: held?.id ?? null,
    });
    expect([...taken].sort((a, b) => a - b)).toEqual([1]);
  }, 30_000);
});

describe.skipIf(unavailable !== null)("freeAlbumPosition", () => {
  /** The assertion the incident asked for, against rows a database actually holds. */
  it("sends a taken position past the end of an album with a hole and a tail", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);

    // "Pil" claims 25, which the album's own "Pil" already holds. 26 is `Cup of Coffee`, so
    // past the end is 27 — and a `count + 1` allocator would have said 6.
    expect(await freeAlbumPosition(db(), { albumId: ALBUM, discNumber: null, candidate: 25 })).toBe(
      27,
    );
    expect(await freeAlbumPosition(db(), { albumId: ALBUM, discNumber: null, candidate: 26 })).toBe(
      27,
    );
    expect(
      await freeAlbumPosition(db(), { albumId: ALBUM, discNumber: null, candidate: null }),
    ).toBe(27);
    // The hole is still a free slot for the track whose number it is.
    expect(await freeAlbumPosition(db(), { albumId: ALBUM, discNumber: null, candidate: 3 })).toBe(
      3,
    );
  }, 30_000);

  it("sees a row inserted a moment ago, rather than a count taken before it", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);

    const first = await freeAlbumPosition(db(), {
      albumId: ALBUM,
      discNumber: null,
      candidate: 26,
    });
    await seedPositions(ALBUM, [first]);
    const second = await freeAlbumPosition(db(), {
      albumId: ALBUM,
      discNumber: null,
      candidate: 26,
    });

    expect(first).toBe(27);
    expect(second).toBe(28);
  }, 30_000);

  it("honours what a run has promised but not yet written", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);

    // A dry run writes nothing, so the database cannot be the record of what it handed out.
    expect(
      await freeAlbumPosition(db(), {
        albumId: ALBUM,
        discNumber: null,
        candidate: 26,
        reserved: new Set([27, 28]),
      }),
    ).toBe(29);
  }, 30_000);
});

describe.skipIf(unavailable !== null)("insertLibraryTrack", () => {
  /**
   * The race the allocator cannot win on its own.
   *
   * The position is read, then the row is built, then it is written; another writer fits in
   * between. Simulated here the only honest way — by taking the slot after the allocator has
   * answered and before the insert runs — because that is precisely what happened.
   */
  it("retries past the end when the slot is taken between the read and the write", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, HOLE_AND_TAIL);

    const position = await freeAlbumPosition(db(), {
      albumId: ALBUM,
      discNumber: null,
      candidate: 26,
    });
    expect(position).toBe(27);
    // Somebody else takes 27 while we were building the row.
    await seedPositions(ALBUM, [27]);

    const said: string[] = [];
    const written = await insertLibraryTrack(
      db(),
      {
        id: newId("libraryTrack"),
        albumId: ALBUM,
        title: "Habits",
        path: "Skip the Use/Can Be Late (2012)/habits.opus",
        trackNumber: position,
        discNumber: null,
      },
      {
        say: (message) => {
          said.push(message);
        },
      },
    );

    expect(written.trackNumber).toBe(28);
    expect(written.attempts).toBe(2);
    // And it is not silent about having moved the track.
    expect(said.join(" ")).toMatch(/retrying at 28/);
    const rows = await db()
      .select({ trackNumber: schema.libraryTracks.trackNumber })
      .from(schema.libraryTracks);
    expect(rows.map((row) => row.trackNumber).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 4, 25, 26, 27, 28,
    ]);
  }, 30_000);

  it("gives up on the track, not on the run, when the retries run out", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, [1]);

    const failure = await insertLibraryTrack(
      db(),
      {
        id: newId("libraryTrack"),
        albumId: ALBUM,
        title: "Habits",
        path: "Skip the Use/Can Be Late (2012)/habits.opus",
        trackNumber: 1,
        discNumber: null,
      },
      // Zero retries: one attempt, and the slot is held.
      { attempts: 0 },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as { code?: string } | null)?.code).toBe("POSITION_TAKEN");
    // Nothing half-written: the album still holds exactly what it did.
    expect(await db().select().from(schema.libraryTracks)).toHaveLength(1);
  }, 30_000);

  /**
   * A duplicate path is not a position problem, and retrying it would loop forever on a row
   * that can never be written. It has to come back out unchanged, for the caller to journal.
   */
  it("does not swallow a violation of any other constraint", async () => {
    await seedAlbum(ALBUM, "Skip the Use/Can Be Late (2012)");
    await seedPositions(ALBUM, [1]);

    const failure = await insertLibraryTrack(db(), {
      id: newId("libraryTrack"),
      albumId: ALBUM,
      title: "a second row on the first one's path",
      path: `${ALBUM}/1.opus`,
      trackNumber: 9,
      discNumber: null,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).not.toBeNull();
    expect(isPositionCollision(failure)).toBe(false);
    expect((failure as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      "library_tracks_path_idx",
    );
  }, 30_000);
});
