/**
 * The ladder that decides `library_albums.track_count`, exercised without a database.
 *
 * The bug this file exists for was not arithmetic, it was a *definition*: `track_count` and
 * `present_count` were the same expression, so `1/1` was printed over an album holding one
 * track of thirteen. The three rungs below are the fix, and the property that matters in every
 * one of them is that the denominator is never silently the numerator — it is either counted
 * from something, or declared unknown.
 */
import { describe, expect, it } from "vitest";
import type { MbRelease } from "@mm/domain";
import {
  albumCounters,
  documentTotalsOf,
  totalFromDocuments,
  totalFromRelease,
  totalIsKnown,
  type DocumentTotals,
} from "./album-counters.ts";

function release(...mediumCounts: number[]): MbRelease {
  return {
    id: "d073287b-d1bd-4f11-a933-a4386f8cf701",
    media: mediumCounts.map((count, index) => ({
      position: index + 1,
      "track-count": count,
    })),
  } as unknown as MbRelease;
}

function doc(discNumber: number | null, totalTracks: number | null, totalDiscs: number | null) {
  return { discNumber, totalTracks, totalDiscs } satisfies DocumentTotals;
}

/* ------------------------------------------------------------------ */
/* rung 1 — the release                                                */
/* ------------------------------------------------------------------ */

