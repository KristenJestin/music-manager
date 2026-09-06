// Ported with the implementation from _archive/music-manager-v2/src/matching/normalize.test.ts.
// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  normalizeArtist,
  normalizeTitle,
  stripReleaseTypePrefix,
  titleSimilarity,
} from "./title.ts";

describe("normalizeTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Hello   World  ")).toBe("hello world");
  });

  it("strips a leading 'Artist - ' prefix", () => {
    expect(normalizeTitle("Daft Punk - Get Lucky")).toBe("get lucky");
  });

  it("strips '(Official Video)' and its common variants", () => {
    expect(normalizeTitle("Get Lucky (Official Video)")).toBe("get lucky");
    expect(normalizeTitle("Get Lucky [Official Music Video]")).toBe("get lucky");
    expect(normalizeTitle("Get Lucky (Official Audio)")).toBe("get lucky");
    expect(normalizeTitle("Get Lucky (Lyric Video)")).toBe("get lucky");
  });

  it("strips a 'feat.' / 'ft.' segment", () => {
    expect(normalizeTitle("Get Lucky feat. Pharrell Williams")).toBe("get lucky");
    expect(normalizeTitle("Get Lucky (feat. Pharrell Williams)")).toBe("get lucky");
    expect(normalizeTitle("Get Lucky ft. Pharrell")).toBe("get lucky");
  });

  it("strips only the feat. clause, keeping a trailing dash-subtitle", () => {
    // Regression: a greedy feat-tail strip used to swallow everything after
    // 'ft.', so "Song ft. X & Y - Live" collapsed to just the subtitle "live"
    // (the real title "song" was lost). The clause must stop at the " - "
    // subtitle so both the title and the subtitle survive.
    expect(normalizeTitle("Song ft. X & Y - Live")).toBe("song live");
    expect(normalizeTitle("Midnight City feat. Guest - Acoustic")).toBe("midnight city acoustic");
  });

  it("strips a parenthesized feat. credit cleanly (no leftover dash-subtitle bug)", () => {
    // The bracketed form is removed by the noise-bracket pass and must leave the
    // bare title — and keep a following real dash-subtitle intact.
    expect(normalizeTitle("Song (feat. X)")).toBe("song");
    expect(normalizeTitle("Song (feat. X) - Live")).toBe("song live");
  });

  it("strips remaster / remaster-year tags", () => {
    expect(normalizeTitle("Bohemian Rhapsody (Remastered 2011)")).toBe("bohemian rhapsody");
    expect(normalizeTitle("Bohemian Rhapsody - Remaster")).toBe("bohemian rhapsody");
    expect(normalizeTitle("Money (2011 Remaster)")).toBe("money");
  });

  it("drops remaining bracketed noise", () => {
    expect(normalizeTitle("Song Title [HD]")).toBe("song title");
    expect(normalizeTitle("Song Title (4K)")).toBe("song title");
  });

  it("normalizes punctuation and accents so fuzzy compares are stable", () => {
    // Whatever the exact transform, two cosmetically-different spellings of the
    // same title must normalize equal.
    expect(normalizeTitle("Café del Mar")).toBe(normalizeTitle("Cafe del Mar"));
    expect(normalizeTitle("Don't Stop")).toBe(normalizeTitle("Dont Stop"));
  });

  it("keeps a plain title untouched (besides case)", () => {
    expect(normalizeTitle("Midnight City")).toBe("midnight city");
  });
});

describe("normalizeArtist", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeArtist("  Daft   Punk ")).toBe("daft punk");
  });

  it("strips a leading 'The '", () => {
    expect(normalizeArtist("The Beatles")).toBe("beatles");
  });

  it("drops a 'Topic' suffix (YouTube auto-channels)", () => {
    expect(normalizeArtist("Daft Punk - Topic")).toBe("daft punk");
  });

  it("drops a 'feat.' tail", () => {
    expect(normalizeArtist("Daft Punk feat. Pharrell")).toBe("daft punk");
  });
});

describe("titleSimilarity", () => {
  it("returns 1 for identical normalized titles", () => {
    expect(titleSimilarity("Get Lucky", "Get Lucky")).toBe(1);
  });

  it("returns 1 once YouTube noise is normalized away", () => {
    expect(titleSimilarity("Get Lucky (Official Video)", "Get Lucky")).toBe(1);
  });

  it("returns a high score for near-identical titles", () => {
    // One-word difference out of several — clearly similar, not identical.
    const s = titleSimilarity("Midnight City Lights", "Midnight City Light");
    expect(s).toBeGreaterThan(0.7);
    expect(s).toBeLessThan(1);
  });

  it("returns a low score for unrelated titles", () => {
    expect(titleSimilarity("Get Lucky", "Smells Like Teen Spirit")).toBeLessThan(0.3);
  });

  it("is symmetric", () => {
    expect(titleSimilarity("Alpha Beta", "Beta Alpha")).toBe(
      titleSimilarity("Beta Alpha", "Alpha Beta"),
    );
  });

  it("is bounded in [0,1]", () => {
    const s = titleSimilarity("anything at all", "totally different words");
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("stripReleaseTypePrefix", () => {
  it("drops the release-type word YouTube puts in front of a generated playlist", () => {
    // Verbatim from `POST /extract` on the owner's OLAK5uy_ playlist (2026-09-06).
    expect(stripReleaseTypePrefix("Album - Love Is Dead")).toBe("Love Is Dead");
    expect(stripReleaseTypePrefix("Single - Get Lucky")).toBe("Get Lucky");
    expect(stripReleaseTypePrefix("EP - Wild Youth")).toBe("Wild Youth");
  });

  it("is case-insensitive and accepts the en and em dashes", () => {
    expect(stripReleaseTypePrefix("album – Discovery")).toBe("Discovery");
    expect(stripReleaseTypePrefix("ALBUM — Discovery")).toBe("Discovery");
  });

  it("leaves a title that merely starts with those letters alone", () => {
    expect(stripReleaseTypePrefix("EP-ic Journey")).toBe("EP-ic Journey");
    expect(stripReleaseTypePrefix("Single-Minded")).toBe("Single-Minded");
    expect(stripReleaseTypePrefix("Albums of the Year")).toBe("Albums of the Year");
    expect(stripReleaseTypePrefix("Love Is Dead")).toBe("Love Is Dead");
  });

  it("keeps the name rather than emptying it, and strips only the first prefix", () => {
    expect(stripReleaseTypePrefix("Album -")).toBe("Album -");
    expect(stripReleaseTypePrefix("Album - Single - Songs")).toBe("Single - Songs");
  });
});
