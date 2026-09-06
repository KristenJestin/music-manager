/**
 * The two pure halves of the library scan: the walk, and the tag comparison.
 *
 * `runScan` needs Postgres and the toolbox; what has to be *correct* is what it walks over
 * and what it calls drift, and both are decidable on a temporary directory with no container
 * anywhere. The rest of the scan is bookkeeping around these two.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, field, type TrackDocument } from "@mm/domain";
import { pathMap } from "#/server/paths.ts";
import { AUDIO_EXTENSIONS, compareTags, isAudio, trashFile, walkLibrary } from "./scan.ts";

let root = "";
let trash = "";

function write(relative: string, contents = "x"): void {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mm-scan-"));
  trash = mkdtempSync(join(tmpdir(), "mm-trash-"));

  write("Daft Punk/Discovery (2001)/01 One More Time.opus");
  write("Daft Punk/Discovery (2001)/02 Aerodynamic.opus");
  write("Daft Punk/Discovery (2001)/cover.jpg");
  write("Daft Punk/Discovery (2001)/01 One More Time.lrc");
  write("Birdy/Birdy (2011)/01 Skinny Love.flac");
  write("Various Artists/Unknown/07 track7.mp3");
  // Dot-prefixed: the download staging area lives inside the library on purpose.
  write(".mm-work/imp_123/tmp.opus");
  write(".hidden/whatever.flac");
  write("Daft Punk/Discovery (2001)/notes.txt");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
});

describe("isAudio", () => {
  it("accepts every extension the scan knows and nothing else", () => {
    for (const extension of AUDIO_EXTENSIONS) expect(isAudio(`song${extension}`)).toBe(true);
    expect(isAudio("SONG.OPUS")).toBe(true);
    for (const other of ["cover.jpg", "notes.txt", "song.lrc", "song.opus.part"]) {
      expect(isAudio(other), other).toBe(false);
    }
  });
});

describe("walkLibrary", () => {
  it("finds the audio files, library-relative, with forward slashes", () => {
    const files = walkLibrary(root);
    expect(files.map((file) => file.path)).toEqual([
      "Birdy/Birdy (2011)/01 Skinny Love.flac",
      "Daft Punk/Discovery (2001)/01 One More Time.opus",
      "Daft Punk/Discovery (2001)/02 Aerodynamic.opus",
      "Various Artists/Unknown/07 track7.mp3",
    ]);
  });

  it("never descends into a dot directory, because `.mm-work` is ours", () => {
    const paths = walkLibrary(root).map((file) => file.path);
    expect(paths.some((path) => path.includes(".mm-work"))).toBe(false);
    expect(paths.some((path) => path.startsWith("."))).toBe(false);
  });

  it("skips sidecars and anything that is not audio", () => {
    const paths = walkLibrary(root).map((file) => file.path);
    expect(paths.some((path) => path.endsWith(".jpg"))).toBe(false);
    expect(paths.some((path) => path.endsWith(".lrc"))).toBe(false);
    expect(paths.some((path) => path.endsWith(".txt"))).toBe(false);
  });

  it("carries the size and the modification time, and honours the cap", () => {
    const [first] = walkLibrary(root);
    expect(first?.size).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(first?.modifiedAt ?? ""))).toBe(false);
    expect(walkLibrary(root, 2)).toHaveLength(2);
  });

  it("answers with nothing rather than throwing when the root does not exist", () => {
    expect(walkLibrary(join(root, "nope"))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* drift                                                               */
/* ------------------------------------------------------------------ */

function document(): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {};
  const put = (name: string, value: unknown): void => {
    fields[name] = field(value as never, "musicbrainz", "2026-09-05T00:00:00Z");
  };
  put("title", "One More Time");
  put("album", "Discovery");
  put("albumartist", "Daft Punk");
  put("date", "2001-02-26");
  put("genre", ["house", "electronic"]);
  return { ...emptyDocument(1), fields };
}

