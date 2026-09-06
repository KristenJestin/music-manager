/**
 * The folksonomy filter, and the two resolvers that depend on it.
 *
 * `docs/03-metadonnees.md` §4 makes Last.fm and ListenBrainz *fallbacks* for `GENRE`, below
 * MusicBrainz. Two things therefore have to be true, and both are tested here: their tags are
 * filtered hard enough that a library never grows a genre called "seen live", and their
 * position in `SOURCE_PRECEDENCE` means they can only fill a field MusicBrainz left empty.
 */

import { describe, expect, it } from "vitest";
import { merge } from "../document.ts";
import { fromLastfmTags } from "./lastfm.ts";
import { fromListenBrainzTags } from "./listenbrainz.ts";
import { fromMusicBrainzArtist } from "./musicbrainz.ts";
import { SOURCE_PRECEDENCE } from "./index.ts";
import { genresFromTags, isGenreTag, isMoodTag, moodsFromTags, titleCase } from "./vocabulary.ts";

const AT = "2026-09-06T00:00:00.000Z";

describe("what counts as a genre", () => {
  it("accepts a style", () => {
    expect(isGenreTag("french house")).toBe(true);
    expect(isGenreTag("Progressive Rock")).toBe(true);
  });

  it("rejects a decade or a year: that is a date", () => {
    expect(isGenreTag("00s")).toBe(false);
    expect(isGenreTag("1990s")).toBe(false);
    expect(isGenreTag("2001")).toBe(false);
  });

  it("rejects what is about the listener, not the music", () => {
    for (const noise of [
      "seen live",
      "favourite",
      "favourite songs of all time",
      "albums i own",
      "spotify",
      "female vocalists",
    ]) {
      expect(isGenreTag(noise)).toBe(false);
    }
  });

  it("keeps moods out of GENRE and in MOOD", () => {
    expect(isGenreTag("melancholic")).toBe(false);
    expect(isMoodTag("melancholic")).toBe(true);
    expect(isMoodTag("french house")).toBe(false);
  });

  it("orders by votes, breaks ties alphabetically, and caps the list", () => {
    const tags = [
      { name: "house", count: 10 },
      { name: "electronic", count: 40 },
      { name: "seen live", count: 99 },
      { name: "disco", count: 10 },
      { name: "techno", count: 5 },
    ];
    expect(genresFromTags(tags, { limit: 3, minCount: 1 })).toEqual([
      "Electronic",
      "Disco",
      "House",
    ]);
  });

  it("drops tags below the vote floor", () => {
    const tags = [
      { name: "house", count: 5 },
      { name: "vaporwave", count: 1 },
    ];
    expect(genresFromTags(tags, { limit: 3, minCount: 3 })).toEqual(["House"]);
  });

  it("deduplicates case-insensitively", () => {
    const tags = [
      { name: "House", count: 9 },
      { name: "house", count: 8 },
    ];
    expect(genresFromTags(tags, { limit: 3, minCount: 0 })).toEqual(["House"]);
  });

  it("returns moods lowercased, most voted first", () => {
    const tags = [
      { name: "Chill", count: 3 },
      { name: "euphoric", count: 9 },
      { name: "house", count: 20 },
    ];
    expect(moodsFromTags(tags)).toEqual(["euphoric", "chill"]);
  });

  it("title-cases without mangling what is already capitalised", () => {
    expect(titleCase("french house")).toBe("French House");
    expect(titleCase("R&B")).toBe("R&B");
  });
});

describe("the genre chain of §4", () => {
  const mbGenre = {
    fields: {
      genre: {
        value: ["French House"],
        source: "musicbrainz" as const,
        confidence: 1,
        fetchedAt: AT,
        locked: false,
      },
    },
  };

  it("lets Last.fm fill a GENRE MusicBrainz does not have", () => {
    const document = merge(
      [fromLastfmTags([{ name: "electronic", count: 100 }], { fetchedAt: AT, limit: 3 })],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(document.fields["genre"]?.value).toEqual(["Electronic"]);
    expect(document.fields["genre"]?.source).toBe("lastfm");
  });

  it("never lets Last.fm take a GENRE MusicBrainz does have", () => {
    const document = merge(
      [mbGenre, fromLastfmTags([{ name: "electronic", count: 100 }], { fetchedAt: AT })],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(document.fields["genre"]?.value).toEqual(["French House"]);
    expect(document.fields["genre"]?.source).toBe("musicbrainz");
  });

  it("puts ListenBrainz last, behind Last.fm", () => {
    const document = merge(
      [
        fromListenBrainzTags([{ tag: "nu-disco", count: 5 }], { fetchedAt: AT }),
        fromLastfmTags([{ name: "electronic", count: 100 }], { fetchedAt: AT }),
      ],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(document.fields["genre"]?.source).toBe("lastfm");
  });

  it("never marks GENRE n/a: a folksonomy having nothing is not a fact about the track", () => {
    const patch = fromLastfmTags([], { fetchedAt: AT });
    expect(patch.na).toEqual({});
    expect(patch.fields).toEqual({});
  });

  it("reads ListenBrainz's own tag shape", () => {
    const patch = fromListenBrainzTags(
      [
        { tag: "nu-disco", count: 4 },
        { tag: "seen live", count: 99 },
        { tag: "dreamy", count: 2 },
      ],
      { fetchedAt: AT, limit: 3, minCount: 1 },
    );
    expect(patch.fields?.["genre"]?.value).toEqual(["Nu-Disco"]);
    expect(patch.fields?.["mood"]?.value).toEqual(["dreamy"]);
  });
});

describe("the artist resolver", () => {
  it("produces WEBSITE from the artist's url-rels, which no release lookup carries", () => {
    const patch = fromMusicBrainzArtist(
      {
        id: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
        name: "Daft Punk",
        relations: [
          {
            "target-type": "url",
            type: "official homepage",
            url: { resource: "https://daftpunk.com/" },
          },
        ],
      },
      { fetchedAt: AT },
    );
    expect(patch.fields?.["website"]?.value).toBe("https://daftpunk.com/");
  });

  it("says n/a when the artist has no homepage, rather than leaving it missing for ever", () => {
    const patch = fromMusicBrainzArtist(
      { id: "x", name: "Someone", relations: [] },
      {
        fetchedAt: AT,
      },
    );
    expect(patch.fields?.["website"]).toBeUndefined();
    expect(patch.na?.["website"]?.reason).toContain("no official homepage");
  });

  it("produces nothing else, so it cannot overwrite a credited artist string", () => {
    const patch = fromMusicBrainzArtist(
      { id: "x", name: "Daft Punk", "sort-name": "Daft Punk" },
      { fetchedAt: AT },
    );
    expect(Object.keys(patch.fields ?? {})).toEqual([]);
    expect(Object.keys(patch.na ?? {})).toEqual(["website"]);
  });
});
