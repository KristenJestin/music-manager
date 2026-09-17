import { describe, expect, it } from "vitest";
import type { MatchTrack, MbRelease, TrackDocument } from "@mm/domain";
import { flattenTracks } from "@mm/domain";
import type { ImportTrack } from "#/server/db/schema/index.ts";
import type { ExtractResult } from "#/server/toolbox/client.ts";
import { loadCassette } from "#/server/services/matching.cassettes.ts";
import { classify } from "./resolve.ts";
import { autoAcceptDecision, exactnessRefusal } from "./confirm.ts";
import { compareFingerprint } from "./fingerprint.ts";
import { describePositions, uncoveredTracks } from "./match.ts";
import { pathInputFor } from "./place.ts";
import { projectionHash, r128Gain } from "./tag.ts";

/**
 * The pure decisions inside the steps: what a URL turned out to be, whether a fingerprint
 * agrees with the mapping, where a file belongs, and the one piece of arithmetic that has to
 * match the Python side exactly.
 */

/* ------------------------------------------------------------------ */

function entry(overrides: Partial<ExtractResult["entries"][number]> = {}) {
  return {
    id: "abc",
    title: "A song",
    index: 0,
    duration: 200,
    uploader: "Someone - Topic",
    track: null,
    artist: null,
    album: null,
    release_year: null,
    description: null,
    thumbnails: [],
    webpage_url: null,
    ...overrides,
  } as ExtractResult["entries"][number];
}

function extract(entries: ExtractResult["entries"], kind: "video" | "playlist"): ExtractResult {
  return { kind, title: null, uploader: null, id: null, entries };
}

describe("classify", () => {
  it("calls a single video a single", () => {
    expect(classify("https://youtu.be/x", extract([entry()], "video"))).toBe("single");
  });

  it("calls a playlist whose entries agree on one album an album", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `v${String(index)}`, index, album: "Discovery" }),
    );
    expect(classify("https://youtube.com/playlist?list=x", extract(entries, "playlist"))).toBe(
      "album",
    );
  });

  it("calls a mixed playlist a playlist", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `v${String(index)}`, index, album: index < 4 ? "Discovery" : null }),
    );
    expect(classify("https://youtube.com/playlist?list=x", extract(entries, "playlist"))).toBe(
      "playlist",
    );
  });

  it("recognises a channel from the URL, whatever the entries look like", () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ id: `v${String(index)}`, index, album: "Discovery" }),
    );
    expect(classify("https://www.youtube.com/@daftpunk", extract(entries, "playlist"))).toBe(
      "channel",
    );
  });
});

/* ------------------------------------------------------------------ */

const options = { minScore: 0.5, titleThreshold: 0.87 };

