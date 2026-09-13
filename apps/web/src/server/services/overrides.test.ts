/**
 * What a manual override refuses before it writes anything.
 *
 * The write itself needs a database and is covered by `overrides.integration.test.ts`; what is
 * worth testing without one is the gate in front of it, because that gate is the only thing
 * between a text box and a document whose shape nothing downstream can project. A `TRACKNUMBER`
 * of `"twelve"` would be written into thirteen files by the very next re-tag.
 */
import { describe, expect, it } from "vitest";
import { ALBUM_SCOPE_FIELDS, tagByField } from "@mm/domain";
import { PATH_FIELDS, coerceValue, editableTag, touchesPath } from "./overrides.ts";

const tag = (field: string) => editableTag(field);

describe("editableTag", () => {
  it("accepts a field the tag map knows", () => {
    expect(tag("album").vorbis).toBe("ALBUM");
  });

  it("refuses a name the tag map does not have, rather than inventing a field", () => {
    expect(() => tag("albom")).toThrow(/not a field of the tag map/);
  });

  /*
   * A picture is `EmbeddedPicture[]`, lyrics are `{synced, plain}`, a performer is a name plus
   * a role. Accepting a string for any of them would store a document `projectDocument` cannot
   * read — and it would do so silently, which is the part that matters.
   */
  it.each(["front_cover", "back_cover", "lyrics", "performer"])(
    "refuses %s, which has no single-value text form",
    (field) => {
      expect(() => tag(field)).toThrow(/cannot be typed by hand/);
    },
  );
});

describe("coerceValue", () => {
  it("keeps a plain string as it was typed, trimmed", () => {
    expect(coerceValue(tag("album"), "  Discovery  ")).toBe("Discovery");
  });

  it("refuses an empty value and points at unlocking instead", () => {
    expect(() => coerceValue(tag("album"), "   ")).toThrow(/cannot be set to an empty value/);
  });

  it("splits a multi-valued field one value per line, dropping the blanks", () => {
    expect(coerceValue(tag("genre"), "house\n\n  electronic  \n")).toEqual(["house", "electronic"]);
  });

  it("takes an array for a multi-valued field too, for the API and the CLI", () => {
    expect(coerceValue(tag("genre"), ["house", "electronic"])).toEqual(["house", "electronic"]);
  });

  it("refuses a multi-valued field with nothing in it", () => {
    expect(() => coerceValue(tag("genre"), "\n \n")).toThrow(/at least one value/);
  });

  it("stores a position as a number, because that is what the document carries", () => {
    expect(coerceValue(tag("tracknumber"), "4")).toBe(4);
    expect(coerceValue(tag("totaldiscs"), "2")).toBe(2);
  });

  it.each(["twelve", "0", "-1", "4.5", ""])("refuses %o as a track number", (raw) => {
    expect(() => coerceValue(tag("tracknumber"), raw)).toThrow();
  });

  it("stores compilation as a boolean, whichever spelling of yes was typed", () => {
    expect(coerceValue(tag("compilation"), "1")).toBe(true);
    expect(coerceValue(tag("compilation"), "yes")).toBe(true);
    expect(coerceValue(tag("compilation"), "0")).toBe(false);
    expect(() => coerceValue(tag("compilation"), "maybe")).toThrow(/yes\/no/);
  });

  /* MusicBrainz writes partial dates and so do we; `2001` is not an incomplete `2001-01-01`. */
  it.each(["2001", "2001-03", "2001-03-12"])("accepts the partial ISO date %s", (raw) => {
    expect(coerceValue(tag("date"), raw)).toBe(raw);
  });

  it.each(["12/03/2001", "2001-3-1", "march 2001"])("refuses the date %o", (raw) => {
    expect(() => coerceValue(tag("date"), raw)).toThrow(/must be an ISO date/);
  });

  it("requires a uuid for an MBID, on single and multi fields alike", () => {
    const mbid = "d073287b-1e6f-4c7c-8e5f-1f9b6a6f6b8c";
    expect(coerceValue(tag("musicbrainz_albumid"), mbid)).toBe(mbid);
    expect(coerceValue(tag("musicbrainz_artistid"), [mbid])).toEqual([mbid]);
    expect(() => coerceValue(tag("musicbrainz_albumid"), "Discovery")).toThrow(
      /MusicBrainz identifier/,
    );
  });
});

describe("PATH_FIELDS", () => {
  /*
   * The list is not decorative: a `title` change that did not offer a relocate leaves a file
   * called `04 Old Title.opus` for ever, and `retag` will never rename it — that is what the
   * whole of `relocate.ts` exists to say.
   */
  it("names every field `pathInputForLibraryTrack` reads", () => {
    for (const field of PATH_FIELDS) expect(tagByField(field)).toBeDefined();
    expect(touchesPath(["title"])).toBe(true);
    expect(touchesPath(["tracknumber", "genre"])).toBe(true);
    expect(touchesPath(["genre", "mood", "barcode"])).toBe(false);
  });

  it("does not claim a field that only the tags carry", () => {
    expect(PATH_FIELDS).not.toContain("genre");
    expect(PATH_FIELDS).not.toContain("isrc");
  });
});

describe("the two scopes never overlap", () => {
  /*
   * `overrideTrackFields` refuses every album-scope field and `overrideAlbumFields` refuses
   * every other one, so the two sets have to partition the editable fields — otherwise there
   * is a field nothing can set, and nobody would find out until they tried.
   */
  it("leaves no editable field that neither entry point accepts", () => {
    for (const field of ["title", "artist", "tracknumber", "isrc", "bpm"]) {
      expect(ALBUM_SCOPE_FIELDS).not.toContain(field);
    }
    for (const field of ["album", "albumartist", "genre", "date", "label"]) {
      expect(ALBUM_SCOPE_FIELDS).toContain(field);
    }
  });
});
