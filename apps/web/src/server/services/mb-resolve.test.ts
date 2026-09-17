import { describe, expect, it } from "vitest";
import type { Import } from "#/server/db/schema/index.ts";
import { resolveMbRef, type Lookups } from "./mb-resolve.ts";

/**
 * The entity dispatch, every branch, with the lookups supplied.
 *
 * The bug being answered is not a parsing bug — `packages/domain/normalize/mb-ref.test.ts`
 * covers the string half. It is that the box **refused the id people have**: a release id on a
 * single answered "No MusicBrainz recording with id …", which says the id is wrong when it is
 * the kind that is wrong. So what matters here is what each entity *becomes* for each import
 * kind, and that a refusal names what the thing actually is.
 *
 * The lookups come in through `ResolveInput.lookups`, which is the seam that exists for this:
 * proving five `if`s with five recorded cassettes would be five cassettes to maintain and no
 * more certainty. No network, no database, no files.
 */
const JOB = { id: "imp_x", url: "https://music.youtube.com/watch?v=x" } as unknown as Import;

const RECORDING = "4e514a1a-4d10-4d50-92b4-f518eddbc400";
const RELEASE = "966e9be9-d8d0-46fa-a87b-2d07a963097b";
const GROUP = "11111111-2222-3333-4444-555555555555";
const ARTIST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WORK = "99999999-8888-7777-6666-555555555555";

/** Lookups that know nothing. Each test overrides the one entity it is about. */
const nothing: Lookups = {
  release: async () => await Promise.resolve(null),
  recording: async () => await Promise.resolve(null),
  releaseGroup: async () => await Promise.resolve(null),
  artist: async () => await Promise.resolve(null),
  work: async () => await Promise.resolve(null),
};

const knows = (over: Partial<Lookups>): Lookups => ({ ...nothing, ...over });

/** A three-track release whose middle track is obviously the one a "RISE" video is. */
const releaseDoc = {
  id: RELEASE,
  title: "Bewitched",
  date: "2023-09-08",
  "artist-credit": [{ name: "Laufey" }],
  media: [
    {
      position: 1,
      tracks: [
        { id: "t1", position: 1, title: "Dreamer", length: 190_000, recording: { id: "r1" } },
        { id: "t2", position: 2, title: "RISE", length: 192_000, recording: { id: "r2" } },
        { id: "t3", position: 3, title: "Serendipity", length: 200_000, recording: { id: "r3" } },
      ],
    },
  ],
} as never;

const single = { job: JOB, single: true, videoTitle: "RISE", videoSeconds: 192 };
const album = { job: JOB, single: false, videoTitle: null, videoSeconds: null };