describe("compareFingerprint", () => {
  it("agrees when the recording MBID matches", () => {
    const verdict = compareFingerprint(
      { candidates: [{ recording_mbid: "rec-1", score: 0.9, title: "Anything", artist: null }] },
      { recordingMbid: "rec-1", title: "One More Time" },
      options,
    );
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toContain("MBID");
  });

  it("falls back to the title when the two sides do not share an id namespace", () => {
    const verdict = compareFingerprint(
      {
        candidates: [
          {
            recording_mbid: "acoustid-only",
            score: 0.98,
            title: "One More Time",
            artist: "Daft Punk",
          },
        ],
      },
      { recordingMbid: "musicbrainz-only", title: "One More Time" },
      options,
    );
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toContain("title");
  });

  it("disagrees when the audio is a different song", () => {
    const verdict = compareFingerprint(
      {
        candidates: [{ recording_mbid: "rec-2", score: 0.93, title: "Aerodynamic", artist: null }],
      },
      { recordingMbid: "rec-1", title: "One More Time" },
      options,
    );
    expect(verdict.agrees).toBe(false);
    expect(verdict.candidateTitle).toBe("Aerodynamic");
    expect(verdict.score).toBe(0.93);
  });

  it("names the video rather than saying the mapping says “”", () => {
    // `trackTitle` is `""`, not null, whenever a mapping was confirmed without one — which is
    // every mapping an agent could build before `recordingMbid` was exposed. The reason then
    // read `the mapping says “”`, which is true and says nothing.
    const verdict = compareFingerprint(
      { candidates: [{ recording_mbid: "rec-2", score: 0.99, title: "Wonderland", artist: null }] },
      { recordingMbid: null, title: "", sourceTitle: "CHVRCHES - Clearest Blue" },
      options,
    );
    expect(verdict.agrees).toBe(false);
    expect(verdict.reason).not.toContain("“”");
    expect(verdict.reason).toContain("CHVRCHES - Clearest Blue");
  });

  it("says nothing when AcoustID answered nothing — silence is not a contradiction", () => {
    expect(
      compareFingerprint({ candidates: null }, { recordingMbid: "rec-1", title: "x" }, options)
        .agrees,
    ).toBe(true);
    expect(
      compareFingerprint({ candidates: [] }, { recordingMbid: "rec-1", title: "x" }, options)
        .agrees,
    ).toBe(true);
  });

  it("ignores candidates below the score floor, which are noise", () => {
    const verdict = compareFingerprint(
      {
        candidates: [
          { recording_mbid: "rec-9", score: 0.1, title: "Something else", artist: null },
        ],
      },
      { recordingMbid: "rec-1", title: "One More Time" },
      options,
    );
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toContain("score floor");
  });

  it("looks past the top candidate for the one that matches", () => {
    const verdict = compareFingerprint(
      {
        candidates: [
          { recording_mbid: "rec-9", score: 0.9, title: "Wrong", artist: null },
          { recording_mbid: "rec-1", score: 0.6, title: "Right", artist: null },
        ],
      },
      { recordingMbid: "rec-1", title: "Right" },
      options,
    );
    expect(verdict.agrees).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

function documentOf(fields: Record<string, string | number>): TrackDocument {
  return {
    schemaVersion: 1,
    na: {},
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [
        name,
        { value, source: "musicbrainz" as const, confidence: 1, fetchedAt: "", locked: false },
      ]),
    ),
  };
}

const track = {
  trackPosition: 3,
  trackTitle: "From the mapping",
  sourceTitle: "From YouTube",
} as ImportTrack;

describe("pathInputFor", () => {
  it("takes every part of the path from the document, so a path cannot contradict a tag", () => {
    const input = pathInputFor(
      documentOf({
        albumartist: "Daft Punk",
        album: "Discovery",
        date: "2001-02-26",
        tracknumber: "1",
        title: "One More Time",
      }),
      track,
      "opus",
    );
    expect(input).toMatchObject({
      albumArtist: "Daft Punk",
      album: "Discovery",
      year: "2001",
      trackNumber: 1,
      title: "One More Time",
      extension: "opus",
    });
  });

  it("falls back through artist, then to a name that is at least well-formed", () => {
    const input = pathInputFor(documentOf({ artist: "Someone" }), track, "opus");
    expect(input.albumArtist).toBe("Someone");
    expect(input.album).toBe("Unknown Album");
    // No tracknumber in the document: the mapping's position stands in.
    expect(input.trackNumber).toBe(3);
    expect(input.title).toBe("From the mapping");
  });

  it("carries the disc numbers only when the document has them", () => {
    const single = pathInputFor(documentOf({ album: "X", title: "Y" }), track, "opus");
    expect(single.discNumber).toBeUndefined();
    const multi = pathInputFor(
      documentOf({ album: "X", title: "Y", discnumber: "2", totaldiscs: "3" }),
      track,
      "opus",
    );
    expect(multi).toMatchObject({ discNumber: 2, totalDiscs: 3 });
  });

  it("uses the original date when there is no release date", () => {
    const input = pathInputFor(
      documentOf({ album: "X", title: "Y", originaldate: "1999-01-01" }),
      track,
      "opus",
    );
    expect(input.year).toBe("1999");
  });
});

/* ------------------------------------------------------------------ */

describe("r128Gain", () => {
  /**
   * The mirror of `r128_gain()` in services/toolbox/src/toolbox/replaygain.py. R128 is defined
   * against −23 LUFS while ReplayGain is measured against the reference we asked for, so the
   * two differ by exactly that offset. If these two ever disagree, a file carries two loudness
   * figures that contradict each other.
   */
  it("offsets by the difference between −23 LUFS and the reference", () => {
    expect(r128Gain(-8, -18)).toBe(Math.round(-13 * 256));
    expect(r128Gain(-8, -23)).toBe(Math.round(-8 * 256));
    expect(r128Gain(0, -23)).toBe(0);
  });

  it("is Q7.8 fixed point, so a whole number of steps", () => {
    expect(Number.isInteger(r128Gain(-8.47, -18))).toBe(true);
  });
});

describe("projectionHash", () => {
  const tags = [
    { key: "TITLE", value: "One More Time", field: "title" },
    { key: "ALBUM", value: "Discovery", field: "album" },
  ];

  it("is stable for the same projection", () => {
    expect(projectionHash(tags)).toBe(projectionHash([...tags]));
  });

  it("changes when a value changes — that is what makes a re-tag skippable", () => {
    const changed = [tags[0]!, { key: "ALBUM", value: "Homework", field: "album" }];
    expect(projectionHash(changed)).not.toBe(projectionHash(tags));
  });

  it("is short enough to store and long enough not to collide", () => {
    expect(projectionHash(tags)).toMatch(/^[0-9a-f]{32}$/);
  });
});

/* ------------------------------------------------------------------ */

describe("autoAcceptDecision", () => {
  /**
   * The one exception to "l'algo ne choisit jamais à ta place" (`docs/04` § Ce que l'algo ne
   * fait jamais), so it is worth being explicit about every way it stays shut.
   */
  const safe = { safe: true, ambiguous: false, score: 0.97 };

  it("accepts a safe, unambiguous match above the threshold", () => {
    const decision = autoAcceptDecision({ allowed: true, verdict: safe, threshold: 0.95 });
    expect(decision.accept).toBe(true);
  });

  it("waits when two candidates are too close to call", () => {
    const decision = autoAcceptDecision({
      allowed: true,
      verdict: { ...safe, ambiguous: true },
      threshold: 0.95,
    });
    expect(decision.accept).toBe(false);
    expect(decision.why).toContain("too close");
  });

  it("waits when the best candidate is not safe", () => {
    const decision = autoAcceptDecision({
      allowed: true,
      verdict: { safe: false, ambiguous: false, score: 0.93 },
      threshold: 0.95,
    });
    expect(decision.accept).toBe(false);
    expect(decision.why).toContain("safe threshold");
  });

  it("waits when the score is under the source's own, higher bar", () => {
    const decision = autoAcceptDecision({ allowed: true, verdict: safe, threshold: 0.99 });
    expect(decision.accept).toBe(false);
    expect(decision.why).toContain("0.99");
  });

  it("waits when the match step left nothing to judge", () => {
    const decision = autoAcceptDecision({ allowed: true, verdict: null, threshold: 0.95 });
    expect(decision.accept).toBe(false);
    expect(decision.why).toContain("no confidence");
  });

  it("waits when the source never opted in, whatever the score says", () => {
    const decision = autoAcceptDecision({ allowed: false, verdict: safe, threshold: 0 });
    expect(decision.accept).toBe(false);
    expect(decision.why).toContain("off for this source");
  });
});

/* ------------------------------------------------------------------ */

/**
 * Positions are `(medium, track)` — the second owner defect.
 *
 * *Crèvecœur* is twelve tracks over two discs, numbered 1–6 then 1–6. All twelve videos
 * downloaded, tagged and filed, every step read 12/12, and the import raised "6 track(s) of the
 * release have no video — Positions 7, 8, 9, 10, 11, 12": the covered set was `{1,2,3,4,5,6}`
 * and the grid was `1..trackTotal`, flat. Six of the owner's fifteen flagged albums were that
 * sentence and nothing else.
 *
 * The fixture is the two-disc *Discovery* vinyl the `discovery` cassette already carries
 * (`ac7518c6…`, 7 + 7), so this is a real release rather than a hand-built one.
 */
describe("uncoveredTracks", () => {
  const VINYL = "ac7518c6-b630-4761-99c7-6a94cc35a594";

  function twoDiscRelease(): MbRelease {
    const cassette = loadCassette("discovery");
    const entry = cassette?.entries.find((row) => row.key.includes(VINYL));
    if (entry === undefined) throw new Error(`the discovery cassette has no ${VINYL}`);
    return entry.payload as MbRelease;
  }

  /** The mapping the wizard sends for a fully covered two-disc record. */
  function everyTrack(tracks: readonly MatchTrack[]) {
    return tracks.map((track, index) => ({
      position: index,
      trackPosition: track.position,
      mediumPosition: track.mediumPosition,
      recordingMbid: track.recordingMbid,
      trackTitle: track.title,
    }));
  }

  it("reports nothing when every track of every disc is covered", () => {
    const tracks = flattenTracks(twoDiscRelease());
    expect(tracks).toHaveLength(14);
    // Two discs of seven: the positions repeat, which is the whole difficulty.
    expect(tracks.filter((track) => track.position === 1)).toHaveLength(2);

    const supplied = { tracks: everyTrack(tracks), trackTotal: tracks.length };
    expect(uncoveredTracks(supplied, tracks)).toEqual([]);
  });

  it("names the disc of the track it really missed, not a flat position", () => {
    const tracks = flattenTracks(twoDiscRelease());
    const missing = tracks.find((track) => track.mediumPosition === 2 && track.position === 3);
    const supplied = {
      tracks: everyTrack(tracks).filter(
        (line) => !(line.mediumPosition === 2 && line.trackPosition === 3),
      ),
      trackTotal: tracks.length,
    };

    const uncovered = uncoveredTracks(supplied, tracks);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.mediumPosition).toBe(2);
    expect(uncovered[0]?.position).toBe(3);
    expect(uncovered[0]?.title).toBe(missing?.title);
    // Disc 1 track 3 is covered and must not be dragged in by sharing a number with it.
    expect(uncovered.some((cell) => cell.mediumPosition === 1)).toBe(false);
  });

  it("still reports a real gap on a single-disc record", () => {
    const supplied = {
      tracks: [
        { position: 0, trackPosition: 1, mediumPosition: 1, recordingMbid: null, trackTitle: "a" },
        { position: 1, trackPosition: 3, mediumPosition: 1, recordingMbid: null, trackTitle: "c" },
      ],
      trackTotal: 3,
    };
    expect(uncoveredTracks(supplied, null).map((cell) => cell.position)).toEqual([2]);
  });

  /**
   * No tracklist and a mapping that spans two discs: the layout is unknowable, so nothing is
   * reported. A report nobody can key is worse than no report — it is the six phantom lines.
   */
  it("says nothing rather than guessing when it has no tracklist and more than one disc", () => {
    const supplied = {
      tracks: [
        { position: 0, trackPosition: 1, mediumPosition: 1, recordingMbid: null, trackTitle: "a" },
        { position: 1, trackPosition: 1, mediumPosition: 2, recordingMbid: null, trackTitle: "b" },
      ],
      trackTotal: 12,
    };
    expect(uncoveredTracks(supplied, null)).toEqual([]);
  });
});

describe("describePositions", () => {
  const cell = (mediumPosition: number, position: number) => ({
    position,
    mediumPosition,
    title: null,
    recordingMbid: null,
    lengthSeconds: null,
  });

  it("names bare positions on a single-disc record", () => {
    expect(describePositions([cell(1, 7), cell(1, 8)])).toBe("Positions 7, 8.");
  });

  it("names the disc as soon as there are two", () => {
    expect(describePositions([cell(1, 6), cell(2, 1), cell(2, 2)])).toBe("disc 1: 6; disc 2: 1, 2");
  });
});

/* ------------------------------------------------------------------ */

/**
 * The engine may confirm alone only on an exact match.
 *
 * The generalisation of the artist refusal `match` already applies: every video bound, no
 * release track left uncovered, no video left over, and the source's artist carried. Five of
 * the owner's fifteen flagged albums have no release of the right size in MusicBrainz at all —
 * *Smoke + Mirrors* (21 videos), *Random Access Memories (Drumless)* (13), *The Family Jewels*
 * (13), *Night Candy* (4), *Ceremonials* (15) — and one was chosen for each of them anyway.
 */
describe("exactnessRefusal", () => {
  const exact = {
    kind: "album" as const,
    answered: false,
    videos: 14,
    bound: 14,
    tracks: 14,
    artistCarried: true,
  };

  it("allows the one shape where nothing is left over on either side", () => {
    expect(exactnessRefusal(exact)).toBeNull();
  });

  it("refuses a video the release has no track for", () => {
    // `fixture://discovery`: fifteen videos, fourteen tracks, one radio edit left over.
    expect(exactnessRefusal({ ...exact, videos: 15, bound: 14 })).toMatch(
      /1 of your 15 video\(s\)/,
    );
  });

  it("refuses a track of the release no video covers", () => {
    expect(exactnessRefusal({ ...exact, tracks: 15 })).toMatch(/1 track\(s\).*no video/);
  });

  it("refuses when no candidate is credited to the artist the source names", () => {
    expect(exactnessRefusal({ ...exact, artistCarried: false })).toMatch(/credited to the artist/);
  });

  it("refuses a match step that recorded nothing to judge", () => {
    expect(exactnessRefusal(null)).toMatch(/nothing to judge/);
    expect(exactnessRefusal({ ...exact, bound: null })).toMatch(/no tracklist fit/);
  });

  /** A pinned release and a supplied mapping are a person; there is nobody left to ask. */
  it("exempts an answer somebody gave", () => {
    expect(exactnessRefusal({ ...exact, answered: true, videos: 21, bound: 13 })).toBeNull();
  });

  /**
   * A single covers no tracklist — the release it is filed under is context, which is why the
   * wizard sends `trackTotal: 0` for one. The artist condition still applies.
   */
  it("exempts a single from the tracklist conditions but not from the artist one", () => {
    expect(
      exactnessRefusal({ ...exact, kind: "single", videos: 1, bound: 1, tracks: 11 }),
    ).toBeNull();
    expect(
      exactnessRefusal({ ...exact, kind: "single", videos: 1, bound: 1, artistCarried: false }),
    ).toMatch(/credited to the artist/);
  });
});

describe("autoAcceptDecision, composed with the exactness rule", () => {
  const safe = { safe: true, ambiguous: false, score: 0.97 };
  const exact = {
    kind: "album" as const,
    answered: false,
    videos: 14,
    bound: 14,
    tracks: 14,
    artistCarried: true,
  };

  it("still accepts when the three score rules and the four exactness rules all hold", () => {
    expect(
      autoAcceptDecision({ allowed: true, verdict: safe, threshold: 0.95, shape: exact }).accept,
    ).toBe(true);
  });

  /*
   * The three gates compose in one order, and the order is the sentence a person reads: the
   * source's permission, then its score bar, then exactness. A source that never opted in is
   * told that, and not something about its tracklist.
   */
  it("refuses a high-scoring, unambiguous match that is not exact", () => {
    const decision = autoAcceptDecision({
      allowed: true,
      verdict: safe,
      threshold: 0.95,
      shape: { ...exact, videos: 15, bound: 14 },
    });
    expect(decision.accept).toBe(false);
    expect(decision.why).toMatch(/video\(s\)/);
  });

  it("names the permission before the tracklist when the source never opted in", () => {
    const decision = autoAcceptDecision({
      allowed: false,
      verdict: safe,
      threshold: 0.95,
      shape: { ...exact, videos: 15, bound: 14 },
    });
    expect(decision.why).toContain("off for this source");
  });
});
