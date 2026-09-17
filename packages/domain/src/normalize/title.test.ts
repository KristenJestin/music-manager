// Ported with the implementation from _archive/music-manager-v2/src/matching/normalize.test.ts.
// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  creditCarriesArtist,
  hasEditionQualifier,
  normalizeArtist,
  normalizeTitle,
  primaryArtist,
  splitArtistCredit,
  stripArtistPrefix,
  stripEditionQualifier,
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

describe("stripArtistPrefix", () => {
  it("drops the credit an official channel puts in front of its own title", () => {
    // DRIVE-1 §B1, verbatim: the video is titled "Radiohead - Creep" and the only candidate
    // proposed was a cover literally named that, because the query was a phrase search.
    expect(stripArtistPrefix("Radiohead - Creep", "Radiohead")).toBe("Creep");
  });

  it("accepts the en and em dashes as separators", () => {
    expect(stripArtistPrefix("Radiohead – Creep", "Radiohead")).toBe("Creep");
    expect(stripArtistPrefix("Radiohead — Creep", "Radiohead")).toBe("Creep");
    expect(normalizeTitle("Radiohead – Creep")).toBe("creep");
    expect(normalizeTitle("Radiohead — Creep")).toBe("creep");
  });

  it("recognises a channel name built on the artist's", () => {
    expect(stripArtistPrefix("Radiohead - Creep", "RadioheadVEVO")).toBe("Creep");
    expect(stripArtistPrefix("Daft Punk - Get Lucky", "Daft Punk - Topic")).toBe("Get Lucky");
  });

  it("keeps the title when the leading segment is not the artist", () => {
    // "Creep - Radiohead" is the credit on the *right*: stripping the head would lose the song.
    expect(stripArtistPrefix("Creep - Radiohead", "Radiohead")).toBe("Creep - Radiohead");
    expect(stripArtistPrefix("Radiohead - Creep", "Klangsberg")).toBe("Radiohead - Creep");
  });

  it("strips unconditionally when no artist is known, like normalizeTitle does", () => {
    expect(stripArtistPrefix("Radiohead - Creep")).toBe("Creep");
    expect(stripArtistPrefix("Radiohead - Creep", "")).toBe("Creep");
  });

  it("leaves a hyphenated word and a title with no separator alone", () => {
    expect(stripArtistPrefix("Jay-Z - 99 Problems", "Jay-Z")).toBe("99 Problems");
    expect(stripArtistPrefix("Non-Stop", "Hamilton")).toBe("Non-Stop");
    expect(stripArtistPrefix("Creep", "Radiohead")).toBe("Creep");
  });
});

/* ------------------------------------------------------------------ */
/* edition qualifiers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Forty of the owner's imports were stuck on "The search came back empty" because the playlist
 * title carries an edition name MusicBrainz does not publish. Each form here is one of them.
 */
