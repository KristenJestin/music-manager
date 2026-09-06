/**
 * The gap computation — palier 1 of `docs/05-recommandations.md`.
 *
 * `computeGaps` is the only part of Discover that can be *wrong* in a way you would not notice:
 * every other block is a suggestion, but "you have 3 of 6" is an arithmetic claim about your
 * own library, and getting it wrong means proposing a record that is already on disk.
 *
 * So the ownership tests are the point of this file: by MBID (the good case), by folded title
 * (the case of albums imported before an MBID was known), and the interaction with the
 * dismissal memory — a hidden proposal must stop being *proposed* without stopping being
 * *counted*, or hiding one record would rewrite the denominator.
 */
import { describe, expect, it } from "vitest";
import type { MbReleaseGroup } from "@mm/domain";
import { accepts, computeGaps, foldTitle, gapReason, type GapFilters } from "./discography.ts";

const FILTERS: GapFilters = {
  includeTypes: ["Album", "EP"],
  excludeLive: true,
  excludeCompilations: true,
};

const group = (
  id: string,
  title: string,
  primary = "Album",
  secondary: string[] = [],
  date = "2001-01-01",
): MbReleaseGroup => ({
  id,
  title,
  "primary-type": primary,
  "secondary-types": secondary,
  "first-release-date": date,
});

const shelf = (rgMbids: string[] = [], titles: string[] = []) => ({
  rgMbids: new Set(rgMbids),
  titles: new Set(titles.map(foldTitle)),
});

describe("accepts", () => {
  it("keeps the wanted primary types and nothing else", () => {
    expect(accepts(group("1", "Discovery", "Album"), FILTERS)).toBe(true);
    expect(accepts(group("2", "Da Funk", "Single"), FILTERS)).toBe(false);
    expect(accepts(group("3", "Untitled", ""), FILTERS)).toBe(false);
  });

  it("excludes live records and compilations when asked", () => {
    expect(accepts(group("4", "Alive 2007", "Album", ["Live"]), FILTERS)).toBe(false);
    expect(accepts(group("5", "Musique", "Album", ["Compilation"]), FILTERS)).toBe(false);
    expect(accepts(group("6", "TRON", "Album", ["Soundtrack"]), FILTERS)).toBe(true);
  });

  it("lets them back in when the toggles are off", () => {
    const loose: GapFilters = { ...FILTERS, excludeLive: false, excludeCompilations: false };
    expect(accepts(group("4", "Alive 2007", "Album", ["Live"]), loose)).toBe(true);
    expect(accepts(group("5", "Musique", "Album", ["Compilation"]), loose)).toBe(true);
  });

  it("matches the secondary type whatever its case", () => {
    expect(accepts(group("7", "x", "Album", ["live"]), FILTERS)).toBe(false);
  });
});

describe("computeGaps", () => {
  const catalogue = [
    group("rg-homework", "Homework", "Album", [], "1997-01-20"),
    group("rg-discovery", "Discovery", "Album", [], "2001-02-26"),
    group("rg-human", "Human After All", "Album", [], "2005-03-14"),
    group("rg-alive", "Alive 2007", "Album", ["Live"], "2007-11-19"),
    group("rg-dafunk", "Da Funk", "Single", [], "1995-11-01"),
  ];

  it("counts only the accepted types in `have` and `total`", () => {
    const gap = computeGaps(catalogue, shelf(["rg-discovery"]), FILTERS);
    // Five release groups, but the live album and the single are not part of the shelf.
    expect(gap.total).toBe(3);
    expect(gap.have).toBe(1);
    expect(gap.missing.map((one) => one.title)).toEqual(["Human After All", "Homework"]);
  });

  it("recognises what it owns by release-group MBID", () => {
    const gap = computeGaps(catalogue, shelf(["rg-discovery", "rg-homework"]), FILTERS);
    expect(gap.have).toBe(2);
    expect(gap.missing.map((one) => one.title)).toEqual(["Human After All"]);
  });

  it("recognises it by folded title too, for rows imported before an MBID was known", () => {
    // Punctuation, case and accents differ; it is the same record and must not be proposed.
    const gap = computeGaps(
      [group("rg-avd", "Audio, Video, Disco.")],
      shelf([], ["audio video disco"]),
      FILTERS,
    );
    expect(gap.have).toBe(1);
    expect(gap.missing).toEqual([]);
  });

  it("hides a dismissed release group without changing the arithmetic", () => {
    const plain = computeGaps(catalogue, shelf(["rg-discovery"]), FILTERS);
    const hidden = computeGaps(
      catalogue,
      shelf(["rg-discovery"]),
      FILTERS,
      new Set(["release-group:rg-homework"]),
    );
    expect(hidden.missing.map((one) => one.title)).toEqual(["Human After All"]);
    // "You have 1 of 3" is a fact about the library, not about what is on screen.
    expect(hidden.total).toBe(plain.total);
    expect(hidden.have).toBe(plain.have);
  });

  it("collapses a release group MusicBrainz returned twice", () => {
    const gap = computeGaps([...catalogue, group("rg-homework", "Homework")], shelf(), FILTERS);
    expect(gap.total).toBe(3);
    expect(gap.missing.filter((one) => one.rgMbid === "rg-homework")).toHaveLength(1);
  });

  it("ignores a release group with no id at all", () => {
    const gap = computeGaps([{ title: "Nameless", "primary-type": "Album" }], shelf(), FILTERS);
    expect(gap.total).toBe(0);
    expect(gap.missing).toEqual([]);
  });

  it("orders the missing newest first", () => {
    const gap = computeGaps(catalogue, shelf(), FILTERS);
    expect(gap.missing.map((one) => one.year)).toEqual([2005, 2001, 1997]);
  });

  it("carries the secondary types through, so the page can label them", () => {
    const loose: GapFilters = { ...FILTERS, excludeLive: false };
    const gap = computeGaps(catalogue, shelf(), loose);
    const alive = gap.missing.find((one) => one.title === "Alive 2007");
    expect(alive?.secondaryTypes).toEqual(["Live"]);
    expect(alive?.firstReleaseDate).toBe("2007-11-19");
  });

  it("has no year when MusicBrainz has no date", () => {
    const gap = computeGaps([{ id: "x", title: "x", "primary-type": "Album" }], shelf(), FILTERS);
    expect(gap.missing[0]?.year).toBeNull();
  });
});

describe("gapReason", () => {
  it("says the shelf and the listening in one sentence", () => {
    const reason = gapReason(
      { artist: "Daft Punk", artistMbid: "a", plays: 38, have: 2, total: 6, missing: [] },
      30,
    );
    expect(reason).toBe("you have 2 of 6 — played 38× this month");
  });

  it("names the window when it is not a month", () => {
    const reason = gapReason(
      { artist: "Daft Punk", artistMbid: "a", plays: 38, have: 2, total: 6, missing: [] },
      90,
    );
    expect(reason).toContain("in the last 90 days");
  });
});
