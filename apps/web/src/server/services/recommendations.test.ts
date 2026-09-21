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
 *
 * `collectCollaborative` is asserted on its *calls* — which MBIDs were looked up, and how many —
 * because the bug it fixes was one of spending: none of the arithmetic changed when the budget
 * was being spent on titles the library already had.
 */
import { describe, expect, it } from "vitest";
import type { MbRecording } from "@mm/domain";
import {
  artistAffinity,
  cfStrip,
  collectCollaborative,
  diversify,
  genreAffinity,
  reasonFor,
  redundancyOf,
  SCORE_WEIGHTS,
  scoreOf,
  type CfEntry,
  type LibraryIndex,
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

/* ------------------------------------------------------------------ */
/* the lookup budget                                                   */
/* ------------------------------------------------------------------ */

describe("collectCollaborative · lookups are spent on what is not owned", () => {
  const BASE = {
    signals: SIGNALS,
    windowDays: 30,
    owned: new Map<string, number>(),
    dismissed: new Set<string>(),
  };

  /** The 100 MBIDs ListenBrainz answers with, best first. */
  const entries = (count: number): readonly CfEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      recording_mbid: `mbid-${String(index)}`,
      score: 0.9,
    }));

  /** An index holding exactly these recordings, each naming itself from its own row. */
  const holding = (mbids: readonly string[]): LibraryIndex => ({
    recordings: new Map(
      mbids.map(
        (mbid) => [mbid, { title: `Owned ${mbid}`, artist: "Justice", year: 1998 }] as const,
      ),
    ),
    releaseGroups: new Set<string>(),
    artists: new Set<string>(),
  });

  const recording = (mbid: string): MbRecording => ({
    id: mbid,
    title: `New ${mbid}`,
    "first-release-date": "1998-04-21",
    genres: [{ name: "french house" }],
    "artist-credit": [{ name: "Cassius", artist: { id: "cassius", name: "Cassius" } }],
  });

  /** A fake MusicBrainz. Which MBIDs it was asked about, and how many, *is* the assertion. */
  function countingLookup(): {
    readonly calls: string[];
    readonly lookup: (mbid: string) => Promise<MbRecording | null>;
  } {
    const calls: string[] = [];
    return {
      calls,
      lookup: (mbid) => {
        calls.push(mbid);
        return Promise.resolve(recording(mbid));
      },
    };
  }

  /** Spec · lookups are spent on what is not owned — "most of the head is owned". */
  it("most of the head is owned", async () => {
    const owned = Array.from({ length: 12 }, (_, index) => `mbid-${String(index)}`);
    const { calls, lookup } = countingLookup();
    const walk = await collectCollaborative({
      ...BASE,
      entries: entries(100),
      index: holding(owned),
      budget: 15,
      lookup,
    });

    // Twelve of the first fifteen MBIDs are owned: they cost nothing, and are named from the
    // library's own row rather than from a MusicBrainz answer nobody asked for.
    expect(walk.counts).toEqual({ received: 100, inLibrary: 12, examined: 15 });
    expect(calls).toHaveLength(15);
    expect(calls.filter((mbid) => owned.includes(mbid))).toEqual([]);

    // The fifteen calls land on the MBIDs *after* the owned head, where the old loop stopped.
    expect(calls.slice(0, 3)).toEqual(["mbid-12", "mbid-13", "mbid-14"]);

    const toImport = walk.items.filter((item) => !item.inLibrary);
    expect(toImport).toHaveLength(15);
    expect(walk.items.filter((item) => item.inLibrary)).toHaveLength(12);

    const first = walk.items[0];
    expect(first?.title).toBe("Owned mbid-0");
    expect(first?.artist).toBe("Justice");
    expect(first?.year).toBe(1998);
    expect(first?.inLibrary).toBe(true);
    expect(first?.reason).toContain("you played Justice");
  });

  /** Spec · lookups are spent on what is not owned — "nothing left". */
  it("nothing left", async () => {
    const { calls, lookup } = countingLookup();
    // The whole answer is owned, and forty of those rows are dismissed on top: dismissing hides a
    // row, it does not un-own it, so the strip still says a hundred.
    const owned = Array.from({ length: 100 }, (_, index) => `mbid-${String(index)}`);
    const dismissed = new Set(
      Array.from({ length: 40 }, (_, index) => `recording:mbid-${String(index)}`),
    );
    const walk = await collectCollaborative({
      ...BASE,
      entries: entries(100),
      index: holding(owned),
      dismissed,
      budget: 15,
      lookup,
    });

    expect(calls).toEqual([]);
    expect(walk.counts).toEqual({ received: 100, inLibrary: 100, examined: 0 });
    expect(walk.items).toHaveLength(60);
    expect(walk.items.every((item) => item.inLibrary)).toBe(true);
  });

  /** Spec · lookups are spent on what is not owned — "the budget is a setting". */
  it("the budget is a setting", async () => {
    const { calls, lookup } = countingLookup();
    const walk = await collectCollaborative({
      ...BASE,
      entries: entries(100),
      index: holding([]),
      budget: 30,
      lookup,
    });

    expect(calls).toHaveLength(30);
    expect(walk.counts.examined).toBe(30);
    expect(walk.items).toHaveLength(30);
  });

  it("does not count a dismissal it does not own as a lookup or as in your library", async () => {
    const { calls, lookup } = countingLookup();
    const walk = await collectCollaborative({
      ...BASE,
      entries: entries(3),
      index: holding([]),
      dismissed: new Set(["recording:mbid-0"]),
      budget: 5,
      lookup,
    });

    expect(calls).toEqual(["mbid-1", "mbid-2"]);
    expect(walk.counts).toEqual({ received: 3, inLibrary: 0, examined: 2 });
  });

  it("counts a lookup that found nothing as examined, not as free", async () => {
    const walk = await collectCollaborative({
      ...BASE,
      entries: entries(3),
      index: holding([]),
      budget: 5,
      lookup: () => Promise.resolve(null),
    });

    expect(walk.counts).toEqual({ received: 3, inLibrary: 0, examined: 3 });
    expect(walk.items).toEqual([]);
  });
});

describe("cfStrip", () => {
  it("reads in the order the question was asked", () => {
    expect(cfStrip({ received: 100, inLibrary: 61, examined: 15 })).toBe(
      "100 received, 61 in your library, 15 examined",
    );
  });

  it("says nothing happened when nothing did", () => {
    expect(cfStrip({ received: 0, inLibrary: 0, examined: 0 })).toBe(
      "0 received, 0 in your library, 0 examined",
    );
  });
});
