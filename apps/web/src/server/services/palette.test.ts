import { describe, expect, it } from "vitest";
import { paletteRef } from "./palette.ts";
import type { Lookups } from "./mb-resolve.ts";

/**
 * What ⌘K offers for a pasted identifier, one branch at a time.
 *
 * The parsing half is covered by `packages/domain/normalize/mb-ref.test.ts` and the lookup
 * order by `mb-resolve.test.ts`. What is new here is that the *affordances are the palette's
 * own and not the wizard's*: the wizard asks "what does this id mean for the import I am
 * looking at", and there is no import here, so a release becomes "start one pinned to this"
 * rather than "pin the one you have open".
 *
 * The lookups come in through the seam `ResolveInput` already had. No network, no database,
 * no files.
 */
const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
const GROUP = "11111111-2222-3333-4444-555555555555";
const RECORDING = "4e514a1a-4d10-4d50-92b4-f518eddbc400";
const ARTIST = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
const WORK = "99999999-8888-7777-6666-555555555555";

const nothing: Lookups = {
  release: async () => await Promise.resolve(null),
  recording: async () => await Promise.resolve(null),
  releaseGroup: async () => await Promise.resolve(null),
  artist: async () => await Promise.resolve(null),
  work: async () => await Promise.resolve(null),
};

const knows = (over: Partial<Lookups>): Lookups => ({ ...nothing, ...over });

describe("paletteRef", () => {
  it("is null for free text, which is what sends the query to the searches", async () => {
    expect(await paletteRef("bewitched laufey", { lookups: nothing })).toBeNull();
  });

  it("offers a pinned import for a release, and counts its tracks", async () => {
    const found = await paletteRef(`https://musicbrainz.org/release/${RELEASE}`, {
      lookups: knows({
        release: async () =>
          await Promise.resolve({
            id: RELEASE,
            title: "Discovery",
            date: "2001-02-26",
            "artist-credit": [{ name: "Daft Punk" }],
            media: [{ position: 1, tracks: [{ id: "t1" }, { id: "t2" }] }],
          } as never),
      }),
    });
    expect(found?.entity).toBe("release");
    expect(found?.action).toBe("pin-release");
    expect(found?.targetMbid).toBe(RELEASE);
    expect(found?.title).toBe("Discovery");
    expect(found?.artist).toBe("Daft Punk");
    expect(found?.year).toBe(2001);
    expect(found?.trackCount).toBe(2);
    expect(found?.explanation).toContain("2 track(s)");
  });

  /**
   * A group has no release to pin *yet*, and that absence is deliberate.
   *
   * `releaseGroupFull` does not carry the group's releases, and widening it would drag every
   * edition of every record through the cache `tag` shares. So the edition is looked up when
   * the row is pressed — one more request through the one-per-second gate, behind a gesture
   * rather than behind a keystroke — and `targetMbid` is null until then.
   */
  it("offers a pinned import for a release group, with the edition still to be chosen", async () => {
    const found = await paletteRef(GROUP, {
      lookups: knows({
        releaseGroup: async () =>
          await Promise.resolve({
            id: GROUP,
            title: "Discovery",
            "first-release-date": "2001",
            "artist-credit": [{ name: "Daft Punk" }],
          } as never),
      }),
    });
    expect(found?.entity).toBe("release-group");
    expect(found?.action).toBe("pin-group");
    expect(found?.targetMbid).toBeNull();
    expect(found?.year).toBe(2001);
  });

  it("sends a recording to the tracks that match it", async () => {
    const found = await paletteRef(RECORDING, {
      lookups: knows({
        recording: async () =>
          await Promise.resolve({
            id: RECORDING,
            title: "One More Time",
            length: 320_000,
            "artist-credit": [{ name: "Daft Punk" }],
          } as never),
      }),
    });
    expect(found?.entity).toBe("recording");
    expect(found?.action).toBe("match-recording");
    expect(found?.searchText).toBe("One More Time");
    expect(found?.explanation).toContain("320 s");
  });

  it("sends an artist to your own artists", async () => {
    const found = await paletteRef(`musicbrainz.org/artist/${ARTIST}`, {
      lookups: knows({
        artist: async () => await Promise.resolve({ id: ARTIST, name: "Daft Punk" } as never),
      }),
    });
    expect(found?.entity).toBe("artist");
    expect(found?.action).toBe("browse-artist");
    expect(found?.searchText).toBe("Daft Punk");
  });

  /**
   * A work is the case the whole lookup-before-refusing rule exists for: the id is perfectly
   * good, it is the *kind* that this application has nothing to do with, and the refusal has
   * to say which.
   */
  it("names a work rather than calling its id wrong", async () => {
    const found = await paletteRef(`https://musicbrainz.org/work/${WORK}`, {
      lookups: knows({
        work: async () => await Promise.resolve({ id: WORK, title: "Veridis Quo" } as never),
      }),
    });
    expect(found?.entity).toBe("work");
    expect(found?.action).toBe("none");
    expect(found?.explanation).toContain("a composition, not a recording of one");
  });

  it("says which kind the address claimed when nothing at all is found", async () => {
    const found = await paletteRef(`https://musicbrainz.org/release/${RELEASE}`, {
      lookups: nothing,
    });
    expect(found?.entity).toBeNull();
    expect(found?.action).toBe("none");
    expect(found?.explanation).toBe("MusicBrainz does not know a release with this id.");
  });

  it("says all five were tried when a bare id is found nowhere", async () => {
    const found = await paletteRef(RELEASE, { lookups: nothing });
    expect(found?.explanation).toContain("a recording, a release, a release group, an artist");
  });
});
