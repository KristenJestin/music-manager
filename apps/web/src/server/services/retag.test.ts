/**
 * The re-tag, at the level where its decisions live: which projection a file needs, and what
 * the diff between the database and the file actually says.
 *
 * The queue, the batching and the toolbox round trip are exercised end to end by
 * `e2e/quality.spec.ts` against a real stack; what is worth unit-testing is the arithmetic
 * that decides whether a file is written at all — because that is what a dry run promises to
 * show you, and a diff that lies is worse than no diff.
 */
import { describe, expect, it } from "vitest";
import type { ProjectedTag } from "@mm/domain";
import { diffProjection, formatOf, hashProjection, isNoop } from "./retag.ts";

const tag = (key: string, value: string, field = key.toLowerCase()): ProjectedTag => ({
  key,
  value,
  field,
});

describe("formatOf", () => {
  it("maps every container the tag map covers", () => {
    expect(formatOf("A/B/01 T.opus")).toBe("vorbis");
    expect(formatOf("A/B/01 T.flac")).toBe("vorbis");
    expect(formatOf("A/B/01 T.mp3")).toBe("id3v24");
    expect(formatOf("A/B/01 T.m4a")).toBe("mp4");
  });

  it("is case-insensitive, because Windows is", () => {
    expect(formatOf("A/B/01 T.OPUS")).toBe("vorbis");
  });

  /*
   * A guess would be actively harmful: projecting Vorbis names into an unknown container
   * writes a pile of keys nothing reads, and the file would still be stamped as current.
   */
  it("refuses an extension it does not know rather than guessing", () => {
    expect(() => formatOf("A/B/01 T.wma")).toThrow(/no tag format is known/i);
  });
});

describe("diffProjection", () => {
  it("calls a key the file does not have an addition", () => {
    const diff = diffProjection([tag("TITLE", "One More Time")], {});
    expect(diff.added).toEqual([{ key: "TITLE", field: "title", after: "One More Time" }]);
    expect(diff.unchanged).toBe(0);
    expect(isNoop(diff)).toBe(false);
  });

  it("calls an identical key unchanged, and says so in the count", () => {
    const diff = diffProjection([tag("TITLE", "One More Time")], { TITLE: "One More Time" });
    expect(diff.unchanged).toBe(1);
    expect(isNoop(diff)).toBe(true);
  });

  it("reports both sides of a change, so the dry run can show it", () => {
    const diff = diffProjection([tag("ALBUM", "Discovery")], { ALBUM: "Discovery (Remastered)" });
    expect(diff.changed).toEqual([
      { key: "ALBUM", field: "album", before: "Discovery (Remastered)", after: "Discovery" },
    ]);
  });

  it("matches the file's keys case-insensitively — ffprobe upper-cases, mutagen does not", () => {
    const diff = diffProjection([tag("TITLE", "One More Time")], { title: "One More Time" });
    expect(diff.unchanged).toBe(1);
  });

  /*
   * ffprobe reports one string per key, so a repeated Vorbis field comes back joined. The
   * comparison joins ours the same way; the *write* still sends the values separately.
   */
  it("compares a multi-valued field against the joined string the container reports", () => {
    const projected = [tag("GENRE", "house"), tag("GENRE", "electronic")];
    expect(diffProjection(projected, { GENRE: "house; electronic" }).unchanged).toBe(1);
    expect(diffProjection(projected, { GENRE: "house / electronic" }).unchanged).toBe(1);
    expect(diffProjection(projected, { GENRE: "house" }).changed).toHaveLength(1);
  });

  it("does not case-fold: a differently-cased artist is a real difference", () => {
    const diff = diffProjection([tag("ARTIST", "Daft Punk")], { ARTIST: "DAFT PUNK" });
    expect(diff.changed).toHaveLength(1);
  });

  it("reports a key in the file that the projection does not produce", () => {
    const diff = diffProjection([tag("TITLE", "T")], { TITLE: "T", ITUNESADVISORY: "1" });
    expect(diff.removed).toEqual([{ key: "ITUNESADVISORY", before: "1" }]);
  });

  /*
   * The container's own bookkeeping is not a tag of ours, and listing it as "removed" on
   * every single file would make the diff useless by burying the one line that matters.
   */
  it("ignores what the container itself records", () => {
    const diff = diffProjection([tag("TITLE", "T")], {
      TITLE: "T",
      ENCODER: "Lavf60",
      MAJOR_BRAND: "M4A",
      DURATION: "00:05:20",
    });
    expect(diff.removed).toEqual([]);
    expect(isNoop(diff)).toBe(true);
  });

  it("sorts each list by key, so two runs produce the same diff", () => {
    const diff = diffProjection([tag("TITLE", "T"), tag("ALBUM", "A"), tag("ARTIST", "B")], {});
    expect(diff.added.map((entry) => entry.key)).toEqual(["ALBUM", "ARTIST", "TITLE"]);
  });
});

describe("hashProjection", () => {
  it("is stable for the same projection and different for a changed one", () => {
    const a = [tag("TITLE", "One More Time"), tag("ALBUM", "Discovery")];
    const b = [tag("TITLE", "One More Time"), tag("ALBUM", "Homework")];
    expect(hashProjection(a)).toBe(hashProjection(a));
    expect(hashProjection(a)).not.toBe(hashProjection(b));
  });

  it("is short enough to store on every row", () => {
    expect(hashProjection([tag("TITLE", "T")])).toHaveLength(32);
  });
});
