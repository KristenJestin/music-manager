/**
 * The manual override against a real Postgres.
 *
 * The unit test next door proves the gate refuses the wrong input; this proves the *wiring*,
 * which is where an override actually breaks. Four things have to be true and none of them can
 * be shown without a database:
 *
 *  1. a typed value **survives a rebuild** — that is the entire promise, and it depends on
 *     `documents.build` re-reading its locks from the very row this service writes. Two keys
 *     point at that row (`import_track_id` and `library_track_id`) and writing the wrong one
 *     would look perfect on the page and be silently undone by the next re-tag;
 *  2. **unlocking really unlocks** — the field is gone from the document and the rebuild owns
 *     it again, rather than a flag being cleared under a value that keeps winning;
 *  3. an album-scope field lands on **every track**, so §2.7's one-value-per-album is a fact
 *     about the rows rather than a hope about the next run;
 *  4. the **denormalised columns** follow, because the grids read those and not the document.
 *
 * It skips itself when there is no Postgres, like every `*.integration.test.ts` here. No
 * toolbox is needed: everything below is offline by construction.
 */
import { dirname, join, resolve } from "node:path";
import type { TrackDocument } from "@mm/domain";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_ovtest`;
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
if (unavailable !== null) console.log(`  (override integration tests skipped: ${unavailable})`);

// Before anything reads it: `serverEnv()` is lazy but cached, and every service below resolves
// its database through it.
process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const { eq } = await import("drizzle-orm");
const schema = await import("#/server/db/schema/index.ts");
const { field, projectDocument, TAG_SCHEMA_VERSION } = await import("@mm/domain");
const { projectionHash } = await import("./jobs/steps/tag.ts");

const { overrideAlbumFields, overrideTrackFields } = await import("./overrides.ts");
const { rebuild } = await import("./documents.ts");

resetServerEnv();

const AT = "2026-09-01T00:00:00.000Z";

/** A document with just enough in it that a change is visible and a rebuild is cheap. */
function document(overrides: Record<string, unknown> = {}): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {};
  const put = (name: string, value: unknown): void => {
    fields[name] = field(value as never, "musicbrainz", AT);
  };
  put("title", "One More Time");
  put("artist", "Daft Punk");
  put("album", "Discovery");
  put("albumartist", "Daft Punk");
  put("tracknumber", 1);
  put("genre", ["house"]);
  for (const [name, value] of Object.entries(overrides)) put(name, value);
  return { fields, na: {}, schemaVersion: TAG_SCHEMA_VERSION };
}

/**
 * One album, two tracks, each with an import behind it and a stored document.
 *
 * Built by hand rather than by running the pipeline: what is under test is the override, and a
 * fixture import would make the failure of one look like the failure of the other.
 */
async function seedAlbum(suffix: string): Promise<{
  albumId: string;
  trackIds: [string, string];
  importTrackIds: [string, string];
}> {
  const database = db();
  const albumId = `alb_${suffix}`;
  const importId = `imp_${suffix}`;

  await database.insert(schema.libraryAlbums).values({
    id: albumId,
    albumArtist: "Daft Punk",
    title: "Discovery",
    year: 2001,
    folder: `Daft Punk/Discovery (2001) ${suffix}`,
    trackCount: 2,
    presentCount: 2,
  });

  await database.insert(schema.imports).values({
    id: importId,
    url: `fixture://discovery?${suffix}`,
    kind: "album",
  });

  const trackIds: string[] = [];
  const importTrackIds: string[] = [];
  for (const position of [1, 2]) {
    const importTrackId = `itr_${suffix}${String(position)}`;
    const trackId = `ltr_${suffix}${String(position)}`;
    await database.insert(schema.importTracks).values({
      id: importTrackId,
      importId,
      position,
      videoId: `vid${suffix}${String(position)}`,
      url: `https://youtu.be/vid${suffix}${String(position)}`,
      sourceTitle: `Track ${String(position)}`,
      role: "mapped",
      trackPosition: position,
      mediumPosition: 1,
    });
    await database.insert(schema.libraryTracks).values({
      id: trackId,
      albumId,
      title: `Track ${String(position)}`,
      artist: "Daft Punk",
      discNumber: 1,
      trackNumber: position,
      path: `Daft Punk/Discovery (2001) ${suffix}/0${String(position)} Track.opus`,
      importId,
      importTrackId,
    });
    const seeded = document({ title: `Track ${String(position)}`, tracknumber: position });
    await database.insert(schema.metadataDocuments).values({
      id: `doc_${suffix}${String(position)}`,
      importTrackId,
      libraryTrackId: trackId,
      document: seeded as unknown as Record<string, unknown>,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      /*
       * The hash of what the file holds, exactly as the `tag` step stamps it after mutagen has
       * written and read the block back. Seeding it is what makes this fixture a *placed*
       * track rather than a row nobody ever wrote a file for — and it is what lets the
       * override's re-tag be tested honestly: the run is opened because the new document no
       * longer projects to this hash, not because the override always opens one.
       */
      projectionHash: projectionHash(projectDocument(seeded, "vorbis")),
    });
    trackIds.push(trackId);
    importTrackIds.push(importTrackId);
  }

  return {
    albumId,
    trackIds: trackIds as [string, string],
    importTrackIds: importTrackIds as [string, string],
  };
}

