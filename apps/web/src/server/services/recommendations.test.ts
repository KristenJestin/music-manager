/**
 * The scoring, the diversity walk, and the sentence.
 *
 * `docs/05` § Scoring names five ingredients and this file pins each one's *direction* rather
 * than its exact arithmetic: a heavier external score must not be able to lose to a lighter
 * one, all else equal; owning more of an artist must lower a suggestion, never raise it. Tests
 * that asserted the weighted sums to three decimals would break every time the weights are
 * tuned and would prove nothing about whether the list is right.
 *
 * The one exception is `diversify`, which is asserted precisely, because its whole behaviour is
 * an ordering and an ordering is either right or wrong.
 */
import { describe, expect, it } from "vitest";
import {
  artistAffinity,
  diversify,
  genreAffinity,
  reasonFor,
  redundancyOf,
  SCORE_WEIGHTS,
  scoreOf,
  type RecommendedItem,
  type ScoreFactors,
} from "./recommendations.ts";
import type { ListeningSignals } from "./signals.ts";

const NEUTRAL: ScoreFactors = {
  external: 0,
  artistAffinity: 0,
  genreAffinity: 0,
  recency: 0,
  redundancy: 0,
  diversity: 0,
};

const SIGNALS: ListeningSignals = {
  observedAt: "2026-09-06T00:00:00Z",
  windowDays: 30,
  totalPlays: 500,
  sources: [],
  topArtists: [
    { name: "Justice", mbid: "j", plays: 200, albums: 2, starred: true, inLibrary: 2 },
    { name: "Daft Punk", mbid: "d", plays: 100, albums: 3, starred: false, inLibrary: 3 },
    { name: "Air", mbid: "a", plays: 20, albums: 1, starred: false, inLibrary: 0 },
  ],
  topGenres: [
    { name: "french house", plays: 400 },
    { name: "art pop", plays: 100 },
  ],
  error: null,
};

describe("scoreOf", () => {
  it("stays inside [0, 1] whatever it is handed", () => {
    expect(scoreOf(NEUTRAL)).toBe(0);
    const everything: ScoreFactors = {
      external: 5,
      artistAffinity: 5,
      genreAffinity: 5,
      recency: 5,
      redundancy: -5,
      diversity: 5,
    };
    expect(scoreOf(everything)).toBe(1);
    expect(scoreOf({ ...NEUTRAL, redundancy: 5 })).toBe(0);
  });

  it("moves with each positive ingredient", () => {
    for (const key of [
      "external",
      "artistAffinity",
      "genreAffinity",
      "recency",
      "diversity",
    ] as const) {
      expect(scoreOf({ ...NEUTRAL, [key]: 1 }), key).toBeGreaterThan(scoreOf(NEUTRAL));
    }
  });

  it("is the only negative term, and it is redundancy", () => {
    const base = scoreOf({ ...NEUTRAL, external: 1 });
    expect(scoreOf({ ...NEUTRAL, external: 1, redundancy: 1 })).toBeLessThan(base);
    expect(SCORE_WEIGHTS.redundancy).toBeLessThan(0);
  });

  it("weights the external recommendation above every other single ingredient", () => {
    // `docs/05` puts the external recommendation first in the list for a reason.
    const others = [
      SCORE_WEIGHTS.artistAffinity,
      SCORE_WEIGHTS.genreAffinity,
      SCORE_WEIGHTS.recency,
      SCORE_WEIGHTS.diversity,
    ];
    for (const weight of others) expect(SCORE_WEIGHTS.external).toBeGreaterThan(weight);
  });
});

describe("affinity", () => {
  it("is one for the artist you play most and a fraction for the rest", () => {
    expect(artistAffinity("Justice", SIGNALS)).toBe(1);
    expect(artistAffinity("Daft Punk", SIGNALS)).toBeCloseTo(0.5, 5);
    expect(artistAffinity("daft punk", SIGNALS)).toBeCloseTo(0.5, 5);
    expect(artistAffinity("Nobody", SIGNALS)).toBe(0);
  });

  it("takes the best matching genre, not the first", () => {
    expect(genreAffinity(["art pop", "french house"], SIGNALS)).toBe(1);
    expect(genreAffinity(["Art Pop"], SIGNALS)).toBeCloseTo(0.25, 5);
    expect(genreAffinity(["polka"], SIGNALS)).toBe(0);
    expect(genreAffinity([], SIGNALS)).toBe(0);
  });

  it("is zero when there are no signals at all rather than dividing by none", () => {
    const empty: ListeningSignals = { ...SIGNALS, topArtists: [], topGenres: [] };
    expect(artistAffinity("Justice", empty)).toBe(0);
    expect(genreAffinity(["french house"], empty)).toBe(0);
  });
});

