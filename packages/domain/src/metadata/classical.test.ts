/**
 * The classical predicate and the work-tag decision (issue #4).
 *
 * The fixtures are the recorded answers of the real library: `Discovery` (Daft Punk, pop with a
 * linked work), `For Emma` (indie folk), a Tsubasa soundtrack (a composer who writes for
 * pictures) and a symphonie that carries a catalogue number.
 */

import { describe, expect, it } from "vitest";

import {
  decideWorkTags,
  isClassicalRelease,
  WRITE_WORK_TAGS,
  type ClassicalReleaseInput,
} from "./classical.ts";

const classical: ClassicalReleaseInput = {
  genres: ["classical", "romantic era"],
  work: { title: "Symphony no. 5 in C minor, op. 67", composer: true },
};

const pop: ClassicalReleaseInput = {
  genres: ["electronic", "house", "dance", "disco", "electro house"],
  work: { title: "One More Time", composer: true },
};

describe("isClassicalRelease", () => {
  it("follows the release group's own genres", () => {
    expect(isClassicalRelease(classical)).toBe(true);
    expect(isClassicalRelease({ genres: ["contemporary classical"] })).toBe(true);
    expect(isClassicalRelease({ genres: ["cinematic classical"] })).toBe(true);
  });

  it("keeps the pop library out", () => {
    expect(isClassicalRelease(pop)).toBe(false);
    expect(isClassicalRelease({ genres: ["indie folk", "folk rock", "baroque pop"] })).toBe(false);
  });

  it("reads `classical` as a word, not as a fragment", () => {
    // MusicBrainz's derived genres carry `neoclassical dark wave`, `classic rock` and
    // `classical crossover` side by side; none of the three is the repertoire this writes for.
    expect(isClassicalRelease({ genres: ["neoclassical dark wave"] })).toBe(false);
    expect(isClassicalRelease({ genres: ["classic rock"] })).toBe(false);
    expect(isClassicalRelease({ genres: ["classical"] })).toBe(true);
    expect(isClassicalRelease({ genres: ["classical crossover"] })).toBe(false);
  });

  it("falls back on the classical shape: composer and catalogue number", () => {
    expect(
      isClassicalRelease({
        genres: ["baroque"],
        work: { title: "Brandenburg Concerto no. 3", composer: true },
      }),
    ).toBe(false);
    expect(
      isClassicalRelease({
        genres: [],
        work: { title: "Concerto in D minor, BWV 1043", composer: true },
      }),
    ).toBe(true);
    expect(
      isClassicalRelease({
        genres: [],
        work: { title: "Piano Sonata no. 16, K. 545", composer: true },
      }),
    ).toBe(true);
  });

  it("wants both halves of the shape", () => {
    // A catalogue number in the title of a work nobody composed classically is a coincidence:
    // `d. 1992` of a rap title, `op. 40` of a mixtape.
    expect(isClassicalRelease({ work: { title: "Op. 40", composer: false } })).toBe(false);
    expect(isClassicalRelease({ work: { title: "Op. 40" } })).toBe(false);
    expect(isClassicalRelease({})).toBe(false);
  });

  it("leaves a film score alone, composer credit and all", () => {
    // The recorded Tsubasa Chronicle soundtrack, which is the owner's library: no genre on the
    // group, a composer (`yuki kajiura`) on every work, and cue titles. Nothing but the absence
    // of a catalogue number keeps them out, so it is the case to pin (review of #14, point 3).
    for (const title of ["Ship of Fools", "BLAZE", "Believe", "Black Sword"]) {
      expect(isClassicalRelease({ work: { title, composer: true } })).toBe(false);
    }
  });

  it("takes movements as the shape's other half", () => {
    expect(
      isClassicalRelease({
        work: { title: "Le Sacre du printemps", composer: true, movements: 2 },
      }),
    ).toBe(true);
  });
});

describe("decideWorkTags", () => {
  it("writes the work of a classical release by default", () => {
    expect(decideWorkTags("classical", true)).toEqual({ write: true, reason: null });
  });

  it("skips it on a pop release, and says why", () => {
    expect(decideWorkTags("classical", false)).toEqual({
      write: false,
      reason: "not a classical release",
    });
  });

  it("obeys `always` and `never` whatever the release is", () => {
    expect(decideWorkTags("always", false)).toEqual({ write: true, reason: null });
    expect(decideWorkTags("never", true)).toEqual({ write: false, reason: "disabled by settings" });
  });

  it("exposes the three values of the setting, and the default first", () => {
    expect(WRITE_WORK_TAGS).toEqual(["classical", "always", "never"]);
  });
});
