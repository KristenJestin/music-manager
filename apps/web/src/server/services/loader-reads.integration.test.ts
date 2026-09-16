/**
 * What two loaders are allowed to read, asserted by counting the rows they actually read.
 *
 * Both of these have already been shipped wrong once, and neither mistake was visible in a
 * type, a snapshot or a screenshot — the pages looked right and took seconds:
 *
 *  1. `/library/quality` read **every metadata document twice**: once to score the library and
 *     again inside `countOffTemplate`, which `planRelocate` calls, and which also makes up to
 *     two synchronous `existsSync` calls per track. On the owner's library that is ten
 *     thousand blocking stats on the SSR event loop to put an integer on a button.
 *  2. the app shell counted open Inbox items with `listInbox().length`, which materialises
 *     every open item **with its `payload` jsonb**. The shell loader re-runs on every link
 *     hover (`defaultPreload: "intent"` with `defaultPreloadStaleTime: 0`), so that was a few
 *     hundred candidate sets per mouse movement.
 *
 * A comment saying "do not do that" is not a guard, and a timing assertion is a flake. These
 * count rows, through `server/db/counting.ts`, which wraps the one method every Drizzle query
 * on `postgres-js` goes through. A future change that reintroduces either read fails here.
 *
 * Skips itself when there is no Postgres, like every `*.integration.test.ts` here. Offline by
 * construction: no toolbox, no network, no files.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrackDocument } from "@mm/domain";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_loaderreads`;
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
if (unavailable !== null) console.log(`  (loader read tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { countingDatabase } = await import("#/server/db/counting.ts");
const schema = await import("#/server/db/schema/index.ts");
const { field, TAG_SCHEMA_VERSION, trackCompleteness } = await import("@mm/domain");
const { qualityPayload, QUALITY_PAGE_SIZE } = await import("./quality-page.ts");
const { countInbox } = await import("./inbox.ts");

resetServerEnv();

const AT = "2026-09-01T00:00:00.000Z";
/** Comfortably more albums than one page, so "a page" and "the library" cannot be confused. */
const ALBUMS = QUALITY_PAGE_SIZE + 12;
const TRACKS_PER_ALBUM = 3;
const OPEN_ITEMS = 40;

function document(position: number): TrackDocument {
  return {
    fields: {
      title: field(`A title ${String(position)}` as never, "musicbrainz", AT),
      artist: field("An artist" as never, "musicbrainz", AT),
      album: field("An album" as never, "musicbrainz", AT),
      albumartist: field("An artist" as never, "musicbrainz", AT),
      tracknumber: field(position as never, "musicbrainz", AT),
      discnumber: field(1 as never, "musicbrainz", AT),
    },
    na: {},
    schemaVersion: TAG_SCHEMA_VERSION,
  } as unknown as TrackDocument;
}

const counted = unavailable === null ? countingDatabase(TEST_URL) : null;

beforeAll(async () => {
  if (unavailable !== null) return;

  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const client = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(client), { migrationsFolder: resolve(REPO_ROOT, "apps/web/drizzle") });
  await client.end();

  const database = counted?.db;
  if (database === undefined) return;

  for (let a = 0; a < ALBUMS; a += 1) {
    const albumId = `alb_${String(a)}`;
    await database.insert(schema.libraryAlbums).values({
      id: albumId,
      title: `Album ${String(a)}`,
      albumArtist: `Artist ${String(a % 7)}`,
      year: 2001,
      releaseMbid: `rel-${String(a)}`,
      folder: `Artist ${String(a % 7)}/Album ${String(a)}`,
      trackCount: TRACKS_PER_ALBUM,
      presentCount: TRACKS_PER_ALBUM,
      trackCountSource: "release",
    });
    for (let t = 1; t <= TRACKS_PER_ALBUM; t += 1) {
      const trackId = `${albumId}_t${String(t)}`;
      await database.insert(schema.libraryTracks).values({
        id: trackId,
        albumId,
        title: `Track ${String(t)}`,
        artist: `Artist ${String(a % 7)}`,
        trackNumber: t,
        discNumber: 1,
        path: `Artist ${String(a % 7)}/Album ${String(a)}/${String(t)}.opus`,
        format: "opus",
        tagSchemaVersion: TAG_SCHEMA_VERSION,
      });
      const held = document(t);
      await database.insert(schema.metadataDocuments).values({
        id: `doc_${trackId}`,
        libraryTrackId: trackId,
        document: held as unknown as Record<string, unknown>,
        tagSchemaVersion: TAG_SCHEMA_VERSION,
        completeness: trackCompleteness(held).score,
      });
    }
  }

  /* Open Inbox items with a payload worth not reading. */
  for (let i = 0; i < OPEN_ITEMS; i += 1) {
    await database.insert(schema.inboxItems).values({
      id: `inb_${String(i)}`,
      type: "ambiguous_recording",
      status: "open",
      title: `Which recording is ${String(i)}?`,
      payload: {
        alternatives: Array.from({ length: 20 }, (_, k) => ({
          mbid: `cand-${String(i)}-${String(k)}`,
          title: `Candidate ${String(k)}`,
        })),
      } as Record<string, unknown>,
    });
  }
}, 120_000);

describe.skipIf(unavailable !== null)("what a loader is allowed to read", () => {
  it("scores the library once for /library/quality, and never reads a document twice", async () => {
    const database = counted?.db;
    if (database === undefined || counted === null) return;

    counted.reset();
    const payload = await qualityPayload({ filter: "all", profile: "global", page: 0 }, database);

    const tracks = ALBUMS * TRACKS_PER_ALBUM;
    const documents = counted.rowsFrom("metadata_documents");

    /*
     * The ceiling that matters. `countOffTemplate` in the loader made this exactly `2 ×
     * tracks`; anything above one pass means a second reader has been added.
     */
    expect(documents).toBe(tracks);
    expect(payload.total).toBe(ALBUMS);
    expect(payload.rows).toHaveLength(QUALITY_PAGE_SIZE);

    /*
     * Nothing per-track travels. `quality.tracks` was one object per track with six profile
     * scores, shipped for the whole library and read by nothing.
     */
    for (const row of payload.rows) {
      expect(Object.keys(row.quality)).not.toContain("tracks");
      expect(Object.keys(row.quality)).not.toContain("divergences");
    }

    /*
     * And the page is a page. The albums beyond it are still *scored* — the chips, the tiles
     * and "worst first" are statements about the whole library — but they do not travel.
     */
    const second = await qualityPayload({ filter: "all", profile: "global", page: 1 }, database);
    expect(second.rows).toHaveLength(ALBUMS - QUALITY_PAGE_SIZE);
    expect(second.hasMore).toBe(false);
    // Same library, same statements above the table, whichever page is being read.
    expect(second.counts).toEqual(payload.counts);
    expect(second.stats).toEqual(payload.stats);
  }, 120_000);

  it("counts open Inbox items without materialising one", async () => {
    const database = counted?.db;
    if (database === undefined || counted === null) return;

    counted.reset();
    const open = await countInbox({ status: "open" }, database);

    expect(open).toBe(OPEN_ITEMS);
    /*
     * One row came back — the count — and it was not forty. A `listInbox(...).length` here
     * returns `OPEN_ITEMS` rows with their `payload` jsonb, which is what this asserts against.
     */
    expect(counted.rowsFrom("inbox_items")).toBe(1);
    expect(counted.queries).toHaveLength(1);
    expect(counted.queries[0]?.sql).toMatch(/count\(\*\)/);
  }, 60_000);
});
