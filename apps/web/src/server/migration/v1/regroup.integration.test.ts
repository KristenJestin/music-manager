/**
 * The regrouping of an already-migrated library, against a real Postgres.
 *
 * This is the reproduction of the incident reported on a production library: after the album
 * grouping became "one album per v1 release MBID", re-running `mm migrate v1` made tracks
 * disappear from the Console. The chain is three links long and every one of them is a fact
 * about *these* tables, so none of it can be shown without a database:
 *
 *  1. a v1 row whose release cannot be resolved keeps **v1's own track number** — the seed
 *     patch sets `tracknumber` from `Songs.TrackNumber` (`seed.ts`) and nothing outranks it
 *     when `documents.build` never found the track on the release;
 *  2. v1 filed one release into several folders, each of them numbered from 1, so once the
 *     regrouping puts them all in one `library_albums` row two tracks claim position 1;
 *  3. `library_tracks_album_position_idx` is unique, so the second one is rejected — and
 *     because `migrateAlbum` catches a track failure rather than failing the album, the track
 *     is silently left behind in an album row the regrouping is dissolving.
 *
 * No toolbox: the tag write is the only call `migrateTrack` makes to it, and what has to be
 * true here is what ends up in `library_tracks`. The files are real, because the folder
 * consolidation stats them.
 *
 *   docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecuteContext } from "./execute.ts";
import type { V1Dataset, V1Song } from "./schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-regrouptest");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_regrouptest`;
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
if (unavailable !== null) console.log(`  (regroup integration tests skipped: ${unavailable})`);

// Before anything reads it: `serverEnv()` is lazy but cached.
process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = "/library/.mm-regrouptest";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const { pathMap } = await import("#/server/paths.ts");
const { defaults } = await import("#/server/services/settings.ts");
const { migrateAlbum } = await import("./execute.ts");
const { planFrom } = await import("./inventory.ts");
const { mergeDuplicateTracks } = await import("#/server/services/scan.ts");
const { newId } = await import("#/server/ids.ts");

resetServerEnv();

/* ------------------------------------------------------------------ */
/* the v1 installation this reproduces                                 */
/* ------------------------------------------------------------------ */

/**
 * One release, deliberately absent from every cache.
 *
 * `documents.build` runs offline here, so it fails for this release exactly as it does for a
 * production row whose recording is not on the release v1 chose — and the document falls back
 * to the v1 seed, which is the state that carries v1's track number forward.
 */
const RELEASE = "11111111-2222-3333-4444-555555555555";

/** The folder v1 filed the majority in, and the one it filed the minority in. */
const MAJORITY = "Various Artists/The Last of Us Part II (2020)";
const MINORITY = "Gustavo Santaolalla/The Last of Us Part II (2021)";

interface Row {
  readonly id: number;
  readonly folder: string;
  readonly albumArtist: string;
  readonly year: number;
  readonly track: number;
  readonly title: string;
}

/**
 * Seven rows of one release over two v1 folders, both numbered from 1.
 *
 * That is not a contrived shape: v1 matched each song against MusicBrainz on its own, so the
 * album artist and the year of one release routinely disagreed row by row, and v1 files by
 * `AlbumArtist/Album (Year)`. The track numbers are v1's own and therefore restart in each
 * folder — which is precisely what collides once the release becomes one album.
 */
const ROWS: readonly Row[] = [
  { id: 1, folder: MAJORITY, albumArtist: "Various Artists", year: 2020, track: 1, title: "Beyond Desolation" },
  { id: 2, folder: MAJORITY, albumArtist: "Various Artists", year: 2020, track: 2, title: "The Cycle of Violence" },
  { id: 3, folder: MAJORITY, albumArtist: "Various Artists", year: 2020, track: 3, title: "Eye for an Eye" },
  { id: 4, folder: MAJORITY, albumArtist: "Various Artists", year: 2020, track: 4, title: "Unbroken" },
  { id: 5, folder: MINORITY, albumArtist: "Gustavo Santaolalla", year: 2021, track: 1, title: "Through the Valley" },
  { id: 6, folder: MINORITY, albumArtist: "Gustavo Santaolalla", year: 2021, track: 2, title: "Longing" },
  { id: 7, folder: MINORITY, albumArtist: "Gustavo Santaolalla", year: 2021, track: 3, title: "American Venom" },
];

function pathOf(row: Row): string {
  return `${row.folder}/${String(row.track).padStart(2, "0")} - ${row.title}.opus`;
}

