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
const { documentFromTags, repairOrphans } = await import("#/server/services/repair.ts");
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

/** The recording MBID a stray row carries in the "re-point, do not duplicate" case below. */
const STRAY_RECORDING = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

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
  /**
   * `/probe`, answered from the fixture rather than from ffprobe.
   *
   * The files on disk here are text, because everything under test is a decision about rows;
   * what the repair needs from a file is its tag dictionary, and this is the one v1 wrote.
   */
  probe: async (path: string) => {
    const relative = path.replace("/library/.mm-regrouptest/", "");
    const row = ROWS.find((entry) => pathOf(entry) === relative);
    return {
      size: 1024,
      duration: 180,
      has_picture: true,
      tags:
        row === undefined
          ? {}
          : {
              TITLE: row.title,
              ALBUM: "The Last of Us Part II",
              ALBUMARTIST: row.albumArtist,
              ARTIST: "Gustavo Santaolalla",
              TRACKNUMBER: String(row.track),
              MUSICBRAINZ_ALBUMID: RELEASE,
              COMMENT: `Source: https://www.youtube.com/watch?v=tlou2${String(row.id).padStart(6, "0")}`,
            },
    };
  },
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
  // Two tests below drop it on purpose, to build a state only a database that predates the
  // constraint can hold. Put it back, verbatim from `drizzle/0009_heavy_layla_miller.sql`.
  await sql.unsafe(
    `create unique index if not exists library_tracks_album_position_idx
       on library_tracks (album_id, coalesce(disc_number, 1), track_number)
      where album_id is not null and track_number is not null`,
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
    // The index is dropped so the collision can be *built*, exactly as the MCP suite does for
    // the repair it tests: a database that predates the constraint is the only one that can
    // hold this state, and it is the one somebody upgrading arrives with.
    await db().$client`drop index library_tracks_album_position_idx`;
    await db()
      .insert(schema.libraryTracks)
      .values([
        {
          id: newId("libraryTrack"),
          albumId,
          title: "Through the Valley",
          path: `${MAJORITY}/01 - Through the Valley.opus`,
          trackNumber: 1,
          discNumber: 1,
          duration: 180,
        },
        {
          id: newId("libraryTrack"),
          albumId,
          title: "American Venom",
          path: `${MINORITY}/03 - American Venom.opus`,
          trackNumber: 1,
          discNumber: 1,
          duration: 240,
        },
      ]);

    const onDisk = new Set([
      `${MAJORITY}/01 - Through the Valley.opus`,
      `${MINORITY}/03 - American Venom.opus`,
    ]);
    const { merged, conflicts } = await mergeDuplicateTracks(db(), onDisk);

    expect(merged).toEqual([]);
    expect(await libraryRows()).toHaveLength(2);
    // And it is not silent about it: the group becomes a question, with both files named.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.on).toBe("position");
    expect(conflicts[0]?.rows.map((row) => row.title).sort()).toEqual([
      "American Venom",
      "Through the Valley",
    ]);
  }, 30_000);

  /**
   * The case the merge was written for, which must keep working: one file, two rows.
   *
   * A `pathTemplate` change renamed the file and inserted a second row; the first points at a
   * path that is not there any more. The titles agree, the ghost has no file, and the merge
   * deletes the ghost — journalling enough of it to put it back.
   */
  it("still merges the ghost a path template change left, and writes down what it deleted", async () => {
    const albumId = newId("libraryAlbum");
    await db().insert(schema.libraryAlbums).values({
      id: albumId,
      albumArtist: "Gustavo Santaolalla",
      title: "The Last of Us Part II",
      folder: MAJORITY,
    });
    await db().$client`drop index library_tracks_album_position_idx`;
    const ghost = newId("libraryTrack");
    const real = newId("libraryTrack");
    await db()
      .insert(schema.libraryTracks)
      .values([
        {
          id: ghost,
          albumId,
          title: "American Venom",
          path: `${MAJORITY}/old name.opus`,
          trackNumber: 3,
          discNumber: 1,
        },
        {
          id: real,
          albumId,
          title: "American Venom",
          path: `${MAJORITY}/03 - American Venom.opus`,
          trackNumber: 3,
          discNumber: 1,
        },
      ]);

    const { merged, conflicts } = await mergeDuplicateTracks(
      db(),
      new Set([`${MAJORITY}/03 - American Venom.opus`]),
    );

    expect(conflicts).toEqual([]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.keptId).toBe(real);
    expect(merged[0]?.removedId).toBe(ghost);
    expect(merged[0]?.why).toMatch(/not on disk/);
    // Everything needed to write the row back by hand, from the report alone.
    expect(merged[0]?.removedPath).toBe(`${MAJORITY}/old name.opus`);
    expect(merged[0]?.removedTitle).toBe("American Venom");
    expect(merged[0]?.removedAlbumId).toBe(albumId);
    expect(merged[0]?.removedTrackNumber).toBe(3);
    expect(merged[0]?.removedOnDisk).toBe(false);
    expect(await libraryRows()).toHaveLength(1);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* the repair                                                          */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("mm library repair-orphans", () => {
  /** The damage the incident left: the file is in the library, the row is not. */
  async function loseAmericanVenom(): Promise<string> {
    await migrateAll("tags");
    const [venom] = await db()
      .select({ id: schema.libraryTracks.id, path: schema.libraryTracks.path })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.title, "American Venom"));
    if (venom === undefined) throw new Error("the fixture did not migrate American Venom");
    await db().delete(schema.libraryTracks).where(eq(schema.libraryTracks.id, venom.id));
    return venom.path;
  }

  const options = () => ({
    db: db(),
    settings: settings(),
    paths: PATHS,
    toolbox: TOOLBOX,
  });

  it("finds the file the database has forgotten and says where it would go", async () => {
    const path = await loseAmericanVenom();

    const report = await repairOrphans({ ...options(), dryRun: true });

    expect(report.orphans).toBe(1);
    const [item] = report.items;
    expect(item?.path).toBe(path);
    expect(item?.title).toBe("American Venom");
    // Found by the release in its own tags, not by its folder and not by a fingerprint.
    expect(item?.albumFoundBy).toBe("release");
    expect(item?.releaseMbid).toBe(RELEASE);
    // A dry run writes nothing.
    expect(await libraryRows()).toHaveLength(ROWS.length - 1);
  }, 60_000);

  it("puts the row back, on the album of the release its own tags name", async () => {
    await loseAmericanVenom();
    const report = await repairOrphans({ ...options(), dryRun: false });

    expect(report.created).toBe(1);
    const rows = await libraryRows();
    expect(rows).toHaveLength(ROWS.length);
    const venom = rows.find((row) => row.title === "American Venom");
    expect(venom).toBeDefined();
    const sibling = rows.find((row) => row.title === "Longing");
    expect(venom?.albumId).toBe(sibling?.albumId);
  }, 60_000);

  it("gives the repaired row a position no other track on the album holds", async () => {
    await loseAmericanVenom();
    await repairOrphans({ ...options(), dryRun: false });

    const rows = await libraryRows();
    const albumId = rows.find((entry) => entry.title === "American Venom")?.albumId;
    const positions = rows
      .filter((row) => row.albumId === albumId)
      .map((row) => row.trackNumber)
      .filter((value): value is number => value !== null);
    expect(new Set(positions).size).toBe(positions.length);
  }, 60_000);

  it("gives it a document and the import behind it, so a re-tag still has sources", async () => {
    await loseAmericanVenom();
    await repairOrphans({ ...options(), dryRun: false });

    const [venom] = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.title, "American Venom"));
    expect(venom?.importTrackId).not.toBeNull();

    const documents = await db()
      .select({ document: schema.metadataDocuments.document })
      .from(schema.metadataDocuments)
      .where(eq(schema.metadataDocuments.libraryTrackId, venom?.id ?? ""));
    expect(documents).toHaveLength(1);
    const fields = (documents[0]?.document as { fields: Record<string, { value: unknown }> })
      .fields;
    expect(fields["title"]?.value).toBe("American Venom");
  }, 60_000);

  it("is a no-op the second time: nothing is an orphan any more", async () => {
    await loseAmericanVenom();
    await repairOrphans({ ...options(), dryRun: false });
    const again = await repairOrphans({ ...options(), dryRun: false });

    expect(again.orphans).toBe(0);
    expect(again.items).toEqual([]);
    expect(await libraryRows()).toHaveLength(ROWS.length);
  }, 60_000);

  it("re-points a row that only lost its path rather than inserting a second one", async () => {
    await migrateAll("tags");
    const [venom] = await db()
      .select({ id: schema.libraryTracks.id })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.title, "American Venom"));
    // What a half-finished consolidation leaves: the row points somewhere the file is not,
    // and the scan has already stamped it missing.
    await db()
      .update(schema.libraryTracks)
      .set({
        path: "somewhere/else/03 - American Venom.opus",
        recordingMbid: STRAY_RECORDING,
        missingAt: new Date(),
      })
      .where(eq(schema.libraryTracks.id, venom?.id ?? ""));

    // The file's own `MUSICBRAINZ_TRACKID` is what ties it back; give it the same one.
    const report = await repairOrphans({
      ...options(),
      toolbox: {
        probe: async () => ({
          size: 1024,
          duration: 180,
          has_picture: true,
          tags: {
            TITLE: "American Venom",
            MUSICBRAINZ_ALBUMID: RELEASE,
            MUSICBRAINZ_TRACKID: STRAY_RECORDING,
          },
        }),
      } as unknown as Parameters<typeof migrateAlbum>[0]["toolbox"],
      dryRun: false,
    });

    expect(report.reattached).toBe(1);
    expect(report.created).toBe(0);
    const rows = await libraryRows();
    expect(rows.filter((row) => row.title === "American Venom")).toHaveLength(1);
    const [again] = await db()
      .select({ path: schema.libraryTracks.path, missingAt: schema.libraryTracks.missingAt })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.id, venom?.id ?? ""));
    expect(again?.path).toBe(`${MINORITY}/03 - American Venom.opus`);
    expect(again?.missingAt).toBeNull();
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* a document out of a file                                            */
/* ------------------------------------------------------------------ */

