import { describe, expect, it } from "vitest";
import { describeSearchTerms, splitSearchTerms } from "./search-terms.ts";

/**
 * The split has to be right where it is used and silent where it is not.
 *
 * The bug it answers is `bewitched Laufey` going into the album-title field whole; the trap it
 * must not fall into is splitting `Jay-Z` or `Non-Stop` on their hyphens and searching for an
 * artist called "Jay".
 */
describe("splitSearchTerms", () => {
  it("reads YouTube's own order from a dash", () => {
    expect(splitSearchTerms("Laufey - Bewitched")).toEqual({
      title: "Bewitched",
      artist: "Laufey",
      guessed: true,
    });
    expect(splitSearchTerms("Daft Punk – Discovery")).toEqual({
      title: "Discovery",
      artist: "Daft Punk",
      guessed: true,
    });
    expect(splitSearchTerms("Justice — Woman")?.artist).toBe("Justice");
  });

  it("reads “by” the other way round, because that is what it means", () => {
    expect(splitSearchTerms("Bewitched by Laufey")).toEqual({
      title: "Bewitched",
      artist: "Laufey",
      guessed: true,
    });
  });

  it("leaves a hyphenated name alone", () => {
    // No whitespace around the hyphen, so it is part of a word rather than a separator.
    expect(splitSearchTerms("Jay-Z")).toEqual({ title: "Jay-Z", artist: null, guessed: false });
    expect(splitSearchTerms("Non-Stop")?.artist).toBeNull();
    // And `by` only counts as a whole word.
    expect(splitSearchTerms("Bybye")?.artist).toBeNull();
  });

  it("says when it guessed nothing, which is a title on its own", () => {
    expect(splitSearchTerms("Bewitched")).toEqual({
      title: "Bewitched",
      artist: null,
      guessed: false,
    });
    // The case the old code assumed of every string. It is true here, and only here.
    expect(splitSearchTerms("   Bewitched   ")?.title).toBe("Bewitched");
    expect(splitSearchTerms("")).toEqual({ title: "", artist: null, guessed: false });
  });

  it("never returns an empty half", () => {
    expect(splitSearchTerms("- Bewitched")).toEqual({
      title: "- Bewitched",
      artist: null,
      guessed: false,
    });
    expect(splitSearchTerms("Laufey - ")?.artist).toBeNull();
  });

  it("says what it searched for, which is what an empty result has to read back", () => {
    expect(describeSearchTerms(splitSearchTerms("Laufey - Bewitched"))).toBe(
      "“Bewitched” by “Laufey”",
    );
    expect(describeSearchTerms(splitSearchTerms("Bewitched"))).toBe("“Bewitched”");
  });
});
