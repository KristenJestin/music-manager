/**
 * The two decisions `/api/cover` and `/api/artist-image` make before any pixel is touched:
 * **which sizes exist**, and **what a cached variant is called**.
 *
 * Both are security-shaped as much as they are correctness-shaped. A `size` that accepted an
 * integer would let anyone with a session fill `.mm-cache/images/` with ten thousand JPEGs and
 * an hour of Pillow, one request at a time; a key that left the original's mtime out would
 * serve yesterday's cover for ever after a re-tag. Neither failure shows up in a screenshot,
 * so they are asserted here.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_VARIANT_SIZES,
  parseImageSize,
  variantKey,
  type VariantSource,
} from "./image-variants.ts";

const source: VariantSource = {
  file: "D:/library/Daft Punk/Discovery (2001)/cover.jpg",
  bytes: 1_048_576,
  mtimeMs: 1_700_000_000_000,
};

describe("the size parameter", () => {
  it("accepts the four widths and the original, and nothing else", () => {
    expect(parseImageSize("64")).toBe(64);
    expect(parseImageSize("160")).toBe(160);
    expect(parseImageSize("320")).toBe(320);
    expect(parseImageSize("640")).toBe(640);
    expect(parseImageSize("original")).toBe("original");
    expect([...IMAGE_VARIANT_SIZES]).toEqual([64, 160, 320, 640]);
  });

  it("means the whole file when it is not there at all", () => {
    // Every link written before this parameter existed keeps answering what it used to.
    expect(parseImageSize(null)).toBe("original");
    expect(parseImageSize(undefined)).toBe("original");
  });

  it("refuses anything outside the set rather than rounding it", () => {
    // A caller asking for 321 pixels has a bug, and answering 320 hides it. More to the
    // point: an accepted integer is a cache anyone can turn into thousands of files.
    for (const bad of ["", "0", "65", "321", "1200", "-64", "64.0", "64px", "abc", "1e2"]) {
      expect(parseImageSize(bad), `size=${bad} must be a 400`).toBeNull();
    }
  });
});

describe("the variant cache key", () => {
  it("is stable for the same file at the same size", () => {
    expect(variantKey(source, 320)).toBe(variantKey({ ...source, file: source.file }, 320));
  });

  it("names the size and ends in .jpg, so the directory reads", () => {
    expect(variantKey(source, 160)).toMatch(/^160-[0-9a-f]{32}\.jpg$/);
    expect(variantKey(source, 64)).toMatch(/^64-[0-9a-f]{32}\.jpg$/);
  });

  it("changes when the original is rewritten", () => {
    // A re-tag rewrites cover.jpg: the mtime moves, the key moves with it, and every
    // thumbnail derived from the old bytes is simply never asked for again. Nothing has to
    // invalidate anything.
    const retagged = { ...source, mtimeMs: source.mtimeMs + 1 };
    expect(variantKey(retagged, 320)).not.toBe(variantKey(source, 320));

    // Same instant, different length — a rewrite fast enough to keep the mtime still moves.
    const longer = { ...source, bytes: source.bytes + 1 };
    expect(variantKey(longer, 320)).not.toBe(variantKey(source, 320));
  });

  it("separates the sizes and the albums", () => {
    const keys = IMAGE_VARIANT_SIZES.map((size) => variantKey(source, size));
    expect(new Set(keys).size).toBe(IMAGE_VARIANT_SIZES.length);

    const other = { ...source, file: "D:/library/Daft Punk/Homework (1997)/cover.jpg" };
    expect(variantKey(other, 320)).not.toBe(variantKey(source, 320));
  });

  it("is the same key whichever separator the host uses", () => {
    // `hostPath` hands back `D:\…` on Windows and `/…` elsewhere for the same file. A key
    // that disagreed with itself between the two would regenerate every variant on a move.
    const windows = { ...source, file: "D:\\library\\Daft Punk\\Discovery (2001)\\cover.jpg" };
    expect(variantKey(windows, 320)).toBe(variantKey(source, 320));
  });
});