describe("the release's own tracklist", () => {
  it("is the media summed, not one medium's count", () => {
    // The multi-disc case, which is the one a `medium["track-count"]` read gets wrong: a
    // two-disc release of 13 + 12 has 25 tracks, and reading the first medium says 13.
    expect(totalFromRelease(release(13, 12))).toBe(25);
  });

  it("reads a single-disc release as itself", () => {
    expect(totalFromRelease(release(14))).toBe(14);
  });

  it("has nothing to say about a release that is not there, or has no media", () => {
    expect(totalFromRelease(null)).toBeNull();
    expect(totalFromRelease(undefined)).toBeNull();
    expect(totalFromRelease(release())).toBeNull();
    // The "absent" marker the cache stores in place of a body parses as exactly this.
    expect(totalFromRelease({} as MbRelease)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* rung 2 — the tags                                                   */
/* ------------------------------------------------------------------ */

describe("the totals the files themselves carry", () => {
  it("is `totaltracks` when there is one disc", () => {
    expect(totalFromDocuments([doc(1, 9, 1), doc(1, 9, 1), doc(1, 9, 1)])).toBe(9);
  });

  it("sums the discs rather than multiplying, when they are not the same length", () => {
    // 13 + 12 = 25. `totaltracks × totaldiscs` would answer 26 on the first disc's tags and
    // 24 on the second's, which is two wrong answers depending on row order.
    expect(totalFromDocuments([doc(1, 13, 2), doc(2, 12, 2)])).toBe(25);
  });

  it("falls back to the album's own figure for a disc it has seen no track of", () => {
    // Only disc 1 was ever downloaded. Disc 2 contributes what the album agrees on, which is
    // the `totaltracks × totaldiscs` reading — a guess, but the only one available.
    expect(totalFromDocuments([doc(1, 10, 2), doc(1, 10, 2)])).toBe(20);
  });

  it("treats a document with no disc number as disc one", () => {
    expect(totalFromDocuments([doc(null, 12, null)])).toBe(12);
  });

  it("takes the value most of the tracks agree on, not the first odd one", () => {
    expect(totalFromDocuments([doc(1, 12, 1), doc(1, 12, 1), doc(1, 3, 1)])).toBe(12);
  });

  it("says nothing when no document carries a total", () => {
    expect(totalFromDocuments([])).toBeNull();
    expect(totalFromDocuments([doc(1, null, null), doc(1, null, 1)])).toBeNull();
    expect(totalFromDocuments([doc(1, 0, 1)])).toBeNull();
  });

  it("refuses a `totaldiscs` that is a misread tag rather than a box set", () => {
    expect(totalFromDocuments([doc(1, 12, 9999)])).toBeNull();
  });
});

describe("reading the totals off a stored document", () => {
  it("takes the numbers, the strings and the `4/13` spelling", () => {
    expect(
      documentTotalsOf({
        fields: {
          totaltracks: { value: 13 },
          totaldiscs: { value: "2" },
          discnumber: { value: 2 },
        },
      }),
    ).toEqual({ discNumber: 2, totalTracks: 13, totalDiscs: 2 });
    expect(documentTotalsOf({ fields: { totaltracks: { value: "4/13" } } }).totalTracks).toBe(13);
  });

  it("falls back to the alias the tag map mirrors, and to nothing at all", () => {
    expect(documentTotalsOf({ fields: { totaltracks_alias: { value: 7 } } }).totalTracks).toBe(7);
    expect(documentTotalsOf(null)).toEqual({
      discNumber: null,
      totalTracks: null,
      totalDiscs: null,
    });
  });

  it("prefers the caller's disc number, which is the row's and not the document's", () => {
    expect(documentTotalsOf({ fields: { discnumber: { value: 1 } } }, 2).discNumber).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* the ladder                                                          */
/* ------------------------------------------------------------------ */

describe("the counters of a partial album", () => {
  it("reports one of thirteen, from the release, and calls it counted", () => {
    // The bug, in one assertion. This is the production album: track 4 of a thirteen-track
    // release, and nothing else. It used to come out `1/1`.
    expect(albumCounters({ present: 1, known: 1, releaseTotal: 13 })).toEqual({
      presentCount: 1,
      trackCount: 13,
      trackCountSource: "release",
    });
  });

  it("prefers the release to the tags when both have an opinion", () => {
    const counters = albumCounters({ present: 2, known: 2, releaseTotal: 13, documentTotal: 9 });
    expect(counters.trackCount).toBe(13);
    expect(counters.trackCountSource).toBe("release");
  });

  it("falls to the tags when the release is not in the cache", () => {
    expect(albumCounters({ present: 3, known: 4, documentTotal: 9 })).toEqual({
      presentCount: 3,
      trackCount: 9,
      trackCountSource: "tags",
    });
  });

  it("counts the rows, and says the total is unknown, when nothing else answers", () => {
    const counters = albumCounters({ present: 5, known: 5 });
    expect(counters).toEqual({ presentCount: 5, trackCount: 5, trackCountSource: "rows" });
    // `5/5` would render as a complete album. The source is what stops the Console saying so.
    expect(totalIsKnown(counters.trackCountSource)).toBe(false);
    expect(totalIsKnown("release")).toBe(true);
    expect(totalIsKnown("tags")).toBe(true);
  });

  it("never lets the numerator exceed the denominator, whatever the release claims", () => {
    // Fourteen rows on a release that says thirteen is a disagreement, and `14/13` is not a
    // reading of it. The rows are the floor.
    const counters = albumCounters({ present: 14, known: 14, releaseTotal: 13 });
    expect(counters.trackCount).toBe(14);
    expect(counters.presentCount).toBe(14);
  });

  it("keeps a missing file visible: three of thirteen rows on disk is 3/13", () => {
    expect(albumCounters({ present: 3, known: 13, releaseTotal: 13 })).toEqual({
      presentCount: 3,
      trackCount: 13,
      trackCountSource: "release",
    });
  });

  it("is 0/0 for an album every track has left", () => {
    expect(albumCounters({ present: 0, known: 0 })).toEqual({
      presentCount: 0,
      trackCount: 0,
      trackCountSource: "rows",
    });
  });

  it("ignores a total of zero or less rather than treating it as an answer", () => {
    expect(albumCounters({ present: 2, known: 2, releaseTotal: 0, documentTotal: -3 })).toEqual({
      presentCount: 2,
      trackCount: 2,
      trackCountSource: "rows",
    });
  });
});
