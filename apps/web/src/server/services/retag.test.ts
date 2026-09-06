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

  /*
   * Found by running `mm retag --dry-run` over an album tagged minutes earlier and getting
   * "14 changed". ffmpeg's Ogg demuxer renames three of our keys before ffprobe reports them,
   * so every file showed three phantom additions and three phantom removals — the exact kind
   * of lie that makes a dry run worthless.
   */
  describe("the three keys ffprobe renames", () => {
    const projected = [
      tag("ALBUMARTIST", "Daft Punk", "albumartist"),
      tag("TRACKNUMBER", "1", "tracknumber"),
      tag("DISCNUMBER", "1", "discnumber"),
    ];
    const asProbed = { ALBUM_ARTIST: "Daft Punk", TRACK: "1", DISC: "1" };

    it("recognises them rather than reporting six phantom changes", () => {
      const diff = diffProjection(projected, asProbed);
      expect(diff.unchanged).toBe(3);
      expect(isNoop(diff)).toBe(true);
    });

    it("still reports a real difference under the renamed key", () => {
      const diff = diffProjection(projected, { ...asProbed, ALBUM_ARTIST: "Stardust" });
      expect(diff.changed).toEqual([
        {
          key: "ALBUMARTIST",
          field: "albumartist",
          before: "Stardust",
          after: "Daft Punk",
        },
      ]);
    });

    /*
     * `TRACKTOTAL` and `TOTALTRACKS` are two keys we genuinely write, and ffprobe reports both
     * verbatim. Nothing about the alias table may touch them.
     */
    it("leaves the totals alone, which ffprobe does not rename", () => {
      const diff = diffProjection(
        [tag("TRACKTOTAL", "14", "totaltracks"), tag("TOTALTRACKS", "14", "totaltracks")],
        { TRACKTOTAL: "14", TOTALTRACKS: "14" },
      );
      expect(diff.unchanged).toBe(2);
      expect(isNoop(diff)).toBe(true);
    });

    it("does not consume an alias that is itself a key we write", () => {
      // If we ever projected a literal `TRACK`, it is a tag in its own right and the alias
      // must not steal its value away from `TRACKNUMBER`.
      const diff = diffProjection(
        [tag("TRACKNUMBER", "1", "tracknumber"), tag("TRACK", "One More Time", "track")],
        { TRACK: "One More Time" },
      );
      expect(diff.added.map((entry) => entry.key)).toEqual(["TRACKNUMBER"]);
      expect(diff.unchanged).toBe(1);
    });
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
