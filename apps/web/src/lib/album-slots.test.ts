/**
 * Which tracks an album has not got, worked out without a database and without a network.
 *
 * Two properties carry the whole feature, and both of them are ways of being *wrong* that
 * this repository has already met:
 *
 *  1. **the slot is the couple `(mediumPosition, trackPosition)`.** A comparison over a flat
 *     grid of positions invents holes on every multi-disc release, because each medium
 *     restarts its numbering at 1 — disc 2 track 1 and disc 1 track 1 are two slots. Half the
 *     cases below are two-disc releases for that reason;
 *  2. **a false hole is worse than a missed one.** A track reported missing that is sitting on
 *     the disk invites the owner to download a file he already has, over the top of itself. So
 *     "present" is the union of a matching MusicBrainz track id and a matching couple, and
 *     each half is tested with the other half deliberately useless.
 */
import { describe, expect, it } from "vitest";
import type { MbRelease } from "@mm/domain";
import {
  interleaveSlots,
  missingTracksOf,
  slotKey,
  type HeldTrack,
  type MissingTrack,
} from "./album-slots.ts";

/** A release whose media hold the titles given, numbered from 1 within each medium. */
function release(...media: string[][]): MbRelease {
  return {
    id: "6c6974d0-f7b2-4ee1-acfc-37d2723f00d3",
    media: media.map((titles, mediumIndex) => ({
      position: mediumIndex + 1,
      "track-count": titles.length,
      tracks: titles.map((title, trackIndex) => ({
        id: `trk-${String(mediumIndex + 1)}-${String(trackIndex + 1)}`,
        position: trackIndex + 1,
        number: String(trackIndex + 1),
        title,
        recording: { id: `rec-${String(mediumIndex + 1)}-${String(trackIndex + 1)}` },
      })),
    })),
  } as unknown as MbRelease;
}

/** A held row. `trackMbid` defaults to the id the release above would have given it. */
function held(
  discNumber: number | null,
  trackNumber: number | null,
  trackMbid?: string,
): HeldTrack {
  return {
    discNumber,
    trackNumber,
    trackMbid:
      trackMbid ??
      (discNumber === null || trackNumber === null
        ? null
        : `trk-${String(discNumber)}-${String(trackNumber)}`),
  };
}

const at = (track: MissingTrack): string => slotKey(track.mediumPosition, track.trackPosition);

describe("slotKey", () => {
  it("cannot confuse disc 2 track 7 with disc 1 track 27", () => {
    expect(slotKey(2, 7)).not.toBe(slotKey(1, 27));
  });
});