describe("resolveMbRef", () => {
  it("is null for free text, which is what sends it to the search", async () => {
    expect(await resolveMbRef("bewitched laufey", { ...single, lookups: nothing })).toBeNull();
  });

  /* ---- the case that worked, and still does ---- */

  it("uses a recording on a single", async () => {
    const found = await resolveMbRef(RECORDING, {
      ...single,
      lookups: knows({
        recording: async () =>
          await Promise.resolve({
            id: RECORDING,
            title: "RISE",
            length: 192_000,
            "artist-credit": [{ name: "The Glitch Mob" }],
          } as never),
      }),
    });
    expect(found?.entity).toBe("recording");
    expect(found?.title).toBe("RISE");
    expect(found?.artist).toBe("The Glitch Mob");
    expect(found?.lengthSeconds).toBe(192);
    expect(found?.action).toBe("use-recording");
    expect(found?.targetMbid).toBe(RECORDING);
  });

  /* ---- the case that did not: the id he actually had ---- */

  it("turns a release on a single into the track his video is, and says which", async () => {
    const found = await resolveMbRef(RELEASE, {
      ...single,
      lookups: knows({ release: async () => await Promise.resolve(releaseDoc) }),
    });
    expect(found?.entity).toBe("release");
    expect(found?.action).toBe("track-of-release");
    // The conversion offer, in words, *before* anything is pressed.
    expect(found?.explanation).toContain("That is a release, not a recording");
    expect(found?.explanation).toContain("RISE");
    expect(found?.actionLabel).toContain("track 2");
    // And the target is the recording of that track, not the release.
    expect(found?.targetMbid).toBe("r2");
  });

  it("pins the same release on an album import instead", async () => {
    const found = await resolveMbRef(RELEASE, {
      ...album,
      lookups: knows({ release: async () => await Promise.resolve(releaseDoc) }),
    });
    expect(found?.action).toBe("pin-release");
    expect(found?.targetMbid).toBe(RELEASE);
    expect(found?.count).toBe(3);
  });

  it("offers a release group as its editions, through the pipeline's own selection", async () => {
    const found = await resolveMbRef(`https://musicbrainz.org/release-group/${GROUP}`, {
      ...album,
      lookups: knows({
        releaseGroup: async () =>
          await Promise.resolve({
            id: GROUP,
            title: "Bewitched",
            "first-release-date": "2023-09-08",
            releases: [{ id: "re1" }, { id: "re2" }],
          } as never),
      }),
    });
    expect(found?.entity).toBe("release-group");
    expect(found?.action).toBe("editions-of-group");
    expect(found?.count).toBe(2);
    expect(found?.searchText).toBe("Bewitched");
  });

  it("turns an artist into a search rather than refusing", async () => {
    const found = await resolveMbRef(`musicbrainz.org/artist/${ARTIST}`, {
      ...single,
      lookups: knows({
        artist: async () => await Promise.resolve({ id: ARTIST, name: "Laufey" } as never),
      }),
    });
    expect(found?.entity).toBe("artist");
    expect(found?.action).toBe("search-artist");
    expect(found?.actionLabel).toBe("Search Laufey");
    expect(found?.searchText).toBe("Laufey");
  });

  /* ---- and the refusals, which have to name what the thing is ---- */

  it("refuses a work by name", async () => {
    const found = await resolveMbRef(`https://musicbrainz.org/work/${WORK}`, {
      ...single,
      lookups: knows({
        work: async () => await Promise.resolve({ id: WORK, title: "Clair de lune" } as never),
      }),
    });
    expect(found?.entity).toBe("work");
    expect(found?.action).toBe("none");
    expect(found?.actionLabel).toBeNull();
    // "That is a work" — not "that is not a recording", which is the sentence that misled.
    expect(found?.explanation).toContain("That is a work");
    expect(found?.title).toBe("Clair de lune");
  });

  it("says what a URL claimed when nothing knows the id", async () => {
    const found = await resolveMbRef(`https://musicbrainz.org/release/${RELEASE}`, {
      ...album,
      lookups: nothing,
    });
    expect(found?.entity).toBeNull();
    expect(found?.explanation).toBe("MusicBrainz does not know a release with this id.");
  });

  it("says all five were tried when a bare id is unknown", async () => {
    const found = await resolveMbRef(RELEASE, { ...album, lookups: nothing });
    expect(found?.entity).toBeNull();
    expect(found?.explanation).toContain("a recording, a release, a release group");
  });

  /* ---- the ordering, which is what keeps the common case at one request ---- */

  it("asks the entity the address named first", async () => {
    const asked: string[] = [];
    const watched: Lookups = {
      release: async (id) => {
        asked.push("release");
        return await Promise.resolve({ id, title: "Bewitched", media: [] } as never);
      },
      recording: async () => {
        asked.push("recording");
        return await Promise.resolve(null);
      },
      releaseGroup: async () => {
        asked.push("release-group");
        return await Promise.resolve(null);
      },
      artist: async () => {
        asked.push("artist");
        return await Promise.resolve(null);
      },
      work: async () => {
        asked.push("work");
        return await Promise.resolve(null);
      },
    };
    // A *single*, where the natural order starts with `recording` — the URL's word overrides it.
    await resolveMbRef(`https://musicbrainz.org/release/${RELEASE}`, {
      ...single,
      lookups: watched,
    });
    expect(asked).toEqual(["release"]);
  });

  it("falls through in order for a bare id, so being wrong costs a lookup and not a lie", async () => {
    const asked: string[] = [];
    const watched: Lookups = {
      recording: async () => {
        asked.push("recording");
        return await Promise.resolve(null);
      },
      release: async () => {
        asked.push("release");
        return await Promise.resolve(releaseDoc);
      },
      releaseGroup: async () => {
        asked.push("release-group");
        return await Promise.resolve(null);
      },
      artist: async () => {
        asked.push("artist");
        return await Promise.resolve(null);
      },
      work: async () => {
        asked.push("work");
        return await Promise.resolve(null);
      },
    };
    const found = await resolveMbRef(RELEASE, { ...single, lookups: watched });
    expect(asked).toEqual(["recording", "release"]);
    expect(found?.action).toBe("track-of-release");
  });
});
