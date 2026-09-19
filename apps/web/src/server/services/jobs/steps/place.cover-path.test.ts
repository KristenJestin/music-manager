/**
 * `coverPathPatch` — the album's cover path is written when, and only when, the file is there.
 *
 * `albums.cover_path` is what the album page, the cover thumbnail and the Navidrome projection
 * read. It is written at the end of a `place` run, and `place` can run again long after the
 * cover was written — a re-import, a retry, an album whose tracks were extended. The property
 * is therefore not "the path is set", it is **"no path is ever set without a file behind it,
 * and no path that was right is ever cleared by a run that merely did not look"**.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverPathPatch } from "./place.ts";
import type { PathMap } from "#/server/paths.ts";

let root: string;
let paths: PathMap;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mm-cover-"));
  paths = { host: root, container: "/library", workDir: ".mm-work" };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const COVER = "Artist/Album/cover.jpg";

describe("coverPathPatch", () => {
  it("names the cover when the album's own file is there", () => {
    mkdirSync(join(root, "Artist/Album"), { recursive: true });
    writeFileSync(join(root, COVER), "jpeg");
    expect(coverPathPatch(paths, "Artist/Album")).toEqual({ coverPath: COVER });
  });

  it("writes no key at all when there is no file, so a right value survives a run that did not write one", () => {
    expect(coverPathPatch(paths, "Artist/Album")).toEqual({});
  });

  it("clears the column only when the album genuinely has no folder to look in", () => {
    // The one case where `null` is the truth: an album that was not filed under a folder.
    expect(coverPathPatch(paths, null)).toEqual({ coverPath: null });
  });

  it("does not report a sibling album's cover as this one's", () => {
    mkdirSync(join(root, "Artist/Other"), { recursive: true });
    writeFileSync(join(root, "Artist/Other/cover.jpg"), "jpeg");
    expect(coverPathPatch(paths, "Artist/Album")).toEqual({});
  });

  it("does not accept any other file in place of cover.jpg", () => {
    mkdirSync(join(root, "Artist/Album"), { recursive: true });
    writeFileSync(join(root, "Artist/Album/folder.jpg"), "jpeg");
    expect(coverPathPatch(paths, "Artist/Album")).toEqual({});
  });
});