function song(row: Row): V1Song {
  return {
    id: row.id,
    sourceUrl: `https://www.youtube.com/watch?v=tlou2${String(row.id).padStart(6, "0")}`,
    sourceUrlParent: "https://www.youtube.com/playlist?list=OLAK5uy_tlou2",
    platform: "YouTube",
    sourceId: `tlou2${String(row.id).padStart(6, "0")}`,
    sourceIdParent: "OLAK5uy_tlou2",
    sourceTitle: `${row.albumArtist} - ${row.title}`,
    sourceDescription: null,
    title: row.title,
    subtitle: null,
    artist: "Gustavo Santaolalla",
    performers: ["Gustavo Santaolalla"],
    album: "The Last of Us Part II",
    isrc: null,
    albumArtists: [row.albumArtist],
    year: row.year,
    trackNumber: row.track,
    trackCount: 7,
    discNumber: 1,
    discCount: 1,
    publisher: null,
    genres: ["Soundtrack"],
    duration: 180_000,
    downloadStatus: "Present",
    finalFilePath: pathOf(row),
    lastAttempt: null,
    errorMessage: null,
    // No recording MBID anywhere: neither the column, nor a force, nor the file tags. That is
    // the ordinary state of a v1 row whose lookup only ever resolved the release.
    musicBrainzRecordingId: null,
    musicBrainzReleaseId: RELEASE,
    musicBrainzReleaseGroupId: null,
    musicBrainzArtistId: null,
    musicBrainzAlbumArtistId: null,
    musicBrainzReleaseStatus: null,
    musicBrainzReleaseCountry: null,
    musicBrainzForced: false,
    musicBrainzRecordingIdForce: null,
    musicBrainzReleaseIdForce: null,
    forceSongMetadata: false,
    forceSourceMetadata: false,
    createdAt: null,
    updatedAt: new Date("2025-04-18T09:32:00Z"),
  };
}

const DATASET: V1Dataset = {
  songs: ROWS.map(song),
  forces: new Map(),
  playlists: [],
  playlistSongs: [],
};

const FILES = ROWS.map((row) => ({
  path: pathOf(row),
  tags: {
    TITLE: row.title,
    ALBUM: "The Last of Us Part II",
    ALBUMARTIST: row.albumArtist,
    TRACKNUMBER: String(row.track),
    MUSICBRAINZ_ALBUMID: RELEASE,
    COMMENT: `Source: https://www.youtube.com/watch?v=tlou2${String(row.id).padStart(6, "0")}`,
  },
  sizeBytes: 1024,
  durationSeconds: 180,
}));

/* ------------------------------------------------------------------ */
/* the harness                                                         */
/* ------------------------------------------------------------------ */

const PATHS = pathMap({ host: LIBRARY_HOST, container: "/library/.mm-regrouptest" });

/**
 * The toolbox, reduced to the one call `migrateTrack` makes.
 *
 * `ToolboxClient` is a class with two dozen methods and this test exercises none of them but
 * `tag`; the cast is what buys a suite that runs without a container, and every setting that
 * would reach for another method (artwork, sidecars, ReplayGain) is off below.
 */
const TOOLBOX = {
  tag: async () => ({ ok: true, written: [], readback: {} }),
} as unknown as Parameters<typeof migrateAlbum>[0]["toolbox"];

function settings(): ReturnType<typeof defaults> {
  return {
    ...defaults(),
    replayGain: false,
    embedArtwork: false,
    writeCover: false,
    writeArtistImage: false,
    writeLyricsSidecar: false,
  };
}

function context(): ExecuteContext {
  return {
    db: db(),
    toolbox: TOOLBOX,
    settings: settings(),
    paths: PATHS,
    runId: newId("migrationRun"),
    renameToTemplate: false,
    keepFolders: false,
    offline: true,
    now: new Date("2026-09-15T00:00:00.000Z"),
    say: async () => {},
    count: () => {},
  };
}

/** Migrate every album of a plan, the way `run.ts` does, and report what failed. */
async function migrateAll(groupBy: "tags" | "release"): Promise<string[]> {
  const plan = planFrom(DATASET, FILES, { groupBy });
  const failures: string[] = [];
  for (const album of plan.albums) {
    const outcome = await migrateAlbum(context(), album);
    for (const failure of outcome.failures) failures.push(failure.message);
  }
  return failures;
}

/** Every library row, by title, with the album it sits in and the position it claims. */
async function libraryRows(): Promise<
  { title: string; albumId: string | null; trackNumber: number | null; path: string }[]
> {
  const rows = await db()
    .select({
      title: schema.libraryTracks.title,
      albumId: schema.libraryTracks.albumId,
      trackNumber: schema.libraryTracks.trackNumber,
      path: schema.libraryTracks.path,
    })
    .from(schema.libraryTracks);
  return rows.sort((left, right) => left.title.localeCompare(right.title));
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
  // Every table the migration writes, emptied — `beforeEach` rather than one shared fixture,
  // because the point of the suite is what a *second* run does to the rows of a first one.
  const sql = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(
    `truncate table library_tracks, library_albums, metadata_documents, import_tracks, imports,
     inbox_items, library_scans restart identity cascade`,
  );
  await sql.end();

  rmSync(LIBRARY_HOST, { recursive: true, force: true });
  for (const row of ROWS) {
    const full = join(LIBRARY_HOST, pathOf(row));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `not really audio: ${row.title}`);
  }
});

