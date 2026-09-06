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
