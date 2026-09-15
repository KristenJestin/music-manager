/**
 * What a migrated album says about how much of the record is actually there.
 *
 * The bug, reported on a real library: an album page read `1/1 tracks`, 97%, every badge green
 * — over a folder holding track 4 of a thirteen-track release, and the "incomplete" filter
 * matched nothing in six hundred albums. `refreshAlbumCounters` wrote
 * `trackCount: tracks.length, presentCount: tracks.length`, so the denominator was a copy of
 * the numerator and the fraction could not be anything but 1.
 *
 * Three albums here, one per rung of `services/album-counters.ts`, migrated by the real
 * `runMigration` against a real Postgres:
 *
 *  - **the release is in the cache** — one file of thirteen, and the answer is `1/13`;
 *  - **only the tags know** — two files of a two-disc release whose discs are 7 and 6 tracks
 *    long, and the answer is `2/13`, because the discs are summed and not multiplied;
 *  - **nothing knows** — no release, no totals, and the answer is `1/?`: the album is *not*
 *    reported complete and *not* reported incomplete, because neither is established.
 *
 * The v1 side is a stub `V1Reader` and the toolbox is a stub, exactly as in
 * `run.integration.test.ts`: what is under test is the counters, not the reader.
 *
 *   docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { V1Dataset, V1Song } from "./schema.ts";
import type { V1Reader } from "./reader.ts";
import type { MigrationOptions } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-countertest");
const LIBRARY_CONTAINER = "/library/.mm-countertest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_countertest`;
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
if (unavailable !== null) console.log(`  (album counter tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const { defaults } = await import("#/server/services/settings.ts");
const { runMigration, acknowledgeBackup } = await import("./run.ts");
const { put: cachePut } = await import("#/server/services/cache.ts");
const { albumGrid } = await import("#/server/services/library.ts");
const { recountAlbums } = await import("#/server/services/album-counters.ts");
const { runScan } = await import("#/server/services/scan.ts");

resetServerEnv();

/* ------------------------------------------------------------------ */
/* the v1 installation                                                 */
/* ------------------------------------------------------------------ */

/** The release the cache knows, and the one the production album was a single track of. */
const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";

interface Row {
  readonly id: number;
  readonly folder: string;
  readonly album: string;
  readonly disc: number | null;
  readonly discCount: number | null;
  readonly track: number;
  /** v1's `TrackCount`, which is what the seeded document's `totaltracks` becomes. */
  readonly trackCount: number | null;
  readonly title: string;
  readonly release: string | null;
}

/**
 * One row of a thirteen-track release, two of a two-disc one, one of nothing at all.
 *
 * Song 1 carries **no** `TrackCount`, on purpose: the only thing that can say "thirteen" about
 * it is the release in the cache, so the assertion cannot pass by reading a tag. Song 4 carries
 * no release and no `TrackCount`, so nothing can say anything about it — which is the state the
 * Console has to render as unknown rather than as complete.
 */
const ROWS: readonly Row[] = [
  {
    id: 1,
    folder: "Daft Punk/Discovery (2001)",
    album: "Discovery",
    disc: null,
    discCount: null,
    track: 4,
    trackCount: null,
    title: "Crescendolls",
    release: RELEASE,
  },
  {
    id: 2,
    folder: "Justice/Woman Worldwide (2018)",
    album: "Woman Worldwide",
    disc: 1,
    discCount: 2,
    track: 1,
    trackCount: 7,
    title: "Safe and Sound",
    release: null,
  },
  {
    id: 3,
    folder: "Justice/Woman Worldwide (2018)",
    album: "Woman Worldwide",
    disc: 2,
    discCount: 2,
    track: 1,
    trackCount: 6,
    title: "Alakazam!",
    release: null,
  },
  {
    id: 4,
    folder: "Nobody/Untitled (2020)",
    album: "Untitled",
    disc: null,
    discCount: null,
    track: 1,
    trackCount: null,
    title: "One Song",
    release: null,
  },
];

const ARTIST_OF: Readonly<Record<number, string>> = {
  1: "Daft Punk",
  2: "Justice",
  3: "Justice",
  4: "Nobody",
};

function pathOf(row: Row): string {
  const disc = row.disc === null ? "" : `Disc ${String(row.disc)} - `;
  return `${row.folder}/${disc}${String(row.track).padStart(2, "0")} - ${row.title}.opus`;
}

