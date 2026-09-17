/**
 * Listing a folder of audio files, against a real database and a real toolbox.
 *
 * Four claims, and none of them can be made without real files on a real disk:
 *
 *  1. **a folder lists like a playlist.** Six tagged Opus files become six entries carrying the
 *     title, the exact duration and the tags ffprobe read — in *tracklist* order, not in the
 *     order the directory happened to be in.
 *  2. **the entry remembers where it came from.** `import_tracks.raw` carries the `mm_file`
 *     record `download` adopts from and `documents.ts` rebuilds a document from, months later,
 *     with no network.
 *  3. **every refusal refuses.** A folder outside `adoptSourceRoots`, a folder with no audio, a
 *     file the toolbox cannot read, and a folder that has already been imported. Four different
 *     answers because four different things have to be done about them.
 *  4. **`adoptSourceRoots` is not weakened for a folder.** The same `realpath`-before-
 *     containment check that refuses a single adopted file refuses a folder, and a symlink
 *     planted inside an allowed root does not escape it.
 *
 * The fixture files are built by `fixtures/folder/build-source.ts` — the toolbox's own
 * five-second Opus sample, tagged through `POST /tag`, exactly the way the v1 fixture library
 * is built. They live **inside the library bind mount** because ffprobe runs in the container
 * and has to be able to see them; in production that is what `MM_ADOPT_PATH` is for.
 *
 * Needs postgres and this checkout's toolbox in fixtures mode; skips itself without them.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
/** This test's own library root, inside the shared bind mount so the container can read it. */
const LIBRARY_HOST = join(REPO_ROOT, ".local", "library", ".mm-folder");
const LIBRARY_CONTAINER = "/library/.mm-folder";
/** Deliberately not under the library: the allow-list has to be the thing that opens it. */
const OUTSIDE = join(REPO_ROOT, ".local", "mm-folder-outside");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
const TEST_DB = `${BASE_DB}_folder`;
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
  console.log(`  (folder-import tests skipped: ${unavailable})`);
}

process.env["DATABASE_URL"] = TEST_URL;
process.env["MM_FIXTURES"] = "1";
process.env["MM_LIBRARY_ROOT"] = LIBRARY_HOST;
process.env["MM_TOOLBOX_LIBRARY_ROOT"] = LIBRARY_CONTAINER;

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { drizzle } = await import("drizzle-orm/postgres-js");
const { eq } = await import("drizzle-orm");
const { MMError } = await import("@mm/contracts");
const { resetServerEnv } = await import("#/server/env.ts");
const { db } = await import("#/server/db/client.ts");
const schema = await import("#/server/db/schema/index.ts");
const imports = await import("./imports.ts");
const { listFolder } = await import("./folder-source.ts");
const { folderFileOf } = await import("./folder.record.ts");
const { folderUrl, parseImportSource } = await import("./import-source.ts");
const { resolveSourceFolder } = await import("./adopt.ts");
const settings = await import("./settings.ts");
const { toolbox } = await import("#/server/toolbox/client.ts");
const { pathMap } = await import("#/server/paths.ts");
const { buildFixtureSource, fixtureTags, FIXTURE_ALBUM, FIXTURE_ARTIST, FIXTURE_TRACKS } =
  await import("../../../../../fixtures/folder/build-source.ts");

resetServerEnv();

const paths = pathMap({ host: LIBRARY_HOST, container: LIBRARY_CONTAINER });

