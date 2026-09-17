import { describe, expect, it } from "vitest";
import { MB_ENTITY_NOUN, parseMbRef } from "./mb-ref.ts";

/**
 * Every shape a MusicBrainz reference arrives in.
 *
 * The bug this exists to prevent is not a parsing failure, it is a *misreading*: the wizard's
 * box accepted one entity type and answered "no recording with id X" for a perfectly good
 * release. So the assertions below are as much about `claimed` — what the address said it was —
 * as about the id itself, because that field is what lets the refusal name the right thing.
 */
const RELEASE = "966e9be9-d8d0-46fa-a87b-2d07a963097b";
const RECORDING = "4e514a1a-4d10-4d50-92b4-f518eddbc400";

describe("parseMbRef", () => {
  it("reads a bare id, and claims nothing about it", () => {
    expect(parseMbRef(RELEASE)).toEqual({ mbid: RELEASE, claimed: null });
    // A bare id is the case the old regex handled and the only one it handled.
    expect(parseMbRef(`  ${RECORDING}  `)).toEqual({ mbid: RECORDING, claimed: null });
  });

  it("lower-cases an id somebody copied out of a document", () => {
    expect(parseMbRef(RELEASE.toUpperCase())?.mbid).toBe(RELEASE);
  });

  it("reads the entity word off a musicbrainz.org address", () => {
    expect(parseMbRef(`https://musicbrainz.org/release/${RELEASE}`)).toEqual({
      mbid: RELEASE,
      claimed: "release",
    });
    expect(parseMbRef(`https://musicbrainz.org/recording/${RECORDING}`)?.claimed).toBe("recording");
    expect(parseMbRef(`https://musicbrainz.org/release-group/${RELEASE}`)?.claimed).toBe(
      "release-group",
    );
    expect(parseMbRef(`https://musicbrainz.org/artist/${RELEASE}`)?.claimed).toBe("artist");
    // Named so the refusal can say "that is a work" rather than "that is not a release".
    expect(parseMbRef(`https://musicbrainz.org/work/${RELEASE}`)?.claimed).toBe("work");
    expect(parseMbRef(`https://musicbrainz.org/label/${RELEASE}`)?.claimed).toBe("label");
  });

  it("survives every decoration a real address carries", () => {
    const shapes = [
      `http://musicbrainz.org/release/${RELEASE}`,
      `https://www.musicbrainz.org/release/${RELEASE}`,
      // No scheme: at least as common as with one, and `new URL` refuses it outright.
      `musicbrainz.org/release/${RELEASE}`,
      `https://musicbrainz.org/release/${RELEASE}?tport=80`,
      `https://musicbrainz.org/release/${RELEASE}#tracklist`,
      // A trailing segment — the cover-art tab, the aliases tab.
      `https://musicbrainz.org/release/${RELEASE}/cover-art`,
      // The beta host, which is what a link out of an edit looks like.
      `https://beta.musicbrainz.org/release/${RELEASE}`,
      // And the web service, which is what somebody debugging has in the clipboard.
      `https://musicbrainz.org/ws/2/release/${RELEASE}?inc=recordings&fmt=json`,
      `  https://musicbrainz.org/release/${RELEASE}  `,
    ];
    for (const shape of shapes) {
      expect(parseMbRef(shape), shape).toEqual({ mbid: RELEASE, claimed: "release" });
    }
  });

  it("claims nothing for an id inside somebody else's URL", () => {
    // The entity word is only trustworthy on a musicbrainz.org path; anywhere else it is a
    // coincidence, and a coincidence must not order the lookups.
    expect(parseMbRef(`https://example.com/release/${RELEASE}`)).toEqual({
      mbid: RELEASE,
      claimed: null,
    });
    expect(parseMbRef(`https://coverartarchive.org/release/${RELEASE}/front`)?.claimed).toBe(null);
  });

  it("claims nothing when the path names something that is not an entity", () => {
    expect(parseMbRef(`https://musicbrainz.org/search?query=${RELEASE}`)?.claimed).toBe(null);
    expect(parseMbRef(`https://musicbrainz.org/collection/${RELEASE}`)?.claimed).toBe(null);
  });

  it("returns null for free text, which is what sends it to the search instead", () => {
    expect(parseMbRef("")).toBeNull();
    expect(parseMbRef("   ")).toBeNull();
    expect(parseMbRef("Daft Punk Discovery")).toBeNull();
    // Nearly an MBID: one character short, and a near miss must not be treated as an id.
    expect(parseMbRef("966e9be9-d8d0-46fa-a87b-2d07a963097")).toBeNull();
    // Not hexadecimal.
    expect(parseMbRef("966e9be9-d8d0-46fa-a87b-2d07a96309zz")).toBeNull();
  });

  it("names every entity in a way a sentence can use", () => {
    expect(MB_ENTITY_NOUN["release-group"]).toBe("release group");
    expect(MB_ENTITY_NOUN.recording).toBe("recording");
  });
});
