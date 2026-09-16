/**
 * The filter, against a real Postgres, over a library bigger than one page.
 *
 * The unit test next door proves the compiler emits the right text. This proves the two things
 * only a database can say:
 *
 *  1. **the SQL runs.** Half of these fields are correlated subqueries, `filter (where …)`
 *     aggregates and jsonb paths — `->'fields'->'lyrics'->'value'->>'synced'`, `jsonb_exists`,
 *     `coalesce((verification->>'mismatches')::int, 0)`. None of that is checked by rendering
 *     it; a missing cast is a runtime error and nothing else;
 *  2. **the count and the rows agree.** 160 tracks, a page of 60, three pages: the totals the
 *     pager prints, the number of rows walking the pages actually yields, and the number of
 *     rows the same filter returns unpaged all have to be one number. That is the bug this
 *     whole design exists to make impossible, so it is asserted by walking the pages rather
 *     than by trusting the service to have used the same predicate twice.
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
const TEST_DB = `${BASE_DB}_filtertest`;
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
if (unavailable !== null)
  console.log(`  (library filter integration tests skipped: ${unavailable})`);

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { field, TAG_SCHEMA_VERSION, trackCompleteness } = await import("@mm/domain");
const { albumGrid, artistList, trackList } = await import("./library.ts");
const { ALBUM_FILTER_FIELDS, TRACK_FILTER_FIELDS, ARTIST_FILTER_FIELDS, decodeFilter } =
  await import("#/lib/filters/index.ts");

resetServerEnv();

const AT = "2026-09-01T00:00:00.000Z";

/** 4 albums × 40 tracks: three pages of sixty, so a paging mistake has somewhere to hide. */
const ALBUMS = [
  {
    id: "alb_disc",
    title: "Discovery",
    albumArtist: "Daft Punk",
    year: 2001,
    releaseMbid: "rel-discovery",
    coverPath: "Daft Punk/Discovery (2001)/cover.jpg",
    trackCount: 40,
    presentCount: 40,
    trackCountSource: "release",
    format: "opus",
  },
  {
    id: "alb_home",
    title: "Homework",
    albumArtist: "Daft Punk",
    year: 1997,
    releaseMbid: "rel-homework",
    coverPath: null,
    trackCount: 60,
    presentCount: 40,
    trackCountSource: "release",
    format: "flac",
  },
  {
    id: "alb_curr",
    title: "Currents",
    albumArtist: "Tame Impala",
    year: 2015,
    releaseMbid: "rel-currents",
    coverPath: "Tame Impala/Currents (2015)/cover.jpg",
    trackCount: 40,
    presentCount: 40,
    // "rows" means the total is our own file count, so this album's completion is *unknown*.
    trackCountSource: "rows",
    format: "opus",
  },
  {
    id: "alb_untag",
    title: "Someone's Mixtape",
    albumArtist: "Unknown Artist",
    year: null,
    releaseMbid: null,
    coverPath: null,
    trackCount: 40,
    presentCount: 40,
    trackCountSource: "tags",
    format: "mp3",
  },
] as const;

function document(lyrics: boolean): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {
    title: field("A title" as never, "musicbrainz", AT),
    artist: field("An artist" as never, "musicbrainz", AT),
  };
  if (lyrics) {
    fields["lyrics"] = field({ synced: null, plain: "la la la" } as never, "lrclib", AT);
  }
  return { fields, na: {}, schemaVersion: TAG_SCHEMA_VERSION };
}