/** The code of whatever `run` threw, or `"(no refusal)"` when it did not throw. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "(no refusal)";
  } catch (error) {
    return MMError.from(error).code;
  }
}

describe.skipIf(unavailable !== null)("importing a folder", () => {
  let album = "";
  let junk = "";

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
    rmSync(OUTSIDE, { recursive: true, force: true });
    mkdirSync(LIBRARY_HOST, { recursive: true });
    mkdirSync(OUTSIDE, { recursive: true });

    const built = await buildFixtureSource({
      libraryRoot: LIBRARY_HOST,
      subdir: ".sources",
      toolboxUrl: TOOLBOX_URL,
      containerRoot: LIBRARY_CONTAINER,
    });
    album = built.album;
    junk = built.junk;
  }, 120_000);

  afterAll(async () => {
    rmSync(OUTSIDE, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */
  /* 1 · the listing                                                    */
  /* ---------------------------------------------------------------- */

  it("lists the folder the way a playlist is listed, in tracklist order", async () => {
    const listing = await listFolder(album, {
      paths,
      settings: await settings.loadSettings(db()),
      toolbox: toolbox(),
    });

    expect(listing.entries).toHaveLength(FIXTURE_TRACKS.length);
    expect(listing.skipped).toEqual([]);
    // The tags order them, not the directory: the filenames are deliberately out of order.
    expect(listing.entries.map((entry) => entry.title)).toEqual(
      [...FIXTURE_TRACKS].sort((one, other) => one.track - other.track).map((one) => one.title),
    );
    expect(listing.entries.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(listing.title).toBe(FIXTURE_ALBUM);
    expect(listing.uploader).toBe(FIXTURE_ARTIST);

    const first = listing.entries[0];
    expect(first?.album).toBe(FIXTURE_ALBUM);
    expect(first?.artist).toBe(FIXTURE_ARTIST);
    expect(first?.release_year).toBe(2019);
    // ffprobe's own measurement of the five-second sample, not a rounded YouTube duration.
    expect(first?.duration).toBeGreaterThan(4);
    expect(first?.duration).toBeLessThan(6);
    // Each entry is distinct and stable, so re-resolving matches rows rather than duplicating.
    expect(new Set(listing.entries.map((entry) => entry.id)).size).toBe(FIXTURE_TRACKS.length);
  }, 120_000);

  it("carries the file's provenance and its whole tag set on the entry", async () => {
    const listing = await listFolder(album, {
      paths,
      settings: await settings.loadSettings(db()),
      toolbox: toolbox(),
    });
    const file = folderFileOf(listing.entries[0]);
    expect(file).not.toBeNull();
    expect(file?.folder).toBe(resolve(album));
    expect(file?.name).toBe("A-side.opus");
    expect(file?.container).toBe(".opus");
    expect(file?.codec).toBe("opus");
    expect(file?.bytes).toBeGreaterThan(0);
    // The *whole* tag set, not the four fields the matcher reads: an existing library's files
    // carry more than that, and throwing it away at listing time makes it unrecoverable.
    // Under ffprobe's own names, which is what the record documents: it projects every
    // container onto one vocabulary, so a Vorbis `TRACKNUMBER` arrives here as `TRACK`.
    expect(file?.tags["GENRE"]).toBe("Classical");
    expect(file?.tags["TRACKTOTAL"]).toBe(String(FIXTURE_TRACKS.length));
    expect(file?.tags["TRACK"]).toBe("1");
  }, 120_000);

  /* ---------------------------------------------------------------- */
  /* 2 · resolve, end to end through createImport                       */
  /* ---------------------------------------------------------------- */

  it("resolves a folder into rows a video would have produced", async () => {
    const created = await imports.createImport(album, { db: db() });
    expect(created.job.status).not.toBe("failed");
    expect(created.job.kind).toBe("album");
    expect(created.job.title).toBe(FIXTURE_ALBUM);
    expect(created.job.artist).toBe(FIXTURE_ARTIST);
    // Stored as a `file://` URL: one string in one column, so every filter on it keeps working.
    expect(created.job.url).toBe(folderUrl(resolve(album)));

    const rows = await db()
      .select()
      .from(schema.importTracks)
      .where(eq(schema.importTracks.importId, created.job.id));
    expect(rows).toHaveLength(FIXTURE_TRACKS.length);
    const ordered = [...rows].sort((one, other) => one.position - other.position);
    expect(ordered[0]?.sourceTitle).toBe("Ouverture");
    expect(ordered[0]?.sourceDuration).toBeGreaterThan(4);
    expect(folderFileOf(ordered[0]?.raw)).not.toBeNull();
  }, 120_000);

  it("reports a folder that has already been imported instead of refusing it", async () => {
    const again = await imports.createImport(album, { db: db() });
    expect(again.duplicates.length).toBeGreaterThan(0);
    expect(again.job.status).not.toBe("failed");
  }, 120_000);

  /* ---------------------------------------------------------------- */
  /* 3 · the refusals                                                   */
  /* ---------------------------------------------------------------- */

  it("refuses a folder outside adoptSourceRoots, and accepts it once it is listed", async () => {
    const source = join(OUTSIDE, "album");
    mkdirSync(source, { recursive: true });

    expect(
      await refusalOf(async () =>
        listFolder(source, {
          paths,
          settings: await settings.loadSettings(db()),
          toolbox: toolbox(),
        }),
      ),
    ).toBe("ADOPT_PATH_REFUSED");

    // The allow-list, and only the allow-list, is what opens it. Asserted on the resolver
    // rather than on a full listing because this toolbox has no mount for `OUTSIDE` — which is
    // exactly the production arrangement `MM_ADOPT_PATH` provides.
    await settings.setSetting("adoptSourceRoots", [OUTSIDE], { db: db() });
    expect(resolveSourceFolder(source, [LIBRARY_HOST, OUTSIDE])).toBe(resolve(source));
    await settings.setSetting("adoptSourceRoots", [], { db: db() });
  }, 120_000);

  it("does not let a symlink inside an allowed root point out of it", () => {
    const escape = join(OUTSIDE, "escape");
    rmSync(escape, { recursive: true, force: true });
    let linked = true;
    try {
      symlinkSync(REPO_ROOT, escape, "junction");
    } catch {
      // Creating a symlink needs a privilege Windows does not always grant. The containment
      // rule is still asserted above on the real path; skipping here is honest.
      linked = false;
    }
    if (!linked) return;
    // `realpath` collapses it to the repository root, which is outside every allowed root.
    expect(() => resolveSourceFolder(escape, [OUTSIDE])).toThrow();
    rmSync(escape, { recursive: true, force: true });
  });

  it("refuses a folder with nothing importable in it, and says what it saw", async () => {
    const error = await listFolder(junk, {
      paths,
      settings: await settings.loadSettings(db()),
      toolbox: toolbox(),
    }).catch((caught: unknown) => MMError.from(caught));
    expect(error).toBeInstanceOf(MMError);
    const failure = error as InstanceType<typeof MMError>;
    expect(failure.code).toBe("FOLDER_NO_AUDIO");
    // The JPEG wearing a `.mp3` extension passes the extension test and fails ffprobe, so it
    // is counted as unreadable rather than as "another format".
    expect(failure.details?.["unreadable"]).toHaveLength(1);
    expect(failure.details?.["subdirectories"]).toBe(1);
    expect(failure.details?.["otherFormats"]).toBe(2);
    // Not recursive: the `.opus` one level down was never a candidate.
    expect(failure.hint).toContain("import each album folder");
  }, 120_000);

  it("skips a file the toolbox cannot read and lists the rest", async () => {
    const source = join(LIBRARY_HOST, ".sources", "with-a-bad-file");
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true });
    for (const track of FIXTURE_TRACKS.slice(0, 2)) {
      writeFileSync(join(source, track.file), "");
    }
    // Two empty files and one real one: the real one has to survive the other two.
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(album, "04.opus"), join(source, "04.opus"));
    // An empty file is zero bytes, which ffprobe refuses — the honest "unreadable" case.
    writeFileSync(join(source, "truncated.opus"), "");

    const listing = await listFolder(source, {
      paths,
      settings: await settings.loadSettings(db()),
      toolbox: toolbox(),
    });
    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0]?.title).toBe("Adagio");
    expect(listing.skipped.length).toBeGreaterThanOrEqual(3);
    expect(listing.skipped.every((file) => file.reason !== "")).toBe(true);
    rmSync(source, { recursive: true, force: true });
  }, 120_000);

  it("refuses a relative path before it touches the disk", () => {
    // A relative source would mean a different folder in `bun run dev`, in the image and in a
    // cron job. The refusal names the reason in the hint, which is what the caller reads.
    let refused: InstanceType<typeof MMError> | null = null;
    try {
      parseImportSource("./musique/album");
    } catch (error) {
      refused = MMError.from(error);
    }
    expect(refused?.code).toBe("INVALID_INPUT");
    expect(refused?.hint ?? "").toMatch(/absolute/i);
    expect(() => parseImportSource("")).toThrow();
    // A URL is still a URL.
    expect(parseImportSource("https://youtu.be/abc").kind).toBe("remote");
    expect(parseImportSource("fixture://discovery").kind).toBe("remote");
  });

  it("round-trips a path through its file:// form", () => {
    const parsed = parseImportSource(album);
    expect(parsed.kind).toBe("folder");
    expect(parsed.url.startsWith("file:///")).toBe(true);
    expect(parseImportSource(parsed.url).url).toBe(parsed.url);
    // Accents and spaces are readable rather than percent-encoded: this string is what the
    // Console's job list, `mm jobs` and the journal show.
    expect(parsed.url).toContain(FIXTURE_ALBUM.replace(/ /g, " "));
  });

  it("the library root itself is always an allowed root", () => {
    expect(existsSync(album)).toBe(true);
    expect(resolveSourceFolder(album, [LIBRARY_HOST])).toBe(resolve(album));
  });

  /* ---------------------------------------------------------------- */
  /* 4 · what the files already know                                    */
  /* ---------------------------------------------------------------- */

  it("pins the release the files agree on, and marks it as read rather than asserted", async () => {
    const source = join(LIBRARY_HOST, ".sources", "already-tagged");
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true });
    const { copyFileSync } = await import("node:fs");
    const known = "b84ee12a-09ef-421b-82de-0441a926375b";
    for (const track of FIXTURE_TRACKS.slice(0, 3)) {
      copyFileSync(join(album, track.file), join(source, track.file));
      await tag(`${LIBRARY_CONTAINER}/.sources/already-tagged/${track.file}`, [
        ...fixtureTags(track),
        { key: "MUSICBRAINZ_ALBUMID", value: known },
      ]);
    }

    const listing = await listFolder(source, {
      paths,
      settings: await settings.loadSettings(db()),
      toolbox: toolbox(),
    });
    expect(listing.releaseMbidHint).toBe(known);

    const created = await imports.createImport(source, { db: db() });
    const [row] = await db()
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, created.job.id));
    expect(row?.options.releaseMbid).toBe(known);
    // Marked as an inference: MusicBrainz not producing it must fall back to the files' own
    // tags, where a release somebody *typed* would rightly block and ask.
    expect(row?.options.releaseMbidFromTags).toBe(true);
    rmSync(source, { recursive: true, force: true });
  }, 120_000);
});

/** `POST /tag` on a file of the fixture folder, the way `build-source.ts` writes them. */
async function tag(
  containerPath: string,
  tags: readonly { key: string; value: string }[],
): Promise<void> {
  const response = await fetch(`${TOOLBOX_URL}/tag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: containerPath,
      format: "auto",
      tags,
      pictures: [],
      lyrics_lrc: null,
      sidecar_lrc: false,
      clear: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`/tag failed: HTTP ${String(response.status)}`);
}
