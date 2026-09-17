/**
 * The engine against the four scenarios of `docs/phases/P05-matching.md`.
 *
 * Every number here comes from MusicBrainz as it actually is, recorded once into
 * `fixtures/matching/` by `scripts/record-matching-cassettes.ts`. Two of the four scenarios
 * needed one stated edit each because MusicBrainz does not contain the situation the
 * specification describes — see `fixtures/matching/derived/` and the `synthetic` field inside
 * each of those files, which says exactly what was changed and why.
 */
import { describe, expect, it } from "vitest";
import { readFixture } from "../testing/fixtures.ts";
import { flattenTracks } from "./signals.ts";
import { assign } from "./mapping.ts";
import * as releaseCandidates from "./release-candidates.ts";
import * as recordingCandidates from "./recording-candidates.ts";
import * as releaseGroups from "./release-groups.ts";
import * as lucene from "./lucene.ts";
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS, withDefaults } from "./config.ts";
import type { MbRelease } from "../metadata/resolvers/musicbrainz-types.ts";
import type {
  AlbumHints,
  MatchVideo,
  RecordingCandidateInput,
  ReleaseCandidateInput,
} from "./types.ts";

interface AlbumFixture {
  readonly videos: readonly MatchVideo[];
  readonly hints: AlbumHints;
  readonly candidates: readonly ReleaseCandidateInput[];
}

interface SingleFixture {
  readonly video: MatchVideo;
  readonly candidates: readonly RecordingCandidateInput[];
}

const album = (name: string): AlbumFixture => readFixture<AlbumFixture>(`matching/${name}.json`);
const single = (name: string): SingleFixture => readFixture<SingleFixture>(`matching/${name}.json`);

/** The release behind a ranked candidate, so the mapping can be run against its tracklist. */
function releaseOf(fixture: AlbumFixture, mbid: string): MbRelease {
  const found = fixture.candidates.find((candidate) => candidate.release.id === mbid);
  if (found === undefined) throw new Error(`no candidate ${mbid}`);
  return found.release;
}

/* ------------------------------------------------------------------ */
/* the weights themselves                                              */
/* ------------------------------------------------------------------ */

describe("the default configuration", () => {
  it("gives each family of weights a total of one, so a blend stays in [0,1]", () => {
    const sum = (weights: Readonly<Record<string, number>>): number =>
      Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum(DEFAULT_WEIGHTS.release)).toBeCloseTo(1, 10);
    expect(sum(DEFAULT_WEIGHTS.recording)).toBeCloseTo(1, 10);
    expect(sum(DEFAULT_WEIGHTS.mapping)).toBeCloseTo(1, 10);
  });

  it("makes the tracklist fit the heaviest release signal, as docs/04 requires", () => {
    const release = DEFAULT_WEIGHTS.release;
    const others = Object.entries(release).filter(([key]) => key !== "durations");
    for (const [, weight] of others) expect(release.durations).toBeGreaterThan(weight);
  });

  it("pays for exactness out of the two signals that each answer half of its question", () => {
    /*
     * `exactness` is 0.09, and where it came from is the argument for it. `coverage` went
     * 0.20 → 0.14 and `trackCount` 0.09 → 0.06: the first counts the videos a release would
     * drop and is blind to the tracks it would leave unclaimed, the second compares two
     * cardinalities and never looks at *which* tracks were claimed. Exactness is the question
     * both of them half-answer, asked once and answered off the real assignment, so it is paid
     * for by both and by nothing else. `durations` is untouched — it is still the signal that
     * separates two pressings — and so are title and artist.
     */
    const release = DEFAULT_WEIGHTS.release;
    expect(release.exactness).toBe(0.09);
    expect(release.coverage + release.exactness + release.trackCount).toBeCloseTo(0.29, 10);
    expect(release.durations).toBe(0.26);
    expect(release.exactness).toBeLessThan(release.durations);
    expect(release.exactness).toBeLessThan(release.coverage);
  });

  it("puts coverage second, ahead of title and artist (decision 152)", () => {
    // The fit still decides between two pressings of one record; coverage is what stops a
    // one-track single from looking perfect while importing one video of eleven, and it has
    // to outweigh the two signals that put a wrong candidate in the list to begin with.
    const release = DEFAULT_WEIGHTS.release;
    expect(release.coverage).toBeLessThan(release.durations);
    expect(release.coverage).toBeGreaterThan(release.title);
    expect(release.coverage).toBeGreaterThan(release.artist);
  });

  it("scales the coverage penalty by the square of what a release would drop", () => {
    // A quadratic is the only shape that forgives one extra video in fifteen and refuses ten
    // in eleven; see `coveragePenalty` in config.ts.
    const max = DEFAULT_CONFIG.thresholds.coveragePenalty;
    const at = (shortfall: number): number => max * shortfall * shortfall;
    expect(at(1 / 15)).toBeLessThan(0.005);
    expect(at(10 / 11)).toBeGreaterThan(0.4);
  });

  it("carries the documented thresholds", () => {
    expect(DEFAULT_CONFIG.thresholds.safe).toBe(0.95);
    expect(DEFAULT_CONFIG.thresholds.durationToleranceSeconds).toBe(2);
    expect(DEFAULT_CONFIG.preferences.countries).toEqual(["XW", "FR", "GB", "US"]);
    expect(DEFAULT_CONFIG.preferences.format).toBe("Digital Media");
  });

  it("lets a caller override one weight without restating the others", () => {
    const config = withDefaults({ weights: { release: { year: 0.5 } } });
    expect(config.weights.release.year).toBe(0.5);
    expect(config.weights.release.durations).toBe(DEFAULT_WEIGHTS.release.durations);
    expect(config.thresholds.safe).toBe(0.95);
  });
});

/* ------------------------------------------------------------------ */
/* Lucene                                                              */
/* ------------------------------------------------------------------ */