describe("documentFromTags", () => {
  const AT = new Date("2026-09-15T00:00:00.000Z");

  it("reads the tag map backwards, so the document speaks the pipeline vocabulary", () => {
    const document = documentFromTags(
      new Map([
        ["TITLE", "American Venom"],
        ["ALBUMARTIST", "Gustavo Santaolalla"],
        ["TRACKNUMBER", "3/14"],
        ["MUSICBRAINZ_ALBUMID", RELEASE],
      ]),
      AT,
    );
    expect(document.fields["title"]?.value).toBe("American Venom");
    expect(document.fields["albumartist"]?.value).toBe("Gustavo Santaolalla");
    // `3/14` is a legal TRACKNUMBER; the position is the part before the slash.
    expect(document.fields["tracknumber"]?.value).toBe(3);
    expect(document.fields["musicbrainz_albumid"]?.value).toBe(RELEASE);
  });

  it("marks every value `app`, which loses to every network source on the next rebuild", () => {
    const document = documentFromTags(new Map([["TITLE", "American Venom"]]), AT);
    expect(document.fields["title"]?.source).toBe("app");
    expect(document.fields["title"]?.locked).toBe(false);
  });

  it("splits a multi-valued tag the way a repeated Vorbis comment folds", () => {
    const document = documentFromTags(new Map([["ARTISTS", "Ellie; Gustavo Santaolalla"]]), AT);
    expect(document.fields["artists"]?.value).toEqual(["Ellie", "Gustavo Santaolalla"]);
  });

  it("keeps out of the picture and the lyrics, which a probe cannot report usefully", () => {
    const document = documentFromTags(
      new Map([
        ["METADATA_BLOCK_PICTURE", "AAAA"],
        ["LYRICS", "[00:01.00] a line"],
        ["TITLE", "American Venom"],
      ]),
      AT,
    );
    expect(document.fields["front_cover"]).toBeUndefined();
    expect(document.fields["lyrics"]).toBeUndefined();
    expect(document.fields["title"]).toBeDefined();
  });

  it("ignores a key the tag map does not know rather than inventing a field for it", () => {
    const document = documentFromTags(new Map([["SOMEBODYS_OWN_TAG", "whatever"]]), AT);
    expect(Object.keys(document.fields)).toEqual([]);
  });
});
