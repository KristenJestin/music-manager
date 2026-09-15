/**
 * `runMigration`, end to end, against a real Postgres — the three properties a five-thousand
 * song library actually needs.
 *
 * All three were broken at once on a production run (`mig_01M2GQ0S3CHHEP9KFHSMJFHZ0G`), and
 * they compound, which is why they are tested together:
 *
 *  1. **Two releases of one record render one folder.** The rule of P11.1 is one album row per
 *     v1 release MBID; the folder is rendered from (album artist, title, year). So
 *     `Imagine Dragons — Smoke + Mirrors` came out as two album rows aiming at
 *     `Imagine Dragons/Smoke + Mirrors (2015)`, and `library_albums_folder_idx` is unique.
 *  2. **An album that throws took the whole run with it.** The insert above threw eighty
 *     minutes in, outside `migrateAlbum`'s per-track guard, so the exception left `runMigration`
 *     entirely: 2885 of 5288 songs were never reached, half the library renamed by
 *     `--rename-to-template` and half not.
 *  3. **Restarting had to finish the rest.** Which it does through `migration_v1` — but nothing
 *     proved it from a *half-finished* state until here.
 *
 * The v1 side is a stub `V1Reader` and the toolbox is a stub: what is under test is this file's
 * decisions, and standing up a second Postgres with v1's schema would test the reader instead.
 * The files are real, because the consolidation and the renames stat them.
 *
 *   docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { V1Dataset, V1Song } from "./schema.ts";
import type { V1Reader } from "./reader.ts";
import type { MigrationOptions } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-runtest");
const LIBRARY_CONTAINER = "/library/.mm-runtest";

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_runtest`;
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
if (unavailable !== null) console.log(`  (migration run tests skipped: ${unavailable})`);

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
const { newId } = await import("#/server/ids.ts");

resetServerEnv();

/* ------------------------------------------------------------------ */
/* the v1 installation                                                 */
/* ------------------------------------------------------------------ */

/** Two releases of one record. This is the pair that killed the production run. */
const RELEASE_A = "6ace8918-8da5-4d95-9f62-49f64e60fedd";
const RELEASE_B = "1c801841-4486-4968-95df-5853eed1ea12";

/**
 * One v1 folder, because v1 files by `AlbumArtist/Album (Year)` and both releases agree on all
 * three. Five rows over the two releases, at the positions v1 gave them.
 */
const FOLDER = "Imagine Dragons/Smoke + Mirrors (2015)";

interface Row {
  readonly id: number;
  readonly release: string;
  readonly track: number;
  readonly title: string;
}

/**
 * Three rows on the first release and two on the second, on purpose.
 *
 * The uneven split is what makes "who keeps the plain folder name" a question with a right
 * answer: the release most of the record is on. `groupAlbums` sorts the fuller album first
 * within one folder for exactly this.
 */
const ROWS: readonly Row[] = [
  { id: 1, release: RELEASE_A, track: 1, title: "Shots" },
  { id: 2, release: RELEASE_A, track: 2, title: "Gold" },
  { id: 3, release: RELEASE_A, track: 3, title: "I'm So Sorry" },
  { id: 4, release: RELEASE_B, track: 1, title: "Smoke and Mirrors" },
  { id: 5, release: RELEASE_B, track: 2, title: "I Bet My Life" },
];

/** Every title, sorted — the "nothing was lost" assertion, spelled once. */
const ALL_TITLES = [...ROWS.map((row) => row.title)].sort();

function pathOf(row: Row): string {
  return `${FOLDER}/${String(row.track).padStart(2, "0")} - ${row.title}.opus`;
}

function song(row: Row): V1Song {
  return {
    id: row.id,
    sourceUrl: `https://www.youtube.com/watch?v=idrag${String(row.id).padStart(6, "0")}`,
    sourceUrlParent: null,
    platform: "YouTube",
    sourceId: `idrag${String(row.id).padStart(6, "0")}`,
    sourceIdParent: null,
    sourceTitle: `Imagine Dragons - ${row.title}`,
    sourceDescription: null,
    title: row.title,
    subtitle: null,
    artist: "Imagine Dragons",
    performers: ["Imagine Dragons"],
    album: "Smoke + Mirrors",
    isrc: null,
    albumArtists: ["Imagine Dragons"],
    year: 2015,
    trackNumber: row.track,
    trackCount: 2,
    discNumber: 1,
    discCount: 1,
    publisher: null,
    genres: ["Rock"],
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

/** A `V1Reader` over a slice of the rows above — `only` is how a half-finished run is made. */
function reader(only: readonly number[] = ROWS.map((row) => row.id)): V1Reader {
  const dataset: V1Dataset = {
    songs: ROWS.filter((row) => only.includes(row.id)).map(song),
    forces: new Map(),
    playlists: [],
    playlistSongs: [],
  };
  return {
    read: async () => dataset,
    close: async () => {},
  };
}

/**
 * The toolbox, reduced to what a migration of present files asks of it.
 *
 * `probe` answers with the tag set v1 wrote, so `reconcile` matches every file to its row by
 * path and `releaseMbidFor` finds the release on the row. `tag` says yes.
 */
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
              ALBUM: "Smoke + Mirrors",
              ALBUMARTIST: "Imagine Dragons",
              TRACKNUMBER: String(row.track),
              MUSICBRAINZ_ALBUMID: row.release,
            },
    };
  },
  tag: async () => ({ ok: true, written: [], readback: {} }),
} as unknown as NonNullable<MigrationOptions["toolbox"]>;

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