describe("redundancyOf", () => {
  it("is relative to the biggest shelf you have", () => {
    const owned = new Map([
      ["daft punk", 6],
      ["justice", 3],
    ]);
    expect(redundancyOf("Daft Punk", owned)).toBe(1);
    expect(redundancyOf("Justice", owned)).toBeCloseTo(0.5, 5);
    expect(redundancyOf("Cassius", owned)).toBe(0);
  });
});

describe("diversify", () => {
  const item = (artist: string, external: number, id: string): RecommendedItem => ({
    subject: `release-group:${id}`,
    kind: "album",
    title: id,
    artist,
    albumTitle: id,
    artistMbid: null,
    releaseGroupMbid: id,
    recordingMbid: null,
    year: 2020,
    score: scoreOf({ ...NEUTRAL, external, diversity: 1 }),
    factors: { ...NEUTRAL, external, diversity: 1 },
    reason: "",
    source: "test",
    inLibrary: false,
  });

  it("keeps the best of an artist at the top and sinks the rest", () => {
    const ranked = diversify(
      [
        item("Tame Impala", 1, "a"),
        item("Tame Impala", 0.99, "b"),
        item("Tame Impala", 0.98, "c"),
        item("Cassius", 0.5, "d"),
      ],
      { maxPerArtist: 1, max: 10 },
    );
    expect(ranked[0]?.title).toBe("a");
    // With an allowance of one, the second Tame Impala loses its diversity bonus and takes a
    // penalty; a weaker but unheard artist overtakes it.
    expect(ranked[1]?.artist).toBe("Cassius");
  });

  it("drops nothing for being redundant — it only reorders", () => {
    const ranked = diversify(
      [item("Tame Impala", 1, "a"), item("Tame Impala", 0.9, "b"), item("Tame Impala", 0.8, "c")],
      { maxPerArtist: 1, max: 10 },
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.map((one) => one.title).sort()).toEqual(["a", "b", "c"]);
  });

  it("honours the allowance before it starts penalising", () => {
    const ranked = diversify(
      [item("Tame Impala", 1, "a"), item("Tame Impala", 0.95, "b"), item("Cassius", 0.5, "d")],
      { maxPerArtist: 2, max: 10 },
    );
    expect(ranked.slice(0, 2).map((one) => one.artist)).toEqual(["Tame Impala", "Tame Impala"]);
  });

  it("cuts to the maximum after re-scoring, not before", () => {
    const ranked = diversify(
      [item("Tame Impala", 1, "a"), item("Tame Impala", 0.99, "b"), item("Cassius", 0.5, "d")],
      { maxPerArtist: 1, max: 2 },
    );
    expect(ranked).toHaveLength(2);
    expect(ranked.map((one) => one.artist)).toEqual(["Tame Impala", "Cassius"]);
  });

  it("is stable for a list that needs no diversifying", () => {
    const ranked = diversify([item("A", 1, "a"), item("B", 0.9, "b"), item("C", 0.8, "c")], {
      maxPerArtist: 3,
      max: 10,
    });
    expect(ranked.map((one) => one.title)).toEqual(["a", "b", "c"]);
  });
});

describe("reasonFor", () => {
  it("writes the sentence `docs/05` asks for", () => {
    expect(reasonFor({ anchor: { name: "Justice", plays: 43 } }, 30)).toBe(
      "because you played Justice 43× this month",
    );
    expect(reasonFor({ similarTo: "Daft Punk" }, 30)).toBe("similar to Daft Punk per ListenBrainz");
    expect(reasonFor({ genre: "french house" }, 30)).toBe("top genre: french house");
  });

  it("joins the clauses rather than picking one", () => {
    const reason = reasonFor({ anchor: { name: "Justice", plays: 43 }, genre: "french house" }, 30);
    expect(reason).toBe("because you played Justice 43× this month · top genre: french house");
  });

  it("says when it fell back to Last.fm", () => {
    const reason = reasonFor(
      { similarTo: "Stromae", similarSource: "Last.fm", fallback: true },
      30,
    );
    expect(reason).toContain("per Last.fm");
    expect(reason).toContain("Last.fm fallback");
  });

  it("never returns an empty sentence", () => {
    expect(reasonFor({}, 30).length).toBeGreaterThan(10);
  });

  it("names the window when it is not a month", () => {
    expect(reasonFor({ anchor: { name: "Justice", plays: 43 } }, 7)).toContain(
      "in the last 7 days",
    );
  });
});
