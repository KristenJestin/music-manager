/**
 * `placedArtistImage` — the `artist.jpg` sidecar behind `GET /api/artist-image`.
 *
 * Bug: the artists page never passed `<Cover>` a `src`, so no artist ever showed a picture
 * even when `artists_cache.imageUrl` had one. Fixing the tile meant a local candidate too,
 * modelled on `placedCover`/`GET /api/cover` — but no importer actually writes `artist.jpg` to
 * disk yet (`packages/domain/src/paths/index.ts`'s `sidecarPaths().artistImage` is a computed
 * path with nothing behind it), and the fixture library's `artists_cache` rows never get an
 * `imageUrl` either: the match step's offline gateway (`jobs/steps/match.ts`, `gatewayFor`)
 * never seeds a `musicbrainz artist/<mbid>` cache row for `fixture://discovery`, so
 * `rememberArtist` (`services/documents.ts`) always sees a cache miss and moves on. There is
 * therefore no browser-visible fixture to assert an `<img>` against in `e2e/library.spec.ts`,
 * and this is the unit-level proof instead: `placedArtistImage` resolves the artist's *actual*
 * on-disk folder (the first segment of `library_albums.folder`, exactly what `place` wrote)
 * rather than re-deriving it from the name, finds the file when it is there, and answers
 * `null` — the endpoint's 404 — otherwise.
 *
 * Needs a database, like its neighbours; self-skips without one.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-artist-image-test");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_artistimg`;
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
if (unavailable !== null) {
  console.log(`  (placedArtistImage tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = "/library/.mm-artist-image-test";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const { placedArtistImage } = await import("./library.ts");

resetServerEnv();

describe.skipIf(unavailable !== null)("placedArtistImage", () => {
  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    rmSync(LIBRARY_HOST, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
  }, 60_000);

  afterAll(() => {
    rmSync(LIBRARY_HOST, { recursive: true, force: true });
  });

  it("answers null for an artist the library has never heard of", async () => {
    expect(await placedArtistImage("Nobody", db())).toBeNull();
  });

  it("answers null when the artist has albums but no artist.jpg beside their folder", async () => {
    await db().insert(schema.libraryAlbums).values({
      id: randomUUID(),
      albumArtist: "Boards of Canada",
      title: "Music Has the Right to Children",
      folder: "Boards of Canada/Music Has the Right to Children (1998)",
    });
    expect(await placedArtistImage("Boards of Canada", db())).toBeNull();
  });

  it("finds the artist.jpg placed beside the artist's real folder, not a re-sanitised name", async () => {
    await db().insert(schema.libraryAlbums).values({
      id: randomUUID(),
      albumArtist: "Daft Punk",
      title: "Discovery",
      // The on-disk folder can legitimately differ from a fresh sanitisation of the name
      // (a different sanitise mode when it was placed, for instance) — placedArtistImage
      // must follow the row, not recompute it.
      folder: "Daft Punk (FR)/Discovery (2001)",
    });
    mkdirSync(join(LIBRARY_HOST, "Daft Punk (FR)"), { recursive: true });
    writeFileSync(join(LIBRARY_HOST, "Daft Punk (FR)", "artist.jpg"), Buffer.from([0xff, 0xd8]));

    const image = await placedArtistImage("Daft Punk", db());
    expect(image).not.toBeNull();
    expect(image?.contentType).toBe("image/jpeg");
    expect(image?.bytes).toBe(2);
    expect(image?.file.replaceAll("\\", "/")).toContain("Daft Punk (FR)/artist.jpg");
  });
});