describe("compareTags", () => {
  it("says nothing when the file carries exactly what the document projects", () => {
    expect(
      compareTags(document(), {
        TITLE: "One More Time",
        ALBUM: "Discovery",
        ALBUMARTIST: "Daft Punk",
        DATE: "2001-02-26",
        GENRE: ["house", "electronic"],
      }),
    ).toEqual([]);
  });

  it("does not care about key case or about value order", () => {
    expect(
      compareTags(document(), {
        title: "One More Time",
        album: "Discovery",
        albumartist: "Daft Punk",
        date: "2001-02-26",
        genre: ["Electronic", "House"],
      }),
    ).toEqual([]);
  });

  it("reports a hand-edited value, with both sides", () => {
    const drift = compareTags(document(), {
      TITLE: "One More Time",
      ALBUM: "Discovery",
      ALBUMARTIST: "Daft Punk",
      DATE: "2008",
      GENRE: ["house", "electronic"],
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ field: "date", key: "DATE", db: "2001-02-26", file: "2008" });
  });

  it("reports a tag the file lost entirely", () => {
    const drift = compareTags(document(), {
      TITLE: "One More Time",
      ALBUM: "Discovery",
      ALBUMARTIST: "Daft Punk",
      DATE: "2001-02-26",
    });
    expect(drift.map((entry) => entry.key)).toEqual(["GENRE"]);
    expect(drift[0]?.file).toBe("—");
  });

  it("ignores a tag the file carries that the document does not manage", () => {
    const drift = compareTags(document(), {
      TITLE: "One More Time",
      ALBUM: "Discovery",
      ALBUMARTIST: "Daft Punk",
      DATE: "2001-02-26",
      GENRE: ["house", "electronic"],
      ENCODER: "somebody's ripper",
      COMMENT: "hand-written",
    });
    expect(drift).toEqual([]);
  });

  it("never judges lyrics or picture blocks, which ffprobe cannot report comparably", () => {
    const base = document();
    const doc: TrackDocument = {
      ...base,
      fields: {
        ...base.fields,
        lyrics: field(
          { synced: "[00:00.00] la", plain: "la" } as never,
          "lrclib",
          "2026-09-05T00:00:00Z",
        ),
      },
    };
    const drift = compareTags(doc, {
      TITLE: "One More Time",
      ALBUM: "Discovery",
      ALBUMARTIST: "Daft Punk",
      DATE: "2001-02-26",
      GENRE: ["house", "electronic"],
      // ffprobe truncates this; comparing it would flag every single file.
      LYRICS: "[00:00.00] la (truncated by ffprobe…",
    });
    expect(drift).toEqual([]);
  });

  it("splits a multi-line value the way ffprobe folds repeated Vorbis keys", () => {
    expect(
      compareTags(document(), {
        TITLE: "One More Time",
        ALBUM: "Discovery",
        ALBUMARTIST: "Daft Punk",
        DATE: "2001-02-26",
        GENRE: "house\nelectronic",
      }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the trash                                                           */
/* ------------------------------------------------------------------ */

describe("trashFile", () => {
  it("moves the file instead of unlinking it, keeping its library path", () => {
    const map = pathMap({ host: root, container: "/library", workDir: ".mm-work" });
    const relative = "Various Artists/Unknown/07 track7.mp3";
    const moved = trashFile(map, relative, trash, new Date("2026-09-06T01:02:03Z"));

    expect(moved.from).toBe(relative);
    expect(moved.to).toContain("2026-09-06-01-02-03");
    expect(moved.to.replace(/\\/g, "/")).toContain(relative);
    // Gone from the library, still on the disk.
    expect(walkLibrary(root).some((file) => file.path === relative)).toBe(false);
  });

  it("refuses a path that is not there rather than pretending it worked", () => {
    const map = pathMap({ host: root, container: "/library", workDir: ".mm-work" });
    expect(() => trashFile(map, "nope/nothing.opus", trash)).toThrowError(/not on disk/);
  });
});
