/**
 * The one pure decision inside `confirm-best`: which candidate wins.
 *
 * `confirmBest` itself needs a database, MusicBrainz and a step machine, and it is covered by
 * `imports.bulk.integration.test.ts` against a real stack. The ordering is not: it is three
 * comparisons, it is where `preferType` lives, and it is the part somebody will one day be
 * tempted to "simplify" into the scorer — which is exactly what the brief said not to do.
 */
import { describe, expect, it } from "vitest";
import type { ReleaseCandidate } from "@mm/domain";
import { isAlbumType, orderCandidates, type RankedCandidate } from "./imports.bulk.ts";

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