describe("the Lucene queries", () => {
  it("escapes a backslash before a quote, so the quote escape is not escaped twice", () => {
    expect(lucene.escapeLuceneValue('a\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it("quotes an empty value rather than emitting a bare clause", () => {
    expect(lucene.escapeLuceneValue("")).toBe('""');
    expect(lucene.escapeLuceneValue(null)).toBe('""');
  });

  it("leaves out the clauses it has no value for", () => {
    expect(lucene.releaseGroupQuery("Discovery", null)).toBe('releasegroup:"Discovery"');
    expect(lucene.releaseGroupQuery("Discovery", "Daft Punk")).toBe(
      'releasegroup:"Discovery" AND artist:"Daft Punk"',
    );
  });

  it("forces status:Official unquoted, and uses rgid alone when it has one", () => {
    expect(lucene.releaseQuery({ album: "Discovery", releaseGroupId: "abc-123" })).toBe(
      "rgid:abc-123 AND status:Official",
    );
    expect(lucene.releaseQuery({ album: "Discovery", artist: "Daft Punk", year: 2001 })).toBe(
      'release:"Discovery" AND artist:"Daft Punk" AND status:Official AND date:2001',
    );
  });

  it("builds v1's ±5 s duration window in milliseconds, clamped at zero", () => {
    expect(lucene.recordingQuery({ title: "Formidable", durationSeconds: 214 })).toBe(
      'recording:"Formidable" AND dur:[209000 TO 219000]',
    );
    expect(lucene.recordingQuery({ title: "x", durationSeconds: 2 })).toBe(
      'recording:"x" AND dur:[0 TO 7000]',
    );
  });

  it("prefers reid over rgid, never both", () => {
    const query = lucene.recordingQuery({ title: "x", releaseId: "r1", releaseGroupId: "g1" });
    expect(query).toContain("reid:r1");
    expect(query).not.toContain("rgid:");
  });
});

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

describe("Discovery — fifteen videos for a fourteen-track album", () => {
  const fixture = album("discovery");
  const ranking = releaseCandidates.score(fixture);

  it("preselects the canonical 2001 French CD", () => {
    const first = ranking.preselected;
    expect(first).not.toBeNull();
    // There is no 2001 Digital Media XW Discovery on MusicBrainz (P01's note): every one of
    // the twenty-three releases of the group is a CD or a vinyl, so the 2001 French CD is the
    // canonical pressing and the one the recorded fixtures of P03 already use.
    expect(first?.id).toBe("d073287b-d1bd-4f11-a933-a4386f8cf701");
    expect(first?.country).toBe("FR");
    expect(first?.date?.slice(0, 4)).toBe("2001");
    expect(first?.tracks).toBe(14);
  });

  it("puts every candidate it has a tracklist for above every candidate it does not", () => {
    // The fixture holds ten tracklists — four more than a match spends, recorded so that a
    // shifted pre-score still replays (see scripts/record-matching-cassettes.ts). What matters
    // here is the *order*: an unexamined candidate can never outrank an examined one, however
    // well its title and its country happen to score, because its fit is unknown rather than
    // good. The service's own suite asserts the six-lookup budget.
    const detailed = ranking.candidates.filter((candidate) => candidate.detailed);
    expect(detailed.length).toBeGreaterThan(0);
    const firstShallow = ranking.candidates.findIndex((candidate) => !candidate.detailed);
    expect(firstShallow).toBe(detailed.length);
    expect(ranking.preselected?.detailed).toBe(true);
  });

  it("binds fourteen videos, leaves the radio edit over, and covers every track", () => {
    const release = releaseOf(fixture, "d073287b-d1bd-4f11-a933-a4386f8cf701");
    const result = assign(fixture.videos, flattenTracks(release));
    expect(result.bound).toBe(14);
    expect(result.extraVideos).toHaveLength(1);
    expect(result.extraVideos[0]?.title).toBe("One More Time (Radio Edit)");
    expect(result.uncoveredTracks).toHaveLength(0);
  });

  it("binds each video to the track of the same name", () => {
    const release = releaseOf(fixture, "d073287b-d1bd-4f11-a933-a4386f8cf701");
    const result = assign(fixture.videos, flattenTracks(release));
    for (const line of result.lines) {
      if (line.status === "unmatched") continue;
      expect(line.trackN).toBe(line.videoIndex + 1);
    }
  });

  it("does not call two pressings of the same tracklist an ambiguity", () => {
    // The French and British CDs are five thousandths apart and would import identically.
    expect(ranking.margin).toBeLessThan(DEFAULT_CONFIG.thresholds.ambiguityMargin);
    expect(ranking.ambiguous).toBe(false);
  });

  it("explains itself in plain English", () => {
    const why = ranking.preselected?.why ?? [];
    expect(why.join(" | ")).toMatch(/tracks are covered by a video within/);
    expect(why.join(" | ")).toMatch(/Album title and artist match exactly/);
  });
});

describe("Discovery — the fifteen-track Japanese edition", () => {
  const fixture = album("derived/discovery-japan");
  const ranking = releaseCandidates.score(fixture);
  const JAPAN = "00000000-0000-4000-8000-000000000015";

  it("still preselects the fourteen-track French CD", () => {
    expect(ranking.preselected?.id).toBe("d073287b-d1bd-4f11-a933-a4386f8cf701");
  });

  it("ranks the Japanese edition below every pressing that fits exactly", () => {
    const japan = ranking.candidates.find((candidate) => candidate.id === JAPAN);
    expect(japan).toBeDefined();
    expect(japan?.tracks).toBe(15);
    expect(japan?.preselected).toBe(false);
    expect(japan?.score).toBeLessThan(ranking.preselected?.score ?? 1);
    expect(japan?.why.join(" | ")).toMatch(/1 release track would stay uncovered/);
    expect(japan?.why.join(" | ")).toMatch(/Disambiguation contains “bonus”/);
  });

  it("would leave its bonus track uncovered", () => {
    const result = assign(fixture.videos, flattenTracks(releaseOf(fixture, JAPAN)));
    expect(result.bound).toBe(14);
    expect(result.extraVideos).toHaveLength(1);
    expect(result.uncoveredTracks).toHaveLength(1);
    expect(result.uncoveredTracks[0]?.position).toBe(15);
  });
});

/* ------------------------------------------------------------------ */
/* Bad Ideas — an honest fit                                           */
/* ------------------------------------------------------------------ */

describe("Bad Ideas — eleven videos, and a one-track single of the same name", () => {
  const fixture = album("bad-ideas");
  const ranking = releaseCandidates.score(fixture);
  const ALBUM_2019 = "06cadffd-7930-4b56-a392-ab427188b56c";

  it("preselects the eleven-track 2019 album", () => {
    expect(ranking.preselected?.id).toBe(ALBUM_2019);
    expect(ranking.preselected?.tracks).toBe(11);
    expect(ranking.preselected?.fit).toBe(11);
    expect(ranking.preselected?.leftOver).toBe(0);
    expect(ranking.preselected?.signals.coverage).toBe(1);
  });

  it("crushes the one-track single, which fits 1/1 and covers 1 of 11", () => {
    /*
     * The whole of D3 in one assertion. Before decision 152 this candidate scored 94 % —
     * `durations` was 1.0 (it fits its own tracklist perfectly), the surplus-video penalty was
     * worth four points, and nothing at all measured the ten videos it would drop.
     */
    const single = ranking.candidates.find(
      (candidate) => candidate.detailed && candidate.tracks === 1,
    );
    expect(single).toBeDefined();
    expect(single?.fit).toBe(1);
    expect(single?.fitOf).toBe(1);
    expect(single?.signals.durations).toBe(1);
    expect(single?.signals.coverage).toBeCloseTo(1 / 11, 2);
    expect(single?.leftOver).toBe(10);
    expect(single?.score).toBeLessThanOrEqual(0.3);
    expect(single?.penalties.map((penalty) => penalty.reason).join(" | ")).toMatch(
      /Only 9 % of your videos would be imported/,
    );
  });

  it("groups the candidates and makes each group worth its best release", () => {
    const grouped = releaseGroups.group(ranking.candidates);
    expect(grouped.groups.length).toBeGreaterThan(1);
    expect(grouped.preselected?.releases[0]?.id).toBe(ALBUM_2019);
    expect(grouped.preselected?.score).toBe(ranking.preselected?.score);
    for (const group of grouped.groups) {
      expect(group.score).toBe(group.releases[0]?.score);
    }
  });

  it("prefers an album group to a single group before any tracklist is read", () => {
    // The pre-search lean of decision 151: with eleven videos on the table, "Album" is the
    // better hypothesis, and that is what decides which groups get a release search at all.
    expect(releaseGroups.primaryTypeScore("Album", 11)).toBeGreaterThan(
      releaseGroups.primaryTypeScore("Single", 11),
    );
    // With one video it reverses, and just as gently.
    expect(releaseGroups.primaryTypeScore("Single", 1)).toBeGreaterThan(
      releaseGroups.primaryTypeScore("Album", 1),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pure Heroine — the cover as a tie-breaker                           */
/* ------------------------------------------------------------------ */

describe("Pure Heroine — ten videos, and two pressings that fit identically", () => {
  const fixture = album("pure-heroine");
  const ranking = releaseCandidates.score(fixture);
  /** 2014, worldwide, Universal — one front cover on the archive. */
  const XW_2014 = "002022bb-276c-455a-8cb9-2848b77c37b8";
  /** 2013, US, Lava — "No images available". */
  const US_2013 = "f546b766-4b04-4781-b058-3d5e7dabc37d";

  it("preselects the pressing that has a cover", () => {
    expect(ranking.preselected?.id).toBe(XW_2014);
    expect(ranking.preselected?.coverArt?.front).toBe(true);
  });

  it("ranks the coverless pressing below it, on the same 10/10 fit", () => {
    const withCover = ranking.candidates.find((c) => c.id === XW_2014);
    const without = ranking.candidates.find((c) => c.id === US_2013);
    expect(withCover?.fit).toBe(without?.fit);
    expect(withCover?.fitOf).toBe(without?.fitOf);
    expect(without?.signals.coverArt).toBe(0);
    expect(withCover?.signals.coverArt).toBe(1);
    expect(without?.score).toBeLessThan(withCover?.score ?? 0);
  });

  it("costs 0.03 of the blend and no more — it settles a tie, it does not pick a record", () => {
    /*
     * The guard against over-correcting. Rerun the same fixture with the weight at zero and
     * the two scores must come back within the weight of each other: a signal that could move
     * a candidate further than its own weight would be reordering albums, not pressings.
     */
    const neutral = releaseCandidates.score(fixture, {
      weights: { release: { coverArt: 0 } },
    });
    const before = neutral.candidates.find((c) => c.id === US_2013)?.score ?? 0;
    const after = ranking.candidates.find((c) => c.id === US_2013)?.score ?? 0;
    expect(Math.abs(before - after)).toBeLessThanOrEqual(DEFAULT_WEIGHTS.release.coverArt + 0.001);
  });

  it("keeps “not looked up” apart from “has none”", () => {
    const shallow = ranking.candidates.filter((c) => !c.detailed);
    expect(shallow.length).toBeGreaterThan(0);
    for (const candidate of shallow) expect(candidate.coverArt).toBeNull();
    expect(ranking.candidates.find((c) => c.id === US_2013)?.coverArt).toEqual({
      available: false,
      front: false,
      count: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Currents                                                            */
/* ------------------------------------------------------------------ */

describe("Currents — eleven videos for a thirteen-track album", () => {
  const fixture = album("currents");
  const ranking = releaseCandidates.score(fixture);

  it("preselects a thirteen-track Currents", () => {
    expect(ranking.preselected?.title).toBe("Currents");
    expect(ranking.preselected?.tracks).toBe(13);
    expect(ranking.preselected?.detailed).toBe(true);
  });

  it("leaves Gossip and Disciples uncovered, and no video over", () => {
    const release = releaseOf(fixture, ranking.preselected?.id ?? "");
    const result = assign(fixture.videos, flattenTracks(release));
    expect(result.bound).toBe(11);
    expect(result.extraVideos).toHaveLength(0);
    expect(result.uncoveredTracks.map((track) => track.title)).toEqual(["Gossip", "Disciples"]);
  });

  it("does not ask which release to use when the runner-up covers strictly less", () => {
    expect(ranking.ambiguous).toBe(false);
  });

  it("matches titles across YouTube's straight apostrophes and title case", () => {
    const release = releaseOf(fixture, ranking.preselected?.id ?? "");
    const result = assign(fixture.videos, flattenTracks(release));
    const line = result.lines.find((candidate) => candidate.videoTitle === "'Cause I'm A Man");
    expect(line?.trackTitle).toBe("Cause I’m a Man");
    expect(line?.status).toBe("confident");
  });
});

/* ------------------------------------------------------------------ */
/* Skinny Love                                                         */
/* ------------------------------------------------------------------ */

describe("Skinny Love — one video, many covers", () => {
  const fixture = single("skinny-love");
  const ranking = recordingCandidates.score(fixture);

  it("preselects Birdy's 3:21 recording", () => {
    const first = ranking.preselected;
    expect(first).not.toBeNull();
    expect(first?.artist).toBe("Birdy");
    expect(first?.title).toBe("Skinny Love");
    expect(Math.round(first?.length ?? 0)).toBe(201);
    expect(first?.safe).toBe(true);
  });

  it("borrows the album “Birdy” rather than a compilation", () => {
    const borrow = ranking.preselected?.borrow;
    expect(borrow?.title).toBe("Birdy");
    expect(borrow?.type).toBe("Album");
    expect(borrow?.secondary).toEqual([]);
    expect(borrow?.preferred).toBe(true);
  });

  it("keeps every Bon Iver recording under 0.4", () => {
    const bonIver = ranking.candidates.filter((candidate) => /bon iver/i.test(candidate.artist));
    expect(bonIver.length).toBeGreaterThan(0);
    for (const candidate of bonIver) expect(candidate.score).toBeLessThan(0.4);
  });

  it("is not ambiguous: the runner-up is a compilation, well behind", () => {
    expect(ranking.ambiguous).toBe(false);
    expect(ranking.margin ?? 0).toBeGreaterThan(DEFAULT_CONFIG.thresholds.ambiguityMargin);
  });
});

/* ------------------------------------------------------------------ */
/* Formidable                                                          */
/* ------------------------------------------------------------------ */

describe("Formidable — the album version against the single edit", () => {
  const fixture = single("derived/formidable-single-edit");
  const ranking = recordingCandidates.score(fixture);

  it("preselects the album version", () => {
    expect(ranking.preselected?.borrow?.title).toBe("Racine carrée");
    expect(ranking.preselected?.borrow?.type).toBe("Album");
    expect(ranking.preselected?.length).toBe(214);
  });

  it("calls the pair ambiguous, because one second is not a decision the engine may make", () => {
    expect(ranking.margin).not.toBeNull();
    expect(ranking.margin ?? 1).toBeLessThan(DEFAULT_CONFIG.thresholds.ambiguityMargin);
    expect(ranking.ambiguous).toBe(true);
  });

  it("says why the runner-up lost, in one line", () => {
    const runnerUp = ranking.candidates[1];
    expect(runnerUp?.length).toBe(213);
    expect(runnerUp?.why.join(" | ")).toMatch(/Only available on a single/);
  });
});

/* ------------------------------------------------------------------ */
/* the assignment's own properties                                     */
/* ------------------------------------------------------------------ */

describe("the 1:1 assignment", () => {
  const tracks = flattenTracks({
    media: [
      {
        position: 1,
        "track-count": 3,
        tracks: [
          { id: "t1", position: 1, title: "Alpha", length: 200_000 },
          { id: "t2", position: 2, title: "Beta", length: 300_000 },
          { id: "t3", position: 3, title: "Gamma", length: 400_000 },
        ],
      },
    ],
  });

  const video = (index: number, title: string, duration: number | null): MatchVideo => ({
    id: `v${String(index)}`,
    index,
    title,
    durationSeconds: duration,
  });

  it("never binds two videos to one track", () => {
    const result = assign(
      [video(0, "Alpha", 200), video(1, "Alpha", 200), video(2, "Beta", 300)],
      tracks,
    );
    const bound = result.lines.filter((line) => line.trackN !== null).map((line) => line.trackN);
    expect(new Set(bound).size).toBe(bound.length);
    expect(result.extraVideos).toHaveLength(1);
  });

  it("gives a track to the closest video, not to the first one", () => {
    // Both claim "Beta"; the one whose length agrees must win it.
    const result = assign([video(0, "Beta", 250), video(1, "Beta", 300)], tracks);
    const winner = result.lines.find((line) => line.trackTitle === "Beta");
    expect(winner?.videoId).toBe("v1");
  });

  it("is deterministic under a permutation of the input", () => {
    const videos = [video(0, "Gamma", 400), video(1, "Alpha", 200), video(2, "Beta", 300)];
    const a = assign(videos, tracks);
    const b = assign([...videos].reverse(), tracks);
    const key = (result: typeof a): string =>
      [...result.lines]
        .sort((x, y) => x.videoIndex - y.videoIndex)
        .map((line) => `${line.videoId}:${String(line.trackN)}`)
        .join(",");
    expect(key(a)).toBe(key(b));
  });

  it("leaves a video unbound rather than binding it below the floor", () => {
    const result = assign([video(0, "Something else entirely", 12)], tracks);
    expect(result.bound).toBe(0);
    expect(result.extraVideos).toHaveLength(1);
    expect(result.extraVideos[0]?.why.join(" ")).toMatch(/binding floor/);
    expect(result.uncoveredTracks).toHaveLength(3);
  });

  it("lets a fingerprint override the playlist order", () => {
    const withHint: MatchVideo = {
      ...video(0, "Alpha", 200),
      acoustid: [{ recordingMbid: "r3", score: 0.9 }],
    };
    const hinted = flattenTracks({
      media: [
        {
          position: 1,
          tracks: [
            { id: "t1", position: 1, title: "Alpha", length: 200_000, recording: { id: "r1" } },
            { id: "t3", position: 2, title: "Gamma", length: 200_000, recording: { id: "r3" } },
          ],
        },
      ],
    });
    const result = assign([withHint], hinted);
    expect(result.lines[0]?.trackTitle).toBe("Gamma");
    expect(result.lines[0]?.signals?.acoustid).toBe(0.9);
  });

  it("reports a mean delta only over the lines that have both durations", () => {
    const result = assign([video(0, "Alpha", 201), video(1, "Beta", 303)], tracks);
    expect(result.meanAbsDelta).toBeCloseTo(2, 5);
    expect(result.fit).toBe(1); // only Alpha is inside ±2 s
  });
});

/* ------------------------------------------------------------------ */
/* Appeal to Reason — exactness                                        */
/* ------------------------------------------------------------------ */

describe("Appeal to Reason — fourteen videos and two editions that place all of them", () => {
  const fixture = album("rise-against");
  const ranking = releaseCandidates.score(fixture);
  /** XW, 2014-09-12, Digital Media, Geffen — fourteen tracks, and the playlist is fourteen. */
  const XW_2014 = "46a691d9-67f7-42c1-bc91-7689b0a7fade";
  /** XW, 2008-10, Digital Media — fifteen tracks, the last "Prayer of the Refugee (live)". */
  const XW_2008 = "b5ae03f1-0980-4c67-ae20-e9635b69f404";
  /** CA, 2008-10-07, Digital Media — thirteen tracks, no "Elective Amnesia". */
  const CA_2008 = "dd33e659-88b0-4862-951a-80c700919282";

  it("preselects the edition that leaves nothing over on either side", () => {
    expect(ranking.preselected?.id).toBe(XW_2014);
    expect(ranking.preselected?.tracks).toBe(14);
    expect(ranking.preselected?.uncovered).toBe(0);
    expect(ranking.preselected?.leftOver).toBe(0);
    expect(ranking.preselected?.why.join(" | ")).toMatch(/Exact fit/);
  });

  it("is the only candidate the three fit signals all agree on", () => {
    /*
     * The whole case for a third fit signal, in three numbers off real MusicBrainz data.
     *
     *   `durations`  covered tracks ÷ tracks   — blind to the videos a release drops
     *   `coverage`   bound videos  ÷ videos    — blind to the tracks it leaves unclaimed
     *   `exactness`  bound         ÷ max       — blind to neither
     *
     * The fifteen-track edition places every video (coverage 1.0) and keeps a live bonus track
     * nobody asked for. The thirteen-track edition covers its own tracklist perfectly
     * (durations 1.0) and drops a video. Each of the two older signals calls one of them
     * perfect; only `exactness` refuses both, and only the fourteen-track edition scores 1.
     */
    const exact = ranking.candidates.find((c) => c.id === XW_2014);
    const fifteen = ranking.candidates.find((c) => c.id === XW_2008);
    const thirteen = ranking.candidates.find((c) => c.id === CA_2008);

    expect(fifteen?.signals.coverage).toBe(1);
    expect(fifteen?.signals.exactness).toBeLessThan(1);
    expect(thirteen?.signals.durations).toBe(1);
    expect(thirteen?.signals.exactness).toBeLessThan(1);

    expect(exact?.signals.durations).toBe(1);
    expect(exact?.signals.coverage).toBe(1);
    expect(exact?.signals.exactness).toBe(1);
    expect(exact?.score).toBeGreaterThan(fifteen?.score ?? 1);
    expect(exact?.score).toBeGreaterThan(thirteen?.score ?? 1);
  });

  it("no longer reads a 2014 re-pressing of a 2008 record as a wrong year", () => {
    /*
     * What had to move before `exactness` could be heard at all. The hint is an *album* year —
     * the ℗ line of the description — and the 2014 worldwide digital master scored zero
     * against it, six years of decay, which is more than the whole fit family could make up on
     * a one-track shortfall. A release is now allowed the better of its own date and its
     * release group's first, so the signal separates *records* and not pressings of one.
     */
    for (const id of [XW_2014, XW_2008, CA_2008]) {
      expect(ranking.candidates.find((c) => c.id === id)?.signals.year, id).toBe(1);
    }
  });

  it("does not call it an ambiguity: the runner-up gains nothing", () => {
    expect(ranking.ambiguous).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* exactness is a weight, not a veto                                   */
/* ------------------------------------------------------------------ */

/**
 * The control the sixth owner review asks for in the same breath as the fix.
 *
 * "A genuine fifteen-track edition must still win when the playlist really is missing one."
 * So: fourteen videos, and two candidates built to differ in exactly the way that matters.
 * Everything else — title, artist, year, country, format, cover — is identical, which is the
 * only way the size of one signal can be read at all.
 */
describe("exactness as a weight rather than a veto", () => {
  const VIDEOS: readonly MatchVideo[] = Array.from({ length: 14 }, (_, index) => ({
    id: `v${String(index + 1)}`,
    index,
    title: `Song ${String(index + 1)}`,
    durationSeconds: 200 + index,
  }));
  const HINTS: AlbumHints = { album: "Record", artist: "Someone", year: 2020 };

  /** A release carrying the given titles, at the given lengths. Nothing else varies. */
  const edition = (
    id: string,
    tracks: readonly (readonly [string, number])[],
  ): ReleaseCandidateInput => ({
    detailed: true,
    release: {
      id,
      title: "Record",
      date: "2020-01-01",
      country: "XW",
      status: "Official",
      "cover-art-archive": { artwork: true, front: true, count: 1 },
      "artist-credit": [{ name: "Someone" }],
      "release-group": {
        id: "rg-record",
        title: "Record",
        "primary-type": "Album",
        "first-release-date": "2020-01-01",
      },
      media: [
        {
          position: 1,
          format: "Digital Media",
          "track-count": tracks.length,
          tracks: tracks.map(([title, seconds], index) => ({
            id: `${id}-t${String(index + 1)}`,
            position: index + 1,
            title,
            length: seconds * 1000,
          })),
        },
      ],
    },
  });

  const fourteen = VIDEOS.map(
    (video) => [video.title, video.durationSeconds ?? 0] as readonly [string, number],
  );

  it("prefers the edition with no bonus track when the playlist is complete", () => {
    // The owner's case, in the abstract: both place all fourteen videos, one keeps a track.
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [
        edition("fifteen", [...fourteen, ["Bonus", 300]]),
        edition("fourteen", fourteen),
      ],
    });
    expect(ranking.preselected?.id).toBe("fourteen");
    expect(ranking.candidates.find((c) => c.id === "fifteen")?.signals.exactness).toBeCloseTo(
      14 / 15,
      3,
    );
  });

  it("still lets the fifteen-track edition win when the playlist is genuinely missing one", () => {
    /*
     * The same fifteen-track edition, now against a fourteen-track one whose tracklist is not
     * the playlist's: it has thirteen of these songs and one nobody has a video for. So the
     * fifteen-track candidate leaves one track over and the fourteen-track one leaves a track
     * *and* a video over — and `exactness` says so, 14/15 against 13/14, without any of this
     * needing to be a refusal.
     */
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [
        edition("fifteen", [...fourteen, ["Bonus", 300]]),
        edition("fourteen", [...fourteen.slice(0, 13), ["Something Else", 400]]),
      ],
    });
    expect(ranking.preselected?.id).toBe("fifteen");
    expect(ranking.preselected?.uncovered).toBe(1);
    expect(ranking.candidates.find((c) => c.id === "fourteen")?.leftOver).toBe(1);
  });

  it("weighs no more than its own weight, so it reorders editions and not records", () => {
    const candidates = [
      edition("fifteen", [...fourteen, ["Bonus", 300]]),
      edition("fourteen", fourteen),
    ];
    const on = releaseCandidates.score({ videos: VIDEOS, hints: HINTS, candidates });
    const off = releaseCandidates.score(
      { videos: VIDEOS, hints: HINTS, candidates },
      { weights: { release: { exactness: 0 } } },
    );
    const scoreOf = (ranking: typeof on, id: string): number =>
      ranking.candidates.find((candidate) => candidate.id === id)?.score ?? 0;
    expect(Math.abs(scoreOf(on, "fifteen") - scoreOf(off, "fifteen"))).toBeLessThanOrEqual(
      DEFAULT_WEIGHTS.release.exactness + 0.001,
    );
  });
});

/* ------------------------------------------------------------------ */
/* the ceiling the adaptive exploration branches on                    */
/* ------------------------------------------------------------------ */

describe("the ceiling on an unopened candidate", () => {
  const fixture = album("rise-against");

  it("is the score itself once the tracklist has been read", () => {
    const ranking = releaseCandidates.score(fixture);
    for (const candidate of ranking.candidates) {
      if (!candidate.detailed) continue;
      expect(candidate.ceiling, candidate.id).toBe(candidate.score);
    }
  });

  it("is never below what the candidate turns out to score once opened", () => {
    /*
     * The property the whole branch and bound rests on, checked against real data: a candidate
     * is opened only while its ceiling beats the best complete score, so a ceiling that
     * *under*-states a candidate silently hides it for ever. This is exactly how the first
     * version of it lost *Appeal to Reason* by one lookup — a release search carries no
     * `first-release-date`, so the 2014 pressing of a 2008 record was bounded away at 0.960
     * against a leader at 0.967 and would have scored 1.0 the moment it was read.
     */
    const shallow = releaseCandidates.score({
      ...fixture,
      candidates: fixture.candidates.map((candidate) => ({
        release: stripTracklist(candidate.release),
        detailed: false,
      })),
    });
    const opened = releaseCandidates.score(fixture);
    for (const candidate of shallow.candidates) {
      const real = opened.candidates.find((other) => other.id === candidate.id);
      expect(real).toBeDefined();
      expect(candidate.ceiling, `${candidate.id} (${candidate.title})`).toBeGreaterThanOrEqual(
        real?.score ?? 0,
      );
    }
  });
});

/** A release as a *search result* sees it: track counts, no tracklist, no cover block. */
function stripTracklist(release: MbRelease): MbRelease {
  const { ["cover-art-archive"]: _cover, ...rest } = release;
  const group = release["release-group"];
  return {
    ...rest,
    ...(group === undefined
      ? {}
      : {
          "release-group": Object.fromEntries(
            Object.entries(group).filter(([key]) => key !== "first-release-date"),
          ) as typeof group,
        }),
    media: (release.media ?? []).map((medium) => ({
      position: medium.position,
      ...(medium.format === undefined ? {} : { format: medium.format }),
      "track-count": medium["track-count"] ?? medium.tracks?.length ?? 0,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* the release-type preference                                         */
/* ------------------------------------------------------------------ */

/**
 * "Prefer Album over EP or Single, but never as a veto."
 *
 * The real-world case is the one `bad-ideas` already carries, where a 2020 single of the same
 * name sits next to the 2019 album. What that fixture cannot show is the *clean* comparison —
 * two releases that agree on every other signal — because MusicBrainz has no such pair. So the
 * releases here are built: same title, same artist, same year, same country, same format, same
 * tracklist, same cover. The primary type is the only thing that differs, which is exactly the
 * situation the weight exists for and the only one in which its size can be read.
 */
describe("the release-type preference", () => {
  const VIDEOS: readonly MatchVideo[] = [
    { id: "v1", index: 0, title: "First", durationSeconds: 200 },
    { id: "v2", index: 1, title: "Second", durationSeconds: 210 },
    { id: "v3", index: 2, title: "Third", durationSeconds: 220 },
  ];
  const HINTS: AlbumHints = { album: "Twin", artist: "Someone", year: 2020 };

  /** The same record twice over, differing in nothing but what MusicBrainz filed it as. */
  const twin = (id: string, primaryType: string): ReleaseCandidateInput => ({
    detailed: true,
    release: {
      id,
      title: "Twin",
      date: "2020-01-01",
      country: "XW",
      status: "Official",
      "cover-art-archive": { artwork: true, front: true, count: 1 },
      "artist-credit": [{ name: "Someone" }],
      "release-group": { id: `rg-${id}`, title: "Twin", "primary-type": primaryType },
      media: [
        {
          position: 1,
          format: "Digital Media",
          "track-count": 3,
          tracks: VIDEOS.map((video, index) => ({
            id: `${id}-t${String(index + 1)}`,
            position: index + 1,
            title: video.title,
            length: (video.durationSeconds ?? 0) * 1000,
          })),
        },
      ],
    },
  });

  it("puts the Album in front of an EP that agrees with it on everything else", () => {
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [twin("ep", "EP"), twin("album", "Album")],
    });
    expect(ranking.preselected?.id).toBe("album");
    const ep = ranking.candidates.find((candidate) => candidate.id === "ep");
    expect(ep?.fit).toBe(ranking.preselected?.fit);
    expect(ep?.signals.type).toBeLessThan(ranking.preselected?.signals.type ?? 0);
    expect(ep?.score).toBeLessThan(ranking.preselected?.score ?? 0);
    expect(ep?.why.join(" | ")).toMatch(/Filed as a EP rather than an Album/);
  });

  it("puts it in front of a Single too, and an EP in front of that Single", () => {
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [twin("single", "Single"), twin("ep", "EP"), twin("album", "Album")],
    });
    expect(ranking.candidates.map((candidate) => candidate.id)).toEqual(["album", "ep", "single"]);
  });

  it("still lets a lone Single win — it is a weight, not a veto", () => {
    // The case the owner named. There is no album in the release group to lose to, so the
    // Single is the record, and nothing here is allowed to refuse it.
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [twin("single", "Single")],
    });
    expect(ranking.preselected?.id).toBe("single");
    expect(ranking.preselected?.score).toBeGreaterThan(DEFAULT_CONFIG.thresholds.safe);
  });

  it("cannot outweigh a real tracklist fit", () => {
    // A Single that covers the videos beats an Album that does not. The type preference is
    // worth 0.05; `durations` and `coverage` are worth 0.46 between them, and they win.
    const thin: ReleaseCandidateInput = {
      detailed: true,
      release: {
        ...twin("thin-album", "Album").release,
        media: [
          {
            position: 1,
            format: "Digital Media",
            "track-count": 1,
            tracks: [{ id: "x", position: 1, title: "Something Else", length: 90_000 }],
          },
        ],
      },
    };
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [thin, twin("single", "Single")],
    });
    expect(ranking.preselected?.id).toBe("single");
  });

  it("drops the signal rather than scoring zero when the group declares no type", () => {
    const untyped = twin("untyped", "");
    const ranking = releaseCandidates.score({
      videos: VIDEOS,
      hints: HINTS,
      candidates: [untyped, twin("album", "Album")],
    });
    const typeless = ranking.candidates.find((candidate) => candidate.id === "untyped");
    // Dropped from the denominator, exactly like an un-looked-up cover: "MusicBrainz did not
    // say" is not "MusicBrainz said none". So it trails the Album, but only just — it is not
    // pushed down to where a Single sits.
    const single = releaseCandidates
      .score({ videos: VIDEOS, hints: HINTS, candidates: [twin("single", "Single")] })
      .candidates.at(0);
    expect(typeless?.score).toBeGreaterThan(single?.score ?? 1);
  });

  it("weighs no more than its own weight, so it reorders pressings and not records", () => {
    const candidates = [twin("single", "Single"), twin("album", "Album")];
    const on = releaseCandidates.score({ videos: VIDEOS, hints: HINTS, candidates });
    const off = releaseCandidates.score(
      { videos: VIDEOS, hints: HINTS, candidates },
      { weights: { release: { type: 0 } } },
    );
    const scoreOf = (ranking: typeof on, id: string): number =>
      ranking.candidates.find((candidate) => candidate.id === id)?.score ?? 0;
    expect(Math.abs(scoreOf(on, "single") - scoreOf(off, "single"))).toBeLessThanOrEqual(
      DEFAULT_WEIGHTS.release.type + 0.001,
    );
    // With the weight at zero the two are indistinguishable, which is what "only the type
    // differs" means and what makes the assertions above about the weight and nothing else.
    expect(scoreOf(off, "single")).toBe(scoreOf(off, "album"));
  });
});

/* ------------------------------------------------------------------ */
/* the disambiguation penalties, relative to what the source asked for */
/* ------------------------------------------------------------------ */

/**
 * The fifth defect of the sixth owner review, and it pulls the opposite way to the fourth.
 *
 * "Deluxe", "remaster" and "live" in a release's comment have always been deductions, and they
 * are right to be when the source is the standard album. Applied *unconditionally* they punish
 * the only correct candidate the moment the source announces itself: the owner's "The Heist
 * (Deluxe Edition)", eighteen videos, matched the eighteen-track deluxe pressing 18/18 at a
 * mean Δ of 0.3 s and scored **76 %** because of one line — `Disambiguation contains "deluxe"
 * (−20 %)`. Without it, 96 %.
 *
 * Both directions are asserted here, and the mismatch between two different qualifiers with
 * them, because a rule that only fires one way is half a rule.
 */
describe("a disambiguation penalty is relative to what the source announced", () => {
  const VIDEOS: readonly MatchVideo[] = Array.from({ length: 12 }, (_, index) => ({
    id: `v${String(index + 1)}`,
    index,
    title: `Song ${String(index + 1)}`,
    durationSeconds: 200 + index,
  }));
  const tracks = VIDEOS.map(
    (video) => [video.title, video.durationSeconds ?? 0] as readonly [string, number],
  );

  /** One pressing: the same twelve tracks, differing only in what it calls itself. */
  const pressing = (
    id: string,
    disambiguation: string,
    extra: readonly (readonly [string, number])[] = [],
  ): ReleaseCandidateInput => ({
    detailed: true,
    release: {
      id,
      title: "Record",
      disambiguation,
      date: "2012-01-01",
      country: "XW",
      status: "Official",
      "cover-art-archive": { artwork: true, front: true, count: 1 },
      "artist-credit": [{ name: "Someone" }],
      "release-group": {
        id: "rg-record",
        title: "Record",
        "primary-type": "Album",
        "first-release-date": "2012-01-01",
      },
      media: [
        {
          position: 1,
          format: "Digital Media",
          "track-count": tracks.length + extra.length,
          tracks: [...tracks, ...extra].map(([title, seconds], index) => ({
            id: `${id}-t${String(index + 1)}`,
            position: index + 1,
            title,
            length: seconds * 1000,
          })),
        },
      ],
    },
  });

  const rank = (album: string, candidates: readonly ReleaseCandidateInput[]) =>
    releaseCandidates.score({
      videos: VIDEOS,
      hints: { album, artist: "Someone", year: 2012, edition: undefined },
      candidates,
    });

  it("stops penalising the deluxe pressing when the source announces deluxe", () => {
    const ranking = rank("Record (Deluxe Edition)", [
      pressing("standard", ""),
      pressing("deluxe", "deluxe edition"),
    ]);
    const deluxe = ranking.candidates.find((candidate) => candidate.id === "deluxe");
    expect(deluxe?.penalties.map((penalty) => penalty.reason).join(" | ")).not.toMatch(/deluxe/i);
    expect(ranking.preselected?.id).toBe("deluxe");
    // And the standard pressing is the one that now owes something, for being the wrong edition.
    const standard = ranking.candidates.find((candidate) => candidate.id === "standard");
    expect(standard?.penalties.map((penalty) => penalty.reason).join(" | ")).toMatch(
      /asks for the deluxe edition and this pressing does not say it is one/,
    );
  });

  it("still prefers the standard pressing when the source announces nothing", () => {
    const ranking = rank("Record", [
      pressing("deluxe", "deluxe edition"),
      pressing("standard", ""),
    ]);
    expect(ranking.preselected?.id).toBe("standard");
    const deluxe = ranking.candidates.find((candidate) => candidate.id === "deluxe");
    expect(deluxe?.penalties.map((penalty) => penalty.reason).join(" | ")).toMatch(
      /Disambiguation contains “deluxe”/,
    );
  });

  it("is not satisfied by a different qualifier", () => {
    // "Remaster" asked for, "live" offered: two different things, and the deduction stands.
    const ranking = rank("Record (Remastered)", [
      pressing("live", "live"),
      pressing("remaster", "remastered"),
    ]);
    expect(ranking.preselected?.id).toBe("remaster");
    const live = ranking.candidates.find((candidate) => candidate.id === "live");
    expect(live?.penalties.map((penalty) => penalty.reason).join(" | ")).toMatch(
      /Disambiguation contains “live”/,
    );
  });

  it("reads the edition off the release's title as well as its comment", () => {
    // MusicBrainz writes it in either column; "Record (Deluxe Edition)" with no comment at all
    // is the same statement as a comment saying "deluxe edition".
    const titled: ReleaseCandidateInput = {
      ...pressing("titled", ""),
      release: { ...pressing("titled", "").release, title: "Record (Deluxe Edition)" },
    };
    const ranking = rank("Record (Deluxe Edition)", [pressing("standard", ""), titled]);
    const chosen = ranking.candidates.find((candidate) => candidate.id === "titled");
    expect(chosen?.penalties).toHaveLength(0);
    expect(ranking.preselected?.id).toBe("titled");
  });

  it("does not let the rule outweigh a real tracklist fit", () => {
    /*
     * The guard against over-correcting. A "deluxe" pressing that is *not* the record — two of
     * the twelve videos land nowhere — still loses to a standard pressing that fits, even
     * though the source asked for deluxe. Editions are a tie-break between pressings of one
     * record; the fit decides which record it is, and it always outranks this.
     */
    const wrongDeluxe: ReleaseCandidateInput = {
      detailed: true,
      release: {
        ...pressing("wrong-deluxe", "deluxe edition").release,
        media: [
          {
            position: 1,
            format: "Digital Media",
            "track-count": 4,
            tracks: tracks.slice(0, 4).map(([title, seconds], index) => ({
              id: `wrong-${String(index)}`,
              position: index + 1,
              title,
              length: seconds * 1000,
            })),
          },
        ],
      },
    };
    const ranking = rank("Record (Deluxe Edition)", [wrongDeluxe, pressing("standard", "")]);
    expect(ranking.preselected?.id).toBe("standard");
  });
});