beforeAll(async () => {
  if (unavailable !== null) return;

  const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${TEST_DB}" with (force)`);
  await admin.unsafe(`create database "${TEST_DB}"`);
  await admin.end();

  const client = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
  await migrate(drizzle(client), { migrationsFolder: resolve(REPO_ROOT, "apps/web/drizzle") });
  await client.end();

  const database = db();
  for (const album of ALBUMS) {
    await database.insert(schema.libraryAlbums).values({
      id: album.id,
      title: album.title,
      albumArtist: album.albumArtist,
      year: album.year,
      releaseMbid: album.releaseMbid,
      coverPath: album.coverPath,
      folder: `${album.albumArtist}/${album.title}`,
      trackCount: album.trackCount,
      presentCount: album.presentCount,
      trackCountSource: album.trackCountSource,
      // "Clean" for Discovery, "Mismatch" for Homework, never verified for the rest.
      ...(album.id === "alb_disc"
        ? {
            verifiedAt: new Date(AT),
            verification: { mismatches: 0, notIndexed: 0 } as Record<string, unknown>,
          }
        : {}),
      ...(album.id === "alb_home"
        ? {
            verifiedAt: new Date(AT),
            verification: { mismatches: 3, notIndexed: 1 } as Record<string, unknown>,
          }
        : {}),
    });

    for (let position = 1; position <= 40; position += 1) {
      const trackId = `${album.id}_t${String(position)}`;
      await database.insert(schema.libraryTracks).values({
        id: trackId,
        albumId: album.id,
        title: `${album.title} ${String(position)}`,
        artist: album.albumArtist,
        trackNumber: position,
        discNumber: 1,
        path: `${album.albumArtist}/${album.title}/${String(position)}.${album.format}`,
        format: album.format,
        duration: 120 + position,
        recordingMbid: album.releaseMbid === null ? null : `rec-${album.id}-${String(position)}`,
        // Every fourth file was written under an older projection.
        tagSchemaVersion: position % 4 === 0 ? 1 : TAG_SCHEMA_VERSION,
        // Every tenth file has gone from disk since the last scan.
        missingAt: position % 10 === 0 ? new Date(AT) : null,
      });
      /*
       * `completeness` is written from the document, exactly as `documents.ts` writes it in
       * production. That is not incidental to the fixture: the *filter* reads this column and
       * the *badge* recomputes `trackCompleteness` from the document, and the whole reason
       * the tracks page may offer a completeness filter at all is that those two are the same
       * number. A fixture that seeded an arbitrary value here would be testing the column
       * against itself.
       */
      const held = document(position % 2 === 0);
      await database.insert(schema.metadataDocuments).values({
        id: `doc_${trackId}`,
        libraryTrackId: trackId,
        document: held as unknown as Record<string, unknown>,
        tagSchemaVersion: TAG_SCHEMA_VERSION,
        completeness: trackCompleteness(held).score,
      });
    }
  }

  await database.insert(schema.artistsCache).values({
    artistMbid: "mb-daft-punk",
    name: "Daft Punk",
    country: "FR",
    imageUrl: "https://example.invalid/daft.jpg",
    sortName: "Daft Punk",
  });
}, 120_000);

const albumTree = (raw: string) => {
  const decoded = decodeFilter(raw, ALBUM_FILTER_FIELDS);
  expect(decoded.error, `"${raw}": ${decoded.error ?? ""}`).toBeNull();
  return decoded.tree;
};
const trackTree = (raw: string) => {
  const decoded = decodeFilter(raw, TRACK_FILTER_FIELDS);
  expect(decoded.error, `"${raw}": ${decoded.error ?? ""}`).toBeNull();
  return decoded.tree;
};

