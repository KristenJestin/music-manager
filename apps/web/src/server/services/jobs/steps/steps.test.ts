import { describe, expect, it } from "vitest";
import type { TrackDocument } from "@mm/domain";
import type { ImportTrack } from "#/server/db/schema/index.ts";
import type { ExtractResult } from "#/server/toolbox/client.ts";
import { classify } from "./resolve.ts";
import { autoAcceptDecision } from "./confirm.ts";
import { compareFingerprint } from "./fingerprint.ts";
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

  it("contradicts nothing when the import has no MusicBrainz release at all", () => {
    // The *other* reason a track can have no recording id: "import without MusicBrainz", where
    // there is no release either. Nothing was claimed, so AcoustID recognising the audio as
    // something else is information rather than a disagreement — and a folder of 273 files
    // would otherwise raise 273 questions with no possible answer.
    const verdict = compareFingerprint(
      { candidates: [{ recording_mbid: "rec-9", score: 0.99, title: "Wonderland", artist: null }] },
      { recordingMbid: null, title: "Ouverture", sourceTitle: "A-side.opus", untagged: true },
      options,
    );
    expect(verdict.agrees).toBe(true);
    expect(verdict.reason).toContain("nothing to contradict");
    // The candidate is still reported: the fingerprint is the useful part and it is kept.
    expect(verdict.candidateMbid).toBe("rec-9");
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