afterAll(() => {
  if (unavailable !== null) return;
  rmSync(LIBRARY_HOST, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* the tests                                                           */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("regrouping an already-migrated library", () => {
  it("files one v1 release into two albums when it groups by tags — the state before the incident", async () => {
    const failures = await migrateAll("tags");
    expect(failures).toEqual([]);

    const rows = await libraryRows();
    expect(rows).toHaveLength(ROWS.length);
    expect(new Set(rows.map((row) => row.albumId)).size).toBe(2);
  }, 60_000);

  it("keeps every track when the release regrouping pulls both folders into one album", async () => {
    await migrateAll("tags");
    const before = await libraryRows();
    expect(before).toHaveLength(ROWS.length);

    // The user's second run: the same v1 database, the release rule, nothing else changed.
    const failures = await migrateAll("release");

    // Red before the fix: three tracks of the minority folder claim positions 1, 2 and 3,
    // which the majority folder already holds, so `library_tracks_album_position_idx` rejects
    // them one by one and `migrateAlbum` swallows each as a track failure.
    expect(failures).toEqual([]);

    const after = await libraryRows();
    expect(after.map((row) => row.title)).toEqual(before.map((row) => row.title));
    // Every one of them in the single album the release now is.
    expect(new Set(after.map((row) => row.albumId)).size).toBe(1);
  }, 60_000);

  it("gives the regrouped album one position per track, never two tracks on one", async () => {
    await migrateAll("tags");
    await migrateAll("release");

    const rows = await libraryRows();
    const positions = rows
      .map((row) => row.trackNumber)
      .filter((value): value is number => value !== null);
    expect(new Set(positions).size).toBe(positions.length);
  }, 60_000);

  it("leaves `American Venom` in the library, on the album its release became", async () => {
    await migrateAll("tags");
    await migrateAll("release");

    const rows = await libraryRows();
    const venom = rows.find((row) => row.title === "American Venom");
    expect(venom).toBeDefined();
    const majority = rows.find((row) => row.title === "Beyond Desolation");
    expect(venom?.albumId).toBe(majority?.albumId);
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* the scan's duplicate merge                                          */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("the scan's duplicate merge", () => {
  /**
   * The suspect this investigation started from, and the reason it is not the culprit.
   *
   * `mergeDuplicateTracks` groups by `(album, position)` and deletes every row of a group but
   * one. The group it would need cannot exist: `library_tracks_album_position_idx` is unique
   * over exactly `(album_id, coalesce(disc_number, 1), track_number)`, so Postgres refuses the
   * second row before the scan ever sees it. Asserting that here is what keeps the two rules
   * from drifting apart — the day the index is relaxed, this test says so.
   */
  it("cannot be handed two rows of one album on one position, because the index forbids it", async () => {
    const albumId = newId("libraryAlbum");
    await db().insert(schema.libraryAlbums).values({
      id: albumId,
      albumArtist: "Gustavo Santaolalla",
      title: "The Last of Us Part II",
      folder: MAJORITY,
    });
    const base = { albumId, trackNumber: 1, discNumber: 1 };
    await db()
      .insert(schema.libraryTracks)
      .values({ id: newId("libraryTrack"), title: "Through the Valley", path: "a.opus", ...base });

    const rejection = await db()
      .insert(schema.libraryTracks)
      .values({ id: newId("libraryTrack"), title: "American Venom", path: "b.opus", ...base })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // Drizzle's message is the failed statement; the constraint is on the driver's own error,
    // which is where the name of the index actually is.
    expect(rejection).not.toBeNull();
    const cause = (rejection as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("library_tracks_album_position_idx");
  }, 30_000);

  /**
   * Two files, two songs, one position — the shape the merge would delete on if it ever got
   * the chance. It must not, and the evidence it has is the same evidence a person would use:
   * the titles differ and both files are on disk.
   */
  it("never deletes a row whose file is on disk and whose title differs from the survivor's", async () => {
    const albumId = newId("libraryAlbum");
    await db().insert(schema.libraryAlbums).values({
      id: albumId,
      albumArtist: "Gustavo Santaolalla",
      title: "The Last of Us Part II",
      folder: MAJORITY,
    });
    // `disc_number` null on one and 1 on the other is *not* a way around the index — it
    // coalesces — so the rows are given different positions and the album id is rewritten
    // underneath them, which is exactly the state a half-finished regrouping leaves.
    const first = newId("libraryTrack");
    const second = newId("libraryTrack");
    await db()
      .insert(schema.libraryTracks)
      .values([
        {
          id: first,
          albumId,
          title: "Through the Valley",
          path: `${MAJORITY}/01 - Through the Valley.opus`,
          trackNumber: 1,
          discNumber: 1,
        },
        {
          id: second,
          albumId,
          title: "American Venom",
          path: `${MINORITY}/03 - American Venom.opus`,
          trackNumber: 2,
          discNumber: 1,
        },
      ]);
    // Force the collision the index cannot hold: the merge is handed the rows directly.
    await db()
      .update(schema.libraryTracks)
      .set({ trackNumber: 1 })
      .where(eq(schema.libraryTracks.id, second))
      .catch(() => undefined);

    const merged = await mergeDuplicateTracks(
      db(),
      new Set([`${MAJORITY}/01 - Through the Valley.opus`, `${MINORITY}/03 - American Venom.opus`]),
    );
    expect(merged).toEqual([]);
    expect(await libraryRows()).toHaveLength(2);
  }, 30_000);
});
