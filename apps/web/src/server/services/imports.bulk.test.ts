/**
 * The two pure decisions inside `confirm-best`: which candidate wins, and whether it wins by
 * enough to be confirmed with nobody watching.
 *
 * `confirmBest` itself needs a database, MusicBrainz and a step machine, and it is covered by
 * `imports.bulk.integration.test.ts` against a real stack. These two are not: `orderCandidates`
 * is three comparisons and is where `preferType` lives; `judgeRecording` is the whole of the
 * single's bar. Both are the parts somebody will one day be tempted to "simplify" into the
 * scorer — which is exactly what the brief said not to do.
 */
import { describe, expect, it } from "vitest";
import type { RecordingCandidate, ReleaseCandidate } from "@mm/domain";
import {
  isAlbumType,
  judgeRecording,
  orderCandidates,
  type RankedCandidate,
  type RecordingBar,
} from "./imports.bulk.ts";

function ranked(id: string, mapped: number, score: number, type: string | null): RankedCandidate {
  return {
    candidate: { id, score, type } as ReleaseCandidate,
    mapped,
    coverage: mapped / 14,
    isAlbum: isAlbumType(type),
  };
}

describe("orderCandidates", () => {
  it("puts the candidate that maps the most videos first, whatever its type", () => {
    const winner = orderCandidates(
      [ranked("ep", 9, 0.99, "EP"), ranked("album", 13, 0.4, "Album")],
      "album",
    )[0];
    expect(winner?.candidate.id).toBe("album");
  });

  /*
   * The case the owner kept undoing by hand: a single carrying the same recordings maps
   * exactly as many videos as the album and files the result under the wrong record.
   */
  it("prefers an Album over a Single of equal coverage when preferType is album", () => {
    const winner = orderCandidates(
      [ranked("single", 13, 0.9, "Single"), ranked("album", 13, 0.85, "Album")],
      "album",
    )[0];
    expect(winner?.candidate.id).toBe("album");
  });

  it("falls back to the engine's score when preferType is any", () => {
    const winner = orderCandidates(
      [ranked("single", 13, 0.9, "Single"), ranked("album", 13, 0.85, "Album")],
      "any",
    )[0];
    expect(winner?.candidate.id).toBe("single");
  });

  it("separates two Albums of equal coverage by score, not by order", () => {
    const winner = orderCandidates(
      [ranked("worse", 13, 0.6, "Album"), ranked("better", 13, 0.8, "Album")],
      "album",
    )[0];
    expect(winner?.candidate.id).toBe("better");
  });

  it("never promotes a candidate that maps fewer, however Album it is", () => {
    const winner = orderCandidates(
      [ranked("album", 12, 0.99, "Album"), ranked("compilation", 14, 0.2, "Compilation")],
      "album",
    )[0];
    expect(winner?.candidate.id).toBe("compilation");
  });

  it("leaves the input untouched — the ranking is read elsewhere too", () => {
    const input = [ranked("a", 1, 0.1, "EP"), ranked("b", 5, 0.2, "Album")];
    orderCandidates(input, "album");
    expect(input.map((entry) => entry.candidate.id)).toEqual(["a", "b"]);
  });
});