describe("stripEditionQualifier", () => {
  it("drops a parenthesised qualifier", () => {
    expect(stripEditionQualifier("Let Go (Expanded Edition)")).toBe("Let Go");
    expect(stripEditionQualifier("Sunset on the Golden Age (Deluxe)")).toBe(
      "Sunset on the Golden Age",
    );
    expect(stripEditionQualifier("Cats on Trees (Deluxe Edition)")).toBe("Cats on Trees");
    expect(stripEditionQualifier("The Marshall Mathers LP2 (Deluxe)")).toBe(
      "The Marshall Mathers LP2",
    );
    expect(stripEditionQualifier("Nirvana (Bonus Track Version)")).toBe("Nirvana");
    expect(stripEditionQualifier("Thriller (Special Edition)")).toBe("Thriller");
    expect(stripEditionQualifier("Kind of Blue (Remastered)")).toBe("Kind of Blue");
  });

  it("drops a bracketed one, and an anniversary with its ordinal", () => {
    expect(stripEditionQualifier("Nevermind [20th Anniversary Edition]")).toBe("Nevermind");
    expect(stripEditionQualifier("Doolittle [Bonus Track Version]")).toBe("Doolittle");
  });

  it("drops one introduced by a dash, a colon or a comma", () => {
    expect(stripEditionQualifier("Abbey Road - Remastered")).toBe("Abbey Road");
    expect(stripEditionQualifier("OK Computer — Special Edition")).toBe("OK Computer");
    expect(stripEditionQualifier("Rumours: Deluxe Edition")).toBe("Rumours");
    expect(stripEditionQualifier("Parachutes, Remastered")).toBe("Parachutes");
  });

  it("drops a bare qualifier only when it is unmistakably one", () => {
    // Two words or more is the rule: "Deluxe Edition" is never the tail of a real album title.
    expect(stripEditionQualifier("Back in Black Deluxe Edition")).toBe("Back in Black");
    expect(stripEditionQualifier("Homework Bonus Track Version")).toBe("Homework");
    // One bare word is not enough — see the next test for why.
    expect(stripEditionQualifier("Hotel Deluxe")).toBe("Hotel Deluxe");
    expect(stripEditionQualifier("Songs Remastered")).toBe("Songs Remastered");
  });

  it("leaves a title alone when “Deluxe” is the real name", () => {
    // Harmonia's 1975 record is called *Deluxe*. Stripping would leave nothing, so it does not.
    expect(stripEditionQualifier("Deluxe")).toBe("Deluxe");
    expect(stripEditionQualifier("Remastered")).toBe("Remastered");
    // And a qualifier word at the *front* is part of the name, never a qualifier.
    expect(stripEditionQualifier("Deluxe Corner")).toBe("Deluxe Corner");
  });

  it("is idempotent and strips more than one", () => {
    expect(stripEditionQualifier("Album (Deluxe Edition) [Remastered]")).toBe("Album");
    expect(stripEditionQualifier(stripEditionQualifier("Let Go (Expanded Edition)"))).toBe(
      "Let Go",
    );
    expect(stripEditionQualifier("Discovery")).toBe("Discovery");
  });

  it("says whether there was one at all", () => {
    expect(hasEditionQualifier("Let Go (Expanded Edition)")).toBe(true);
    expect(hasEditionQualifier("Let Go")).toBe(false);
    expect(hasEditionQualifier("Deluxe")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* composite artist credits                                            */
/* ------------------------------------------------------------------ */

describe("splitArtistCredit", () => {
  it("splits on every separator YouTube uses to list more than one name", () => {
    expect(splitArtistCredit("Laufey, Spencer Stewart")).toEqual(["Laufey", "Spencer Stewart"]);
    expect(splitArtistCredit("Macklemore & Ryan Lewis")).toEqual(["Macklemore", "Ryan Lewis"]);
    expect(splitArtistCredit("Daft Punk feat. Pharrell Williams")).toEqual([
      "Daft Punk",
      "Pharrell Williams",
    ]);
    expect(splitArtistCredit("Jay-Z ft. Alicia Keys")).toEqual(["Jay-Z", "Alicia Keys"]);
    expect(splitArtistCredit("Simon and Garfunkel")).toEqual(["Simon", "Garfunkel"]);
  });

  it("drops the “- Topic” channel suffix and leaves a lone name alone", () => {
    expect(splitArtistCredit("Daft Punk - Topic")).toEqual(["Daft Punk"]);
    expect(splitArtistCredit("Laufey")).toEqual(["Laufey"]);
    expect(splitArtistCredit("")).toEqual([]);
    expect(splitArtistCredit(null)).toEqual([]);
  });

  it("names the first credited artist, and nobody when there is only one", () => {
    expect(primaryArtist("Laufey, Spencer Stewart")).toBe("Laufey");
    expect(primaryArtist("Macklemore & Ryan Lewis")).toBe("Macklemore");
    expect(primaryArtist("Rise Against")).toBeNull();
    expect(primaryArtist(null)).toBeNull();
  });
});

/**
 * The equality rule behind the refusal, stated in both directions.
 *
 * A *detected* artist disagreement stops an import and asks a person, so the comparison has to
 * be generous enough never to refuse a right answer and strict enough to refuse "Laura Fygi"
 * for "Laufey". Both halves are load-bearing and both are tested.
 */
describe("creditCarriesArtist", () => {
  it("accepts a candidate that names the artist among others, and the reverse", () => {
    expect(creditCarriesArtist("Laufey, Spencer Stewart", "Laufey")).toBe(true);
    expect(creditCarriesArtist("Laufey", "Laufey, Spencer Stewart")).toBe(true);
    expect(creditCarriesArtist("Daft Punk", "Daft Punk feat. Julian Casablancas")).toBe(true);
    expect(creditCarriesArtist("Macklemore & Ryan Lewis", "Macklemore")).toBe(true);
  });

  it("treats “&” and “and” as the same word, and folds case and accents", () => {
    expect(creditCarriesArtist("Simon and Garfunkel", "Simon & Garfunkel")).toBe(true);
    expect(creditCarriesArtist("Beyoncé", "BEYONCE")).toBe(true);
    expect(creditCarriesArtist("The Beatles", "Beatles")).toBe(true);
  });

  it("refuses the three the owner's library was filed under", () => {
    expect(creditCarriesArtist("Laufey, Spencer Stewart", "Laura Fygi")).toBe(false);
    expect(creditCarriesArtist("David Guetta", "Marc Cary")).toBe(false);
    expect(creditCarriesArtist("Macklemore & Ryan Lewis", "Crockett")).toBe(false);
  });

  it("does not accept a name for merely looking like another", () => {
    // No fuzzy similarity anywhere: "Laufey" and "Laura Fygi" share four letters and a shape,
    // and a threshold low enough to forgive a spelling is low enough to accept them.
    expect(creditCarriesArtist("Laufey", "Laura Fygi")).toBe(false);
    expect(creditCarriesArtist("Lorde", "Lord Huron")).toBe(false);
    expect(creditCarriesArtist("Air", "Air Supply")).toBe(false);
  });

  it("uses the aliases when the caller has them", () => {
    // Stripped from the matching cassettes on purpose, so nothing may *depend* on them.
    expect(creditCarriesArtist("Transistor Revolt", "Rise Against")).toBe(false);
    expect(creditCarriesArtist("Transistor Revolt", "Rise Against", ["Transistor Revolt"])).toBe(
      true,
    );
  });

  it("agrees with anything when the source names nobody", () => {
    expect(creditCarriesArtist("", "Laura Fygi")).toBe(true);
    expect(creditCarriesArtist(null, "Laura Fygi")).toBe(true);
    // But a candidate with no credit at all carries no artist.
    expect(creditCarriesArtist("Laufey", "")).toBe(false);
  });
});