async function storedFor(importTrackId: string): Promise<TrackDocument> {
  const [row] = await db()
    .select()
    .from(schema.metadataDocuments)
    .where(eq(schema.metadataDocuments.importTrackId, importTrackId))
    .limit(1);
  return row?.document as unknown as TrackDocument;
}

/** No worker in this process, so nothing may be queued — the retag run row is enough. */
const noRetag = { retag: false as const };

describe.skipIf(unavailable !== null)("manual overrides against a real database", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();
  }, 120_000);

  it("writes a typed value locked, from the console, and keeps it through a rebuild", async () => {
    const { trackIds, importTrackIds } = await seedAlbum("A1");

    const result = await overrideTrackFields(
      trackIds[0],
      [{ field: "title", value: "One More Time (Radio Edit)" }],
      noRetag,
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ vorbis: "TITLE", action: "set", tracks: 1 });

    const written = await storedFor(importTrackIds[0]);
    expect(written.fields["title"]).toMatchObject({
      value: "One More Time (Radio Edit)",
      source: "console",
      locked: true,
    });
    expect(written.fields["title"]?.note).toMatch(/set in the Console/);

    /*
     * The point of the whole feature. `rebuild` re-resolves from the raw cache, which here is
     * empty, and re-injects the locks it reads back off *this* row — so if the write had gone
     * to the wrong key the title would silently revert.
     */
    await rebuild(importTrackIds[0]);
    const rebuilt = await storedFor(importTrackIds[0]);
    expect(rebuilt.fields["title"]).toMatchObject({
      value: "One More Time (Radio Edit)",
      locked: true,
    });
  });

  it("updates the denormalised columns, because the grids read those and not the document", async () => {
    const { trackIds } = await seedAlbum("A2");

    await overrideTrackFields(
      trackIds[0],
      [{ field: "artist", value: "Daft Punk feat. Romanthony" }],
      noRetag,
    );

    const [row] = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.id, trackIds[0]))
      .limit(1);
    expect(row?.artist).toBe("Daft Punk feat. Romanthony");
  });

  it("moves the library row's position, and refuses a position another file holds", async () => {
    const { trackIds } = await seedAlbum("A3");

    await expect(
      overrideTrackFields(trackIds[0], [{ field: "tracknumber", value: "2" }], noRetag),
    ).rejects.toThrow(/already/i);

    await overrideTrackFields(trackIds[0], [{ field: "tracknumber", value: "7" }], noRetag);
    const [row] = await db()
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.id, trackIds[0]))
      .limit(1);
    expect(row?.trackNumber).toBe(7);
  });

  it("hands the field back to the resolvers when it is released", async () => {
    const { trackIds, importTrackIds } = await seedAlbum("A4");

    await overrideTrackFields(trackIds[0], [{ field: "title", value: "Typed" }], noRetag);
    expect((await storedFor(importTrackIds[0])).fields["title"]?.source).toBe("console");

    const released = await overrideTrackFields(
      trackIds[0],
      [{ field: "title", value: null, locked: false }],
      noRetag,
    );
    expect(released.changed[0]).toMatchObject({ action: "released" });

    /*
     * The raw cache is empty here, so the rebuild has nothing to put back — and that is the
     * honest outcome: the field is *gone*, not left behind unlocked at the head of the source
     * precedence where it would go on winning for ever.
     */
    const after = await storedFor(importTrackIds[0]);
    expect(after.fields["title"]).toBeUndefined();
  });

  it("pins what the sources say without changing the value, or its source", async () => {
    const { trackIds, importTrackIds } = await seedAlbum("A5");

    await overrideTrackFields(
      trackIds[0],
      [{ field: "title", value: null, locked: true }],
      noRetag,
    );

    const after = await storedFor(importTrackIds[0]);
    expect(after.fields["title"]).toMatchObject({
      value: "Track 1",
      source: "musicbrainz",
      locked: true,
    });
  });

  it("writes an album-scope field on every track, and the album row with it", async () => {
    const { albumId, importTrackIds } = await seedAlbum("A6");

    const result = await overrideAlbumFields(
      albumId,
      [{ field: "album", value: "Discovery (Remastered)" }],
      noRetag,
    );
    expect(result.changed[0]).toMatchObject({ vorbis: "ALBUM", tracks: 2 });

    for (const importTrackId of importTrackIds) {
      expect((await storedFor(importTrackId)).fields["album"]).toMatchObject({
        value: "Discovery (Remastered)",
        source: "console",
        locked: true,
      });
    }

    const [row] = await db()
      .select()
      .from(schema.libraryAlbums)
      .where(eq(schema.libraryAlbums.id, albumId))
      .limit(1);
    expect(row?.title).toBe("Discovery (Remastered)");
  });

  it("takes a multi-valued album field one value per line", async () => {
    const { albumId, importTrackIds } = await seedAlbum("A7");

    await overrideAlbumFields(albumId, [{ field: "genre", value: "house\nfrench house" }], noRetag);

    for (const importTrackId of importTrackIds) {
      expect((await storedFor(importTrackId)).fields["genre"]?.value).toEqual([
        "house",
        "french house",
      ]);
    }
  });

  /*
   * The invariant §2.7 exists for. An album-scope value written on one track is exactly what
   * makes Navidrome and Plex show one record twice, so the track entry point refuses it and
   * names the album one instead of quietly creating the divergence.
   */
  it("refuses an album-scope field on a single track, and a per-track field on an album", async () => {
    const { albumId, trackIds } = await seedAlbum("A8");

    await expect(
      overrideTrackFields(trackIds[0], [{ field: "genre", value: "techno" }], noRetag),
    ).rejects.toThrow(/album scope/i);

    await expect(
      overrideAlbumFields(albumId, [{ field: "title", value: "Nope" }], noRetag),
    ).rejects.toThrow(/per-track field/i);
  });

  it("refuses a track that no import produced, and says what would be needed", async () => {
    const { albumId } = await seedAlbum("A9");
    const orphan = "ltr_A9orphan";
    await db().insert(schema.libraryTracks).values({
      id: orphan,
      albumId,
      title: "Scanned in",
      path: "Daft Punk/Discovery (2001) A9/99 Scanned.opus",
    });

    await expect(
      overrideTrackFields(orphan, [{ field: "title", value: "Anything" }], noRetag),
    ).rejects.toThrow(/no metadata document/i);
  });

  it("opens a re-tag run over the whole album, not only the files behind the schema", async () => {
    const { albumId } = await seedAlbum("B1");

    const result = await overrideAlbumFields(
      albumId,
      [{ field: "barcode", value: "724384960650" }],
      // No `retag: false` here: the run row is the thing under test. Nothing enqueues it,
      // because `enqueueRetagRun` is only reached when the run has files in scope and this
      // process has no pg-boss — so the assertion is on the row, not on the queue.
      {},
    );

    const [run] = await db()
      .select()
      .from(schema.retagRuns)
      .where(eq(schema.retagRuns.id, result.retagRunId ?? ""))
      .limit(1);
    expect(run).toMatchObject({ scope: "album", targetId: albumId, dryRun: false });
    expect(run?.total).toBe(2);
  });
});