describe("isAlbumType", () => {
  it("reads MusicBrainz's `primary-type` case-insensitively, and nothing else", () => {
    expect(isAlbumType("Album")).toBe(true);
    expect(isAlbumType("album")).toBe(true);
    expect(isAlbumType(" Album ")).toBe(true);
    expect(isAlbumType("EP")).toBe(false);
    expect(isAlbumType("Single")).toBe(false);
    // A release group MusicBrainz gave no type to is not an album by default.
    expect(isAlbumType(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the single's bar                                                    */
/* ------------------------------------------------------------------ */

/** The defaults `recordingBarOf` produces from an unmodified installation. */
const BAR: RecordingBar = { minMargin: 0.04, minAgreement: 0.87, durationToleranceSeconds: 2 };

function recording(patch: Partial<RecordingCandidate> = {}): RecordingCandidate {
  return {
    id: "rec-1",
    title: "Skinny Love",
    artist: "Birdy",
    disambiguation: "",
    length: 201,
    isrc: null,
    score: 0.98,
    signals: { title: 1, artist: 1, duration: 1, ytTags: 1, isrc: 0 },
    penalties: [],
    why: [],
    artistDisagrees: false,
    preselected: true,
    safe: true,
    releases: [],
    borrow: {
      id: "rel-1",
      title: "Birdy",
      type: "Album",
      secondary: [],
      date: "2011-11-04",
      country: "XW",
      format: "Digital Media",
      mediumCount: 1,
      label: "Atlantic",
      catalogNumber: null,
      barcode: null,
      status: "Official",
      disambiguation: "",
      trackPosition: 2,
      trackCount: 13,
      preferred: true,
      why: [],
    },
    ...patch,
  };
}

describe("judgeRecording", () => {
  it("confirms a recording that leads, agrees on duration, and agrees on title and artist", () => {
    const verdict = judgeRecording(
      recording(),
      recording({ id: "rec-2", score: 0.8 }),
      {
        durationSeconds: 202,
      },
      BAR,
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.margin).toBeCloseTo(0.18, 3);
    expect(verdict.durationDelta).toBe(1);
  });

  /*
   * The `ambiguous_recording` case, decided the same way here as in the `match` step: an album
   * version and a single edit one second apart are genuinely indistinguishable from outside.
   */
  it("refuses when the runner-up is inside the margin, and says by how much", () => {
    const verdict = judgeRecording(
      recording(),
      recording({ id: "rec-2", score: 0.96 }),
      {
        durationSeconds: 202,
      },
      BAR,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.margin).toBeCloseTo(0.02, 3);
    expect(verdict.failures.join(" ")).toMatch(/margin/);
  });

  it("treats a lone candidate as unopposed rather than as ambiguous", () => {
    const verdict = judgeRecording(recording(), undefined, { durationSeconds: 202 }, BAR);

    expect(verdict.ok).toBe(true);
    // No runner-up is not a margin of zero, and must not be reported as one.
    expect(verdict.margin).toBeNull();
  });

  it("refuses a duration outside the tolerance, however well the titles agree", () => {
    const verdict = judgeRecording(recording(), undefined, { durationSeconds: 240 }, BAR);

    expect(verdict.ok).toBe(false);
    expect(verdict.durationDelta).toBe(39);
    expect(verdict.failures.join(" ")).toMatch(/durations disagree/);
  });

  /* Absent evidence is not agreement: the brief is "refuse rather than guess". */
  it("refuses when either side has no duration at all", () => {
    expect(judgeRecording(recording(), undefined, { durationSeconds: null }, BAR).ok).toBe(false);
    expect(
      judgeRecording(recording({ length: null }), undefined, { durationSeconds: 202 }, BAR).ok,
    ).toBe(false);
  });

  /* A cover: right title, right length, wrong performer. This is the one artist agreement buys. */
  it("refuses a candidate whose artist does not agree, even at the right length", () => {
    const cover = recording({
      artist: "Saya Santaquilani",
      signals: { title: 1, artist: 0, duration: 1, ytTags: 0.33, isrc: 0 },
    });
    const verdict = judgeRecording(cover, undefined, { durationSeconds: 202 }, BAR);

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/artist agreement/);
  });

  it("refuses a weak title agreement", () => {
    const verdict = judgeRecording(
      recording({ signals: { title: 0.5, artist: 1, duration: 1, ytTags: 1, isrc: 0 } }),
      undefined,
      { durationSeconds: 202 },
      BAR,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/title agreement/);
  });

  it("refuses a recording on no release: there would be nowhere to file the track", () => {
    const verdict = judgeRecording(
      recording({ borrow: null }),
      undefined,
      { durationSeconds: 202 },
      BAR,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/no release/);
  });

  it("reports every failed condition, not just the first", () => {
    const verdict = judgeRecording(
      recording({
        score: 0.9,
        length: 240,
        signals: { title: 0.2, artist: 0.1, duration: 0, ytTags: 0, isrc: 0 },
      }),
      recording({ id: "rec-2", score: 0.89 }),
      { durationSeconds: 202 },
      BAR,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.length).toBe(4);
  });
});
