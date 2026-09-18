/**
 * The two pure halves of `services/sourceless.ts`, with no database and no stack.
 *
 * `materialiseSourcelessTracks` needs one and is exercised in
 * `sourceless.integration.test.ts`. What is here is the reading and the keying — the two
 * places where a mistake produces *phantom tracks*, which is the worst failure this feature
 * has: a row that claims the record has a track it does not, offered to the owner to go and
 * find a file for.
 */
import { describe, expect, it } from "vitest";
import { cellsFromUncoveredPayload } from "./sourceless.ts";

describe("cellsFromUncoveredPayload", () => {
  it("reads the payload `match` writes, field for field", () => {
    const cells = cellsFromUncoveredPayload({
      releaseMbid: "r1",
      tracks: [
        {
          position: 7,
          mediumPosition: 2,
          title: "Aerodynamic",
          recordingMbid: "rec-1",
          lengthSeconds: 212.5,
        },
      ],
    });
    expect(cells).toEqual([
      {
        position: 7,
        mediumPosition: 2,
        title: "Aerodynamic",
        recordingMbid: "rec-1",
        lengthSeconds: 212.5,
      },
    ]);
  });

  it("assumes disc 1 when the medium is absent, like every other reader of this payload", () => {
    // `uncoveredTracks` omits it on the `trackTotal`-only path, which it takes exactly when
    // every binding is on medium 1. Defaulting to anything else would mis-key those cells.
    const [cell] = cellsFromUncoveredPayload({
      tracks: [{ position: 3, title: null, recordingMbid: null, lengthSeconds: null }],
    });
    expect(cell?.mediumPosition).toBe(1);
    expect(cell?.position).toBe(3);
  });

  it("drops an entry with no usable position rather than inventing one", () => {
    /*
     * The position is the only field that *must* be right: it is half the key a row is created
     * under, and a wrong one is a phantom track on the owner's album. A missing or nonsensical
     * one is therefore dropped, never defaulted — there is no safe default for "which track of
     * the record is this".
     */
    const cells = cellsFromUncoveredPayload({
      tracks: [
        { position: "7", title: "a string position" },
        { position: 0, title: "not one-based" },
        { position: -1, title: "negative" },
        { position: 2.5, title: "not an integer" },
        { position: null, title: "absent" },
        "not an object",
        null,
        { position: 4, title: "the only good one" },
      ],
    });
    expect(cells).toHaveLength(1);
    expect(cells[0]?.position).toBe(4);
    expect(cells[0]?.title).toBe("the only good one");
  });

  it("answers nothing for a payload it cannot read, instead of throwing", () => {
    // This runs inside `confirm`, after the release has been committed. A notice written by an
    // older build must cost the owner a missing row, never a failed confirmation.
    expect(cellsFromUncoveredPayload(null)).toEqual([]);
    expect(cellsFromUncoveredPayload(undefined)).toEqual([]);
    expect(cellsFromUncoveredPayload({})).toEqual([]);
    expect(cellsFromUncoveredPayload({ tracks: "nope" })).toEqual([]);
    expect(cellsFromUncoveredPayload({ tracks: [] })).toEqual([]);
    expect(cellsFromUncoveredPayload("a string")).toEqual([]);
    // The flat `positions: []` an item written before the multi-disc fix carries. It is not
    // `tracks`, so it yields nothing — which is right: those numbers cannot be keyed.
    expect(cellsFromUncoveredPayload({ positions: [7, 8, 9] })).toEqual([]);
  });

  it("keeps a title of null rather than substituting one here", () => {
    // `uncoveredTracks` genuinely has no title on its `trackTotal`-only path. The fallback
    // ("Track 7") belongs at the row, where it is a display name, and not in the parse, where
    // it would become indistinguishable from a title MusicBrainz really gave.
    const [cell] = cellsFromUncoveredPayload({ tracks: [{ position: 7 }] });
    expect(cell?.title).toBeNull();
    expect(cell?.recordingMbid).toBeNull();
    expect(cell?.lengthSeconds).toBeNull();
  });
});