describe.skipIf(unavailable !== null)("the filter, compiled and run", () => {
  it("means the same thing to the count and to the rows, page after page", async () => {
    // Behind the schema *and* on an Opus file: 10 of Discovery's 40, 10 of Currents' 40. The
    // point is not the number — it is that three separate queries have to produce it.
    const filters = trackTree("schema:eq:behind;format:eq:opus");

    const first = await trackList({ filters, limit: 60, offset: 0 });
    const unpaged = await trackList({ filters, limit: 1_000, offset: 0 });
    expect(unpaged.tracks).toHaveLength(unpaged.total);
    expect(first.total).toBe(unpaged.total);

    const seen = new Set<string>();
    for (let offset = 0; offset < first.total; offset += 60) {
      const page = await trackList({ filters, limit: 60, offset });
      expect(page.total).toBe(first.total);
      for (const row of page.tracks) seen.add(row.id);
    }
    expect(seen.size).toBe(first.total);
  });

  it("pages a wide filter across three pages without losing or repeating a row", async () => {
    const filters = trackTree("duration:gte:0");
    const first = await trackList({ filters, limit: 60, offset: 0 });
    expect(first.total).toBe(160);

    const seen = new Set<string>();
    let pages = 0;
    for (let offset = 0; offset < first.total; offset += 60) {
      const page = await trackList({ filters, limit: 60, offset });
      pages += 1;
      for (const row of page.tracks) seen.add(row.id);
    }
    expect(pages).toBe(3);
    expect(seen.size).toBe(160);
  });

  it("agrees with itself on the album grid", async () => {
    for (const raw of [
      "artist:contains:daft",
      "completion:eq:incomplete",
      "completion:eq:unknown",
      "hasCover:is:false",
      "verification:eq:mismatch",
      "schema:eq:behind",
      "format:in:opus|flac",
      "score:between:0|100",
      "year:gte:2000,artist:eq:Unknown Artist",
    ]) {
      const grid = await albumGrid({ filters: albumTree(raw) });
      expect(grid.albums.length, raw).toBe(grid.total);
    }
  });

  it("reads the states off the columns they are actually stored in", async () => {
    const only = async (raw: string): Promise<string[]> =>
      (await albumGrid({ filters: albumTree(raw) })).albums.map((album) => album.id).sort();

    // A known total we do not hold all of. Currents is 40/40 but its total is our own row
    // count, so it is neither complete nor incomplete — it is unknown, and stays out of both.
    expect(await only("completion:eq:incomplete")).toEqual(["alb_home"]);
    expect(await only("completion:eq:unknown")).toEqual(["alb_curr"]);
    expect(await only("completion:eq:complete")).toEqual(["alb_disc", "alb_untag"]);

    expect(await only("hasCover:is:false")).toEqual(["alb_home", "alb_untag"]);
    expect(await only("tagged:is:false")).toEqual(["alb_untag"]);
    expect(await only("verification:eq:ok")).toEqual(["alb_disc"]);
    expect(await only("verification:eq:mismatch")).toEqual(["alb_home"]);
    expect(await only("verification:eq:unverified")).toEqual(["alb_curr", "alb_untag"]);
    expect(await only("format:eq:flac")).toEqual(["alb_home"]);
    expect(await only("missingFiles:is:true")).toEqual([
      "alb_curr",
      "alb_disc",
      "alb_home",
      "alb_untag",
    ]);
    // Every album has files behind the schema, so "current" holds nobody.
    expect(await only("schema:eq:current")).toEqual([]);
  });

  it("reads the document facts it offers on tracks", async () => {
    const lyrics = await trackList({ filters: trackTree("hasLyrics:is:true"), limit: 1_000 });
    expect(lyrics.total).toBe(80);
    expect(lyrics.tracks.every((track) => track.hasLyrics)).toBe(true);

    const none = await trackList({ filters: trackTree("hasLyrics:is:false"), limit: 1_000 });
    expect(none.total).toBe(80);
    expect(none.tracks.some((track) => track.hasLyrics)).toBe(false);

    // ReplayGain is nowhere in these documents, so "has it" is empty and "has not" is all.
    expect((await trackList({ filters: trackTree("hasReplayGain:is:true") })).total).toBe(0);
    expect((await trackList({ filters: trackTree("hasReplayGain:is:false") })).total).toBe(160);
  });

  it("filters a track's completeness on the number its own badge shows", async () => {
    const everything = await trackList({ limit: 1_000 });
    const scores = [
      ...new Set(
        everything.tracks.map((track) => track.score).filter((s): s is number => s !== null),
      ),
    ].sort((a, b) => a - b);
    // The fixture has two document shapes, so there are two distinct scores to cut between.
    expect(scores.length).toBeGreaterThan(1);
    const cut = ((scores[0] ?? 0) + (scores[1] ?? 0)) / 2;

    const page = await trackList({
      filters: trackTree(`score:gte:${String(cut * 100)}`),
      limit: 1_000,
    });
    const expected = everything.tracks.filter((track) => (track.score ?? -1) >= cut);

    // The column the SQL reads and the number the badge prints are the same fact, so the
    // filter selects exactly the rows a reader would have picked out by eye.
    expect(expected.length).toBeGreaterThan(0);
    expect(page.total).toBe(expected.length);
    expect(page.tracks.map((track) => track.id).sort()).toEqual(
      expected.map((track) => track.id).sort(),
    );
  });

  it("filters the artists page over its own aggregates", async () => {
    expect((await artistList()).map((artist) => artist.name)).toEqual([
      "Daft Punk",
      "Tame Impala",
      "Unknown Artist",
    ]);

    const tree = (raw: string) => {
      const decoded = decodeFilter(raw, ARTIST_FILTER_FIELDS);
      expect(decoded.error, `"${raw}": ${decoded.error ?? ""}`).toBeNull();
      return decoded.tree;
    };

    expect((await artistList({ filters: tree("albums:gte:2") })).map((a) => a.name)).toEqual([
      "Daft Punk",
    ]);
    expect((await artistList({ filters: tree("hasImage:is:true") })).map((a) => a.name)).toEqual([
      "Daft Punk",
    ]);
    expect((await artistList({ filters: tree("country:eq:fr") })).map((a) => a.name)).toEqual([
      "Daft Punk",
    ]);
    // An `or` across two aggregates of the same grouped row — the shape the bar can grow into.
    expect(
      (await artistList({ filters: tree("tracks:gte:80,name:contains:impala") })).map(
        (a) => a.name,
      ),
    ).toEqual(["Daft Punk", "Tame Impala"]);
  });

  it("is the unfiltered page when the tree is empty", async () => {
    const plain = await trackList({ limit: 1_000 });
    const empty = await trackList({
      filters: decodeFilter("", TRACK_FILTER_FIELDS).tree,
      limit: 1_000,
    });
    expect(empty.total).toBe(plain.total);
    expect(empty.tracks.map((track) => track.id)).toEqual(plain.tracks.map((track) => track.id));

    const grid = await albumGrid();
    expect(grid.total).toBe(4);
    expect(grid.albums).toHaveLength(4);
    expect(grid.counts.all).toBe(4);
  });

  it("keeps the chip counts and the chip's own rows on one number", async () => {
    const counts = (await albumGrid()).counts;
    for (const chip of ["incomplete", "untagged", "nocover", "ytcover", "schema"] as const) {
      const grid = await albumGrid({ filter: chip });
      expect(grid.total, chip).toBe(counts[chip]);
      expect(grid.albums.length, chip).toBe(counts[chip]);
    }

    const trackCounts = (await trackList()).counts;
    for (const chip of ["nolyrics", "noreplaygain", "schema", "untagged"] as const) {
      const page = await trackList({ filter: chip, limit: 1_000 });
      expect(page.total, chip).toBe(trackCounts[chip]);
      expect(page.tracks.length, chip).toBe(trackCounts[chip]);
    }
  });

  it("narrows to one album before it pages, not after", async () => {
    const page = await trackList({ albumId: "alb_disc", limit: 10 });
    expect(page.total).toBe(40);
    expect(page.tracks).toHaveLength(10);
    expect(page.tracks.every((track) => track.albumId === "alb_disc")).toBe(true);
  });

  it("combines the search box, a chip and the tree as one and", async () => {
    const page = await trackList({
      search: "Discovery",
      filter: "schema",
      filters: trackTree("format:eq:opus"),
      limit: 1_000,
    });
    expect(page.total).toBe(10);
    expect(page.tracks).toHaveLength(10);
    expect(page.tracks.every((track) => track.albumTitle === "Discovery")).toBe(true);
  });
});