function song(row: Row): V1Song {
  return {
    id: row.id,
    sourceUrl: `https://www.youtube.com/watch?v=count${String(row.id).padStart(6, "0")}`,
    sourceUrlParent: null,
    platform: "YouTube",
    sourceId: `count${String(row.id).padStart(6, "0")}`,
    sourceIdParent: null,
    sourceTitle: `${ARTIST_OF[row.id] ?? ""} - ${row.title}`,
    sourceDescription: null,
    title: row.title,
    subtitle: null,
    artist: ARTIST_OF[row.id] ?? "",
    performers: [ARTIST_OF[row.id] ?? ""],
    album: row.album,
    isrc: null,
    albumArtists: [ARTIST_OF[row.id] ?? ""],
    year: 2001,
    trackNumber: row.track,
    trackCount: row.trackCount,
    discNumber: row.disc,
    discCount: row.discCount,
    publisher: null,
    genres: [],
    duration: 200_000,
    downloadStatus: "Present",
    finalFilePath: pathOf(row),
    lastAttempt: null,
    errorMessage: null,
    musicBrainzRecordingId: null,
    musicBrainzReleaseId: row.release,
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

function reader(): V1Reader {
  const dataset: V1Dataset = {
    songs: ROWS.map(song),
    forces: new Map(),
    playlists: [],
    playlistSongs: [],
  };
  return { read: async () => dataset, close: async () => {} };
}

const TOOLBOX = {
  probe: async (path: string) => {
    const relative = path.replace(`${LIBRARY_CONTAINER}/`, "");
    const row = ROWS.find((entry) => pathOf(entry) === relative);
    return {
      size: 1024,
      duration: 200,
      has_picture: false,
      tags:
        row === undefined
          ? {}
          : {
              TITLE: row.title,
              ALBUM: row.album,
              ALBUMARTIST: ARTIST_OF[row.id] ?? "",
              TRACKNUMBER: String(row.track),
              ...(row.release === null ? {} : { MUSICBRAINZ_ALBUMID: row.release }),
            },
    };
  },
  tag: async () => ({ ok: true, written: [], readback: {} }),
} as unknown as NonNullable<MigrationOptions["toolbox"]>;

/**
 * The thirteen-track release, as `documents.build` would have cached it.
 *
 * Thirteen and not fourteen so that no other number in this file can produce it by accident:
 * if the assertion reads `13`, it read the release.
 */
function seedRelease(): Promise<unknown> {
  return cachePut(
    "musicbrainz",
    `release/${RELEASE}?inc=releaseFull`,
    {
      id: RELEASE,
      title: "Discovery",
      media: [
        {
          position: 1,
          "track-count": 13,
          tracks: Array.from({ length: 13 }, (_, index) => ({
            id: `trk-${String(index + 1)}`,
            position: index + 1,
            title: `Track ${String(index + 1)}`,
          })),
        },
      ],
    },
    { db: db() },
  );
}

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

async function migrateAll() {
  return await runMigration({
    dbUrl: "postgres://v1:***@localhost:5432/v1_fixture",
    libraryPath: LIBRARY_HOST,
    reader: reader(),
    toolbox: TOOLBOX,
    db: db(),
    settings: settings(),
    offline: true,
    trigger: "test",
  });
}

interface Counters {
  readonly title: string;
  readonly trackCount: number;
  readonly presentCount: number;
  readonly trackCountSource: string;
}

async function counters(): Promise<Record<string, Counters>> {
  const rows = await db()
    .select({
      title: schema.libraryAlbums.title,
      trackCount: schema.libraryAlbums.trackCount,
      presentCount: schema.libraryAlbums.presentCount,
      trackCountSource: schema.libraryAlbums.trackCountSource,
    })
    .from(schema.libraryAlbums);
  return Object.fromEntries(rows.map((row) => [row.title, row]));
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
  await sql.unsafe(
    `truncate table library_tracks, library_albums, metadata_documents, import_tracks, imports,
     inbox_items, migration_v1, migration_v1_runs, app_meta, job_events, source_cache
     restart identity cascade`,
  );
  await sql.end();
  await acknowledgeBackup(db());
  await seedRelease();

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

describe.skipIf(unavailable !== null)(
  "a migrated album counts the release, not its own files",
  () => {
    it("reports 1/13 for one track of a thirteen-track release", async () => {
      const { report } = await migrateAll();
      expect(report.counts.failed).toBe(0);

      const discovery = (await counters())["Discovery"];
      // The whole bug in three lines. This used to be `1/1`, from `tracks.length` twice.
      expect(discovery?.presentCount).toBe(1);
      expect(discovery?.trackCount).toBe(13);
      expect(discovery?.trackCountSource).toBe("release");
    }, 120_000);

    it("puts it under the `incomplete` filter, where it was invisible before", async () => {
      await migrateAll();

      const grid = await albumGrid({ filter: "incomplete" }, db());
      // Both counted albums are short of their release; the third has no total to be short of.
      expect(grid.counts.incomplete).toBe(2);
      expect(grid.albums.map((album) => album.title).sort()).toEqual([
        "Discovery",
        "Woman Worldwide",
      ]);
      const card = grid.albums.find((album) => album.title === "Discovery");
      expect(card?.presentCount).toBe(1);
      expect(card?.trackCount).toBe(13);
      expect(card?.quality.totalKnown).toBe(true);
    }, 120_000);

    it("sums a two-disc release's discs rather than multiplying one of them", async () => {
      await migrateAll();

      // 7 on disc one, 6 on disc two. `totaltracks × totaldiscs` would answer 14 or 12.
      const woman = (await counters())["Woman Worldwide"];
      expect(woman?.presentCount).toBe(2);
      expect(woman?.trackCount).toBe(13);
      expect(woman?.trackCountSource).toBe("tags");
    }, 120_000);

    it("says the total is unknown when neither the release nor the tags know it", async () => {
      await migrateAll();

      const untitled = (await counters())["Untitled"];
      expect(untitled?.presentCount).toBe(1);
      expect(untitled?.trackCount).toBe(1);
      // `1/1` with nothing behind it. The source is the only thing that stops the Console
      // rendering that as a complete album, and the grid must not call it incomplete either.
      expect(untitled?.trackCountSource).toBe("rows");

      const grid = await albumGrid({}, db());
      const card = grid.albums.find((album) => album.title === "Untitled");
      expect(card?.quality.totalKnown).toBe(false);
      expect(grid.albums.map((album) => album.title)).toContain("Untitled");
      // Two of the three albums are incomplete. This one is neither: it is unknown, and the
      // filter that used to match nothing at all must still not claim it.
      expect(grid.counts.incomplete).toBe(2);
      const incomplete = await albumGrid({ filter: "incomplete" }, db());
      expect(incomplete.albums.map((album) => album.title)).not.toContain("Untitled");
    }, 120_000);

    it("is stable under a second recount: the backfill is safe to run twice", async () => {
      await migrateAll();

      const first = await recountAlbums(db());
      expect(first.albums).toBe(3);
      expect(first.changed).toBe(0);

      const before = await counters();
      const second = await recountAlbums(db());
      expect(second.changed).toBe(0);
      expect(await counters()).toEqual(before);
    }, 120_000);

    it("drops present_count and holds track_count when a file leaves the library", async () => {
      await migrateAll();
      rmSync(join(LIBRARY_HOST, pathOf(ROWS[0] as Row)));

      // The scan is the only thing that walks the tree, so it is the only thing that can see a
      // file go. It now decides both columns in one place rather than writing `present_count`
      // alone and leaving the denominator to whoever wrote it last.
      const { report } = await runScan({ db: db(), toolbox: TOOLBOX, driftLimit: 0 });
      expect(report.missing).toHaveLength(1);

      const discovery = (await counters())["Discovery"];
      expect(discovery?.presentCount).toBe(0);
      expect(discovery?.trackCount).toBe(13);
      expect(discovery?.trackCountSource).toBe("release");
    }, 120_000);

    it("backfills a library whose albums were left claiming to be complete", async () => {
      await migrateAll();

      // Exactly the state the old migration left behind, and the state the user's 617 albums
      // are in: both columns equal to the file count, on an album that holds one track of 13.
      const discoveryId = (
        await db()
          .select({ id: schema.libraryAlbums.id })
          .from(schema.libraryAlbums)
          .where(eq(schema.libraryAlbums.title, "Discovery"))
      )[0]?.id;
      await db()
        .update(schema.libraryAlbums)
        .set({ trackCount: 1, presentCount: 1, trackCountSource: "rows" })
        .where(eq(schema.libraryAlbums.id, discoveryId ?? ""));

      const result = await recountAlbums(db());
      expect(result.changed).toBe(1);
      expect((await counters())["Discovery"]).toMatchObject({
        trackCount: 13,
        presentCount: 1,
        trackCountSource: "release",
      });
    }, 120_000);
  },
);
