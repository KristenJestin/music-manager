/**
 * Issue #5: the advisory tag, and the disambiguation that was never a subtitle.
 *
 * The decision is one boolean (`decideExplicitTag`); what the owner asked for is about the
 * *file*, so the scenarios are asserted through `resolveTrackDocument` and `projectDocument`
 * rather than on a patch in isolation — a test that stopped at the document would pass while
 * the tag was still written. The test names are the Spec's (`## Spec · metadata.resolve`).
 */

import { describe, expect, it } from "vitest";

import { projectDocument } from "../tagmap/project.ts";
import { deezer, FETCHED_AT, recording, release } from "../testing/discovery.ts";
import { field, type TrackDocument } from "./document.ts";
import { DEFAULT_WRITE_EXPLICIT_TAG, decideExplicitTag } from "./explicit.ts";
import { resolveTrackDocument, type TrackResolutionInput } from "./resolve.ts";

const at = FETCHED_AT;

/** The `Discovery` import, with the sources the scenarios need and nothing else. */
function input(overrides: Partial<TrackResolutionInput> = {}): TrackResolutionInput {
  return {
    release: { data: release, fetchedAt: at, trackPosition: 1 },
    recording: { data: recording, fetchedAt: at },
    deezer: { data: deezer, fetchedAt: at },
    app: {
      importId: "imp_ISSUE5",
      sourceUrl: "https://youtu.be/FGBhQbmPwH8",
      tagSchemaVersion: 5,
      fetchedAt: at,
    },
    ...overrides,
  };
}

/** What the file would carry, for one key. */
function written(document: TrackDocument, key: string) {
  return projectDocument(document, "vorbis").find((tag) => tag.key === key);
}

describe("decideExplicitTag", () => {
  it("is off when nobody chose, which is what issue #5 asks for", () => {
    expect(DEFAULT_WRITE_EXPLICIT_TAG).toBe(false);
    expect(decideExplicitTag(DEFAULT_WRITE_EXPLICIT_TAG)).toEqual({
      write: false,
      reason: "disabled by settings",
    });
  });

  it("writes it, with nothing to say, when the setting asks for it", () => {
    expect(decideExplicitTag(true)).toEqual({ write: true, reason: null });
  });
});

describe("the explicit tag is opt-in (D5-01)", () => {
  it("default installation: `explicit` is n/a (“disabled by settings”) and nothing is written", () => {
    // Deezer's recorded answer for this ISRC is a clean track, so there *was* something to
    // write: the field is `n/a` because a setting switched it off, not for want of data.
    expect(deezer.explicit_lyrics).toBe(false);
    expect(deezer.explicit_content_lyrics).toBe(0);

    const document = resolveTrackDocument(input());
    expect(document.fields["explicit"]).toBeUndefined();
    expect(document.na["explicit"]?.reason).toBe("disabled by settings");
    expect(written(document, "ITUNESADVISORY")).toBeUndefined();
  });

  it("opted in: ITUNESADVISORY is written as before (1 explicit, 2 clean)", () => {
    const clean = resolveTrackDocument(input({ writeExplicitTag: true }));
    expect(clean.fields["explicit"]?.value).toBe(2);
    expect(clean.na["explicit"]).toBeUndefined();
    expect(written(clean, "ITUNESADVISORY")?.value).toBe("2");

    const explicit = resolveTrackDocument(
      input({ deezer: { data: { explicit_lyrics: true }, fetchedAt: at }, writeExplicitTag: true }),
    );
    expect(explicit.fields["explicit"]?.value).toBe(1);
    expect(written(explicit, "ITUNESADVISORY")?.value).toBe("1");
  });

  it("keeps the value in the document when a lock holds it, whatever the setting says", () => {
    // §1: a value you confirmed wins every merge, and this is the one path that still writes
    // the advisory with the setting off — it is your tag, not Deezer's.
    const locked: TrackDocument = resolveTrackDocument(
      input({
        locked: {
          explicit: field(1, "user", at, { locked: true }),
        },
      }),
    );
    expect(locked.fields["explicit"]?.value).toBe(1);
    expect(locked.fields["explicit"]?.locked).toBe(true);
    expect(written(locked, "ITUNESADVISORY")?.value).toBe("1");
  });
});

describe("the disambiguation is not a subtitle (D5-02)", () => {
  it("a recording with a disambiguation: nothing is written to SUBTITLE", () => {
    const document = resolveTrackDocument(
      input({ recording: { data: { ...recording, disambiguation: "explicit" }, fetchedAt: at } }),
    );
    expect(document.fields["subtitle"]).toBeUndefined();
    expect(document.na["subtitle"]?.reason).toBe("MusicBrainz disambiguation is an editor note");
    expect(written(document, "SUBTITLE")).toBeUndefined();
  });
});