describe("missingTracksOf", () => {
  it("names the holes of a single-disc album, in release order", () => {
    /*
     * The owner's own case, cut down: a twenty-track record whose playlist published sixteen.
     * `mm library show` said 16/20 and nothing said which four.
     */
    const cars = release([
      "Cars",
      "Route 66",
      "Little Deuce Coupe",
      "Mustang Sally",
      "Drive My Car",
      "Sh-Boom",
      "Route 66",
      "Fast Car",
      "Low Rider",
      "Radar Love",
      "My Heart Would Know",
      "Hot Rod Lincoln",
    ]);
    const have = [1, 3, 4, 5, 8, 9, 10, 12].map((position) => held(1, position));

    const missing = missingTracksOf(cars, have);

    expect(missing.map(at)).toEqual(["1:2", "1:6", "1:7", "1:11"]);
    // The titles are the point: two of them are the same song by different people, and only
    // the position and the credit tell them apart.
    expect(missing.map((track) => track.title)).toEqual([
      "Route 66",
      "Sh-Boom",
      "Route 66",
      "My Heart Would Know",
    ]);
  });

  it("answers nothing for an album that has all of it", () => {
    const one = release(["A", "B", "C"]);
    expect(missingTracksOf(one, [held(1, 1), held(1, 2), held(1, 3)])).toEqual([]);
  });

  it("reads a null disc number as disc 1, which is how a single-disc rip is tagged", () => {
    const one = release(["A", "B"]);
    // No `discnumber` tag at all, and no MusicBrainz ids either: positions are all there is.
    const untagged = [
      { discNumber: null, trackNumber: 1, trackMbid: null },
      { discNumber: null, trackNumber: 2, trackMbid: null },
    ];
    expect(missingTracksOf(one, untagged)).toEqual([]);
  });

  /* ---------------- the multi-disc rule, which is the whole point ---------------- */

  it("does not invent holes on disc 2 because disc 1 filled those positions", () => {
    /*
     * The regression this file exists for. Over a flat grid, holding disc 1 entirely looks
     * like holding positions 1..3, and disc 2's tracks 1..3 then read as present — so a
     * half-empty box set reports itself complete.
     */
    const boxSet = release(["A1", "A2", "A3"], ["B1", "B2", "B3"]);
    const discOneOnly = [held(1, 1), held(1, 2), held(1, 3)];

    const missing = missingTracksOf(boxSet, discOneOnly);

    expect(missing.map(at)).toEqual(["2:1", "2:2", "2:3"]);
    expect(missing.map((track) => track.title)).toEqual(["B1", "B2", "B3"]);
  });

  it("does not report disc 1 as missing because disc 2 is the one we hold", () => {
    // The mirror of the above, which a comparison keyed on the position alone also passes and
    // which a comparison keyed on the *medium* alone would fail.
    const boxSet = release(["A1", "A2"], ["B1", "B2"]);
    expect(missingTracksOf(boxSet, [held(2, 1), held(2, 2)]).map(at)).toEqual(["1:1", "1:2"]);
  });

  it("finds a hole in the middle of each disc of a two-disc release", () => {
    const boxSet = release(["A1", "A2", "A3"], ["B1", "B2", "B3"]);
    const have = [held(1, 1), held(1, 3), held(2, 1), held(2, 2)];

    // In release order: disc 1 before disc 2, and by position inside each.
    expect(missingTracksOf(boxSet, have).map(at)).toEqual(["1:2", "2:3"]);
  });

  it("carries the medium's own title, so a named disc can be shown as one", () => {
    const named = {
      media: [
        { position: 1, title: "The Album", tracks: [{ id: "t1", position: 1, title: "A" }] },
        { position: 2, title: "The Demos", tracks: [{ id: "t2", position: 1, title: "B" }] },
      ],
    } as unknown as MbRelease;
    expect(missingTracksOf(named, []).map((track) => track.mediumTitle)).toEqual([
      "The Album",
      "The Demos",
    ]);
  });

  /* ---------------- present is the union of two tests ---------------- */

  it("counts a track as present on its MusicBrainz id when its position is wrong", () => {
    // What a badly numbered rip looks like: the ids are right, the disc and track numbers are
    // not. On positions alone every one of these would be reported missing.
    const one = release(["A", "B"]);
    const misnumbered = [held(9, 41, "trk-1-1"), held(9, 42, "trk-1-2")];
    expect(missingTracksOf(one, misnumbered)).toEqual([]);
  });

  it("counts a track as present on its position when it has no MusicBrainz id", () => {
    // What a v1 migration or an untagged import looks like: no ids at all. On ids alone every
    // one of these would be reported missing, and the album would offer to re-download itself.
    const boxSet = release(["A1", "A2"], ["B1", "B2"]);
    const noIds: HeldTrack[] = [
      { discNumber: 1, trackNumber: 1, trackMbid: null },
      { discNumber: 1, trackNumber: 2, trackMbid: null },
      { discNumber: 2, trackNumber: 1, trackMbid: null },
      { discNumber: 2, trackNumber: 2, trackMbid: null },
    ];
    expect(missingTracksOf(boxSet, noIds)).toEqual([]);
  });

  it("ignores an empty track id rather than matching every track that has none", () => {
    // `trackMbid: ""` is a column default, not an identity. Adding it to the id set would make
    // one blank row account for every release track whose id was also blank.
    const one = release(["A", "B"]);
    const blank: HeldTrack[] = [{ discNumber: null, trackNumber: null, trackMbid: "" }];
    expect(missingTracksOf(one, blank).map(at)).toEqual(["1:1", "1:2"]);
  });

  it("lets a row with no track number still claim its slot by id", () => {
    const one = release(["A", "B"]);
    const noPosition: HeldTrack[] = [{ discNumber: null, trackNumber: null, trackMbid: "trk-1-1" }];
    expect(missingTracksOf(one, noPosition).map(at)).toEqual(["1:2"]);
  });

  it("falls back to the array index when a pruned payload has no positions", () => {
    const pruned = {
      media: [{ tracks: [{ title: "A" }, { title: "B" }] }],
    } as unknown as MbRelease;
    expect(missingTracksOf(pruned, []).map(at)).toEqual(["1:1", "1:2"]);
  });

  it("answers nothing for a release with no media at all", () => {
    expect(missingTracksOf({} as MbRelease, [])).toEqual([]);
  });
});

describe("interleaveSlots", () => {
  it("puts each missing track at its own position among the ones we hold", () => {
    const rows = [held(1, 1), held(1, 3)];
    const missing = missingTracksOf(release(["A", "B", "C"]), rows);

    const woven = interleaveSlots(rows, missing);

    expect(woven.map((slot) => `${slot.kind}:${at(slot as never)}`)).toEqual([
      "present:1:1",
      "missing:1:2",
      "present:1:3",
    ]);
  });

  it("orders a two-disc release by disc first, then by position inside it", () => {
    /*
     * The ordering a flat sort gets wrong: disc 2 track 1 must come after disc 1 track 9, not
     * beside disc 1 track 1.
     */
    const rows = [held(2, 1), held(1, 9)];
    const missing: MissingTrack[] = [
      {
        mediumPosition: 1,
        trackPosition: 2,
        number: "2",
        title: "early on disc 1",
        artist: null,
        trackMbid: null,
        recordingMbid: null,
        lengthSeconds: null,
        mediumTitle: null,
      },
      {
        mediumPosition: 2,
        trackPosition: 2,
        number: "2",
        title: "late on disc 2",
        artist: null,
        trackMbid: null,
        recordingMbid: null,
        lengthSeconds: null,
        mediumTitle: null,
      },
    ];

    const woven = interleaveSlots(rows, missing);

    expect(
      woven.map(
        (slot) => `${slot.kind} ${String(slot.mediumPosition)}-${String(slot.trackPosition)}`,
      ),
    ).toEqual(["missing 1-2", "present 1-9", "present 2-1", "missing 2-2"]);
  });

  it("keeps a held track the release does not mention, at the end of its disc", () => {
    // A bonus track, or a row numbered wrong. It is a file on the disk; hiding it because the
    // release does not list it would be a lie of a different kind.
    const rows = [held(1, 1), { discNumber: 1, trackNumber: null, trackMbid: null }];
    const woven = interleaveSlots(rows, []);
    expect(woven).toHaveLength(2);
    expect(woven[0]?.trackPosition).toBe(1);
    expect(woven[1]?.trackPosition).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is the identity on an album with no holes", () => {
    const rows = [held(1, 1), held(1, 2)];
    expect(interleaveSlots(rows, []).every((slot) => slot.kind === "present")).toBe(true);
  });
});
