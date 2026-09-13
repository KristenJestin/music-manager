/**
 * `writeArtistImageSidecar` — no network, no database: a fake `db` answers the one query it
 * makes (`artists_cache` by name) and a fake toolbox stands in for `/artwork/prepare`, so this
 * is a test of the write contract (§3) rather than of Wikimedia or Pillow.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathMap, type PathMap } from "#/server/paths.ts";
import { writeArtistImageSidecar } from "./artist-image.ts";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** A `db` that answers `select … from artists_cache where lower(name) = lower($1) limit 1`. */
function fakeDb(imageUrl: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(imageUrl === null ? [] : [{ imageUrl }]),
        }),
      }),
    }),
  };
}

function fakeToolbox(options: { fail?: boolean } = {}) {
  return {
    prepareArtwork: async () => {
      if (options.fail === true) throw new Error("artwork fetch failed");
      return { data_base64: JPEG_BYTES.toString("base64"), mime: "image/jpeg" };
    },
  };
}

let library: string;
let paths: PathMap;

beforeEach(() => {
  library = mkdtempSync(join(tmpdir(), "mm-artist-image-"));
  paths = pathMap({ host: library, container: "/library" });
});

afterEach(() => {
  rmSync(library, { recursive: true, force: true });
});

describe("writeArtistImageSidecar", () => {
  it("writes artist.jpg from artists_cache.imageUrl", async () => {
    const result = await writeArtistImageSidecar({
      db: fakeDb("https://commons.wikimedia.org/example.jpg") as never,
      toolbox: fakeToolbox() as never,
      paths,
      artistName: "Daft Punk",
      artistFolder: "Daft Punk",
      size: 600,
      enabled: true,
    });
    expect(result.outcome).toBe("written");
    const target = join(library, "Daft Punk", "artist.jpg");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target)).toEqual(JPEG_BYTES);
    // No temp file left behind.
    expect(readdirSync(join(library, "Daft Punk")).filter((n) => n !== "artist.jpg")).toEqual([]);
  });

  it("never overwrites an existing artist.jpg", async () => {
    const folder = join(library, "Daft Punk");
    mkdirSync(folder, { recursive: true });
    const target = join(folder, "artist.jpg");
    writeFileSync(target, "already here");

    const result = await writeArtistImageSidecar({
      db: fakeDb("https://commons.wikimedia.org/example.jpg") as never,
      toolbox: fakeToolbox() as never,
      paths,
      artistName: "Daft Punk",
      artistFolder: "Daft Punk",
      size: 600,
      enabled: true,
    });
    expect(result.outcome).toBe("exists");
    expect(readFileSync(target, "utf8")).toBe("already here");
  });

  it("never throws on a download error, and says why", async () => {
    const result = await writeArtistImageSidecar({
      db: fakeDb("https://commons.wikimedia.org/example.jpg") as never,
      toolbox: fakeToolbox({ fail: true }) as never,
      paths,
      artistName: "Daft Punk",
      artistFolder: "Daft Punk",
      size: 600,
      enabled: true,
    });
    expect(result.outcome).toBe("error");
    expect(result.error).toContain("artwork fetch failed");
    expect(existsSync(join(library, "Daft Punk", "artist.jpg"))).toBe(false);
  });

  it("does nothing when the setting is off", async () => {
    const result = await writeArtistImageSidecar({
      db: fakeDb("https://commons.wikimedia.org/example.jpg") as never,
      toolbox: fakeToolbox() as never,
      paths,
      artistName: "Daft Punk",
      artistFolder: "Daft Punk",
      size: 600,
      enabled: false,
    });
    expect(result.outcome).toBe("disabled");
    expect(existsSync(join(library, "Daft Punk", "artist.jpg"))).toBe(false);
  });

  it("skips a compilation artist", async () => {
    const result = await writeArtistImageSidecar({
      db: fakeDb("https://commons.wikimedia.org/example.jpg") as never,
      toolbox: fakeToolbox() as never,
      paths,
      artistName: "Various Artists",
      artistFolder: "Various Artists",
      size: 600,
      enabled: true,
    });
    expect(result.outcome).toBe("compilation");
  });

  it("does nothing when artists_cache has no image for this artist", async () => {
    const result = await writeArtistImageSidecar({
      db: fakeDb(null) as never,
      toolbox: fakeToolbox() as never,
      paths,
      artistName: "Nobody",
      artistFolder: "Nobody",
      size: 600,
      enabled: true,
    });
    expect(result.outcome).toBe("no-image");
  });
});