async function migrateWith(over: Partial<MigrationOptions> = {}) {
  return await runMigration({
    dbUrl: "postgres://v1:***@localhost:5432/v1_fixture",
    libraryPath: LIBRARY_HOST,
    reader: reader(),
    toolbox: TOOLBOX,
    db: db(),
    settings: settings(),
    offline: true,
    trigger: "test",
    ...over,
  });
}

/** Every album row, folder and all. */
async function albums(): Promise<{ id: string; folder: string; releaseMbid: string | null }[]> {
  const rows = await db()
    .select({
      id: schema.libraryAlbums.id,
      folder: schema.libraryAlbums.folder,
      releaseMbid: schema.libraryAlbums.releaseMbid,
    })
    .from(schema.libraryAlbums);
  return rows.sort((left, right) => left.folder.localeCompare(right.folder));
}

async function trackTitles(): Promise<string[]> {
  const rows = await db().select({ title: schema.libraryTracks.title }).from(schema.libraryTracks);
  return rows.map((row) => row.title).sort();
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
     inbox_items, migration_v1, migration_v1_runs, app_meta, job_events restart identity cascade`,
  );
  await sql.end();
  // The backup acknowledgement is the one thing a real run refuses to start without.
  await acknowledgeBackup(db());

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
/* two releases, one rendered folder                                   */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("two releases of one record", () => {
  it("migrates both, giving the second a folder of its own instead of failing", async () => {
    const { report, run } = await migrateWith();

    expect(report.errors).toEqual([]);
    expect(report.counts.failed).toBe(0);
    expect(run.status).toBe("done");
    expect(await trackTitles()).toEqual(ALL_TITLES);

    const rows = await albums();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.folder)).size).toBe(2);
    // One of them keeps the name v1 gave it; the other is told apart by its release.
    expect(rows.some((row) => row.folder === FOLDER)).toBe(true);
    const other = rows.find((row) => row.folder !== FOLDER);
    expect(other?.folder).toMatch(/^Imagine Dragons\/Smoke \+ Mirrors \(2015\) \[[0-9a-f]{8}\]$/);
  }, 120_000);

  it("leaves the plain folder to the release most of the record is on", async () => {
    await migrateWith();

    const rows = await albums();
    const plain = rows.find((row) => row.folder === FOLDER);
    // Three of the five rows are on the first release; the two-track edition takes the suffix.
    expect(plain?.releaseMbid).toBe(RELEASE_A);
    const counted = await db()
      .select({ id: schema.libraryTracks.id })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.albumId, plain?.id ?? ""));
    expect(counted).toHaveLength(3);
  }, 120_000);

  it("names the disambiguated folder after the release, so it is the same on every run", async () => {
    await migrateWith();
    const rows = await albums();
    const other = rows.find((row) => row.folder !== FOLDER);
    expect(other?.releaseMbid).not.toBeNull();
    expect(other?.folder).toBe(
      `${FOLDER} [${(other?.releaseMbid ?? "").replace(/-/g, "").slice(0, 8)}]`,
    );
  }, 120_000);

  it("is idempotent: a second run adds no suffix and moves nothing", async () => {
    await migrateWith();
    const first = await albums();

    const { report } = await migrateWith();

    expect(report.counts.failed).toBe(0);
    expect(report.counts.migrated).toBe(0);
    expect(report.counts.alreadyDone).toBe(ROWS.length);
    expect(await albums()).toEqual(first);
  }, 120_000);

  it("moves the minority release's files into the folder its album row claims", async () => {
    await migrateWith();
    const other = (await albums()).find((row) => row.folder !== FOLDER);
    const paths = await db()
      .select({ path: schema.libraryTracks.path })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.albumId, other?.id ?? ""));
    for (const row of paths) {
      expect(row.path.startsWith(`${other?.folder ?? ""}/`)).toBe(true);
      expect(existsSync(join(LIBRARY_HOST, row.path))).toBe(true);
    }
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* an album is a unit of failure, not of abandonment                   */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("when one album cannot be migrated", () => {
  /**
   * Take both folders an album could have, with rows that are nobody's business.
   *
   * That is the shape of the production failure reduced to its essentials: every candidate
   * folder is held by another album row, so `upsertAlbum` hits `library_albums_folder_idx` —
   * and before this fix, the exception walked out of `runMigration` and the remaining songs
   * were never seen.
   */
  async function squatBothFoldersOf(release: string): Promise<void> {
    for (const folder of [FOLDER, `${FOLDER} [${release.replace(/-/g, "").slice(0, 8)}]`]) {
      await db()
        .insert(schema.libraryAlbums)
        .values({
          id: newId("libraryAlbum"),
          albumArtist: "Somebody Else",
          title: "Not This Record",
          folder,
          releaseMbid: "99999999-9999-9999-9999-999999999999",
        });
    }
  }

  it("records the album as failed and carries on to the next one", async () => {
    await squatBothFoldersOf(RELEASE_A);

    const { report, run } = await migrateWith();

    // The run finished. That is the whole point.
    expect(run.status).toBe("done");
    expect(report.counts.failed).toBe(3);
    expect(report.errors).toHaveLength(3);
    expect(report.errors[0]?.message).toMatch(/the album could not be migrated/);

    // And the other release went through untouched.
    expect(await trackTitles()).toEqual(["I Bet My Life", "Smoke and Mirrors"]);
  }, 120_000);

  it("writes every track of the failed album down as `failed`, with the reason", async () => {
    await squatBothFoldersOf(RELEASE_A);
    await migrateWith();

    const rows = await db()
      .select({
        songId: schema.migrationV1.v1SongId,
        outcome: schema.migrationV1.outcome,
        error: schema.migrationV1.error,
      })
      .from(schema.migrationV1)
      .where(eq(schema.migrationV1.outcome, "failed"));
    expect(rows.map((row) => row.songId).sort()).toEqual(["1", "2", "3"]);
    expect(JSON.stringify(rows[0]?.error)).toMatch(/could not be migrated/);
  }, 120_000);

  it("raises one Inbox item for it, so it is a question and not a log line", async () => {
    await squatBothFoldersOf(RELEASE_A);
    await migrateWith();

    const items = await db()
      .select({ type: schema.inboxItems.type, title: schema.inboxItems.title })
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.status, "open"));
    const raised = items.filter((item) => item.title.includes("could not be migrated"));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.type).toBe("album_incomplete");
  }, 120_000);

  it("retries exactly that album on the next run, once the way is clear", async () => {
    await squatBothFoldersOf(RELEASE_A);
    await migrateWith();
    // Whatever was in the way is gone — the user moved it, or the folder freed up.
    await db()
      .delete(schema.libraryAlbums)
      .where(eq(schema.libraryAlbums.albumArtist, "Somebody Else"));

    const { report } = await migrateWith();

    expect(report.counts.failed).toBe(0);
    expect(report.counts.migrated).toBe(3);
    expect(await trackTitles()).toEqual(ALL_TITLES);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* finishing what a dead run started                                   */
/* ------------------------------------------------------------------ */

describe.skipIf(unavailable !== null)("resuming a half-finished migration", () => {
  it("finishes the songs the first run never reached, and re-does none of them", async () => {
    // A run that only ever saw half the library — which is what a run that died looks like
    // from the next one's point of view.
    const half = await migrateWith({ reader: reader([1, 2, 3]) });
    expect(half.report.counts.migrated).toBe(3);

    const rest = await migrateWith();

    expect(rest.report.counts.alreadyDone).toBe(3);
    expect(rest.report.counts.migrated).toBe(2);
    expect(rest.report.counts.failed).toBe(0);
    expect(await trackTitles()).toEqual(ALL_TITLES);
  }, 120_000);

  it("continues the run row a dead run left behind rather than opening a second one", async () => {
    const half = await migrateWith({ reader: reader([1, 2]) });
    // What an aborted run leaves: the row never reached `done`.
    await db()
      .update(schema.migrationV1Runs)
      .set({ status: "running" })
      .where(eq(schema.migrationV1Runs.id, half.run.id));

    const rest = await migrateWith();

    expect(rest.run.id).toBe(half.run.id);
    const runs = await db().select({ id: schema.migrationV1Runs.id }).from(schema.migrationV1Runs);
    expect(runs).toHaveLength(1);
  }, 120_000);

  it("never lets a dry run adopt the real run it was previewing", async () => {
    const half = await migrateWith({ reader: reader([1, 2]) });
    await db()
      .update(schema.migrationV1Runs)
      .set({ status: "running" })
      .where(eq(schema.migrationV1Runs.id, half.run.id));

    const preview = await migrateWith({ dryRun: true });

    expect(preview.run.id).not.toBe(half.run.id);
    expect(preview.run.dryRun).toBe(true);
  }, 120_000);

  it("leaves the half-done rows exactly as they were", async () => {
    await migrateWith({ reader: reader([1, 2]) });
    const before = await db()
      .select({ id: schema.libraryTracks.id, path: schema.libraryTracks.path })
      .from(schema.libraryTracks);

    await migrateWith();

    const after = await db()
      .select({ id: schema.libraryTracks.id, path: schema.libraryTracks.path })
      .from(schema.libraryTracks);
    for (const row of before) {
      expect(after.find((entry) => entry.id === row.id)?.path).toBe(row.path);
    }
  }, 120_000);
});
