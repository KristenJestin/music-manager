import { describe, expect, it } from "vitest";
import { artistKey, artistLinks, artistProfile, hostOf } from "./artist-links.ts";

/**
 * The url-rels were always there; only the reader is new.
 *
 * These payloads are shaped exactly like the one `rememberArtist` writes — the MusicBrainz
 * artist entity, verbatim, `relations` included — so a change to the `artistFull` preset that
 * dropped `url-rels` would break the fixture rather than sneak past a mock.
 */
const daftPunk = {
  id: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
  name: "Daft Punk",
  "sort-name": "Daft Punk",
  country: "FR",
  type: "Group",
  disambiguation: "French electronic duo",
  "life-span": { begin: "1993", end: "2021", ended: true },
  relations: [
    {
      type: "wikidata",
      "target-type": "url",
      url: { resource: "https://www.wikidata.org/wiki/Q193338" },
    },
    {
      type: "official homepage",
      "target-type": "url",
      url: { resource: "https://www.daftpunk.com/" },
    },
    {
      type: "discogs",
      "target-type": "url",
      url: { resource: "https://www.discogs.com/artist/1289" },
    },
    {
      type: "social network",
      "target-type": "url",
      url: { resource: "https://www.instagram.com/daftpunk/" },
    },
    {
      type: "free streaming",
      "target-type": "url",
      url: { resource: "https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi" },
    },
    // Ended: the fan site that went away. Kept by MusicBrainz, not offered by us.
    {
      type: "fanpage",
      "target-type": "url",
      ended: true,
      url: { resource: "https://daftworld.example/" },
    },
    // An identifier rather than a destination.
    { type: "image", "target-type": "url", url: { resource: "https://commons.example/x.jpg" } },
    // Not a URL relation at all: a member of the group.
    { type: "member of band", "target-type": "artist", artist: { name: "Thomas Bangalter" } },
  ],
};

describe("artistLinks", () => {
  it("reads the url-rels already stored in artists_cache.payload", () => {
    const links = artistLinks(daftPunk);
    expect(links.map((link) => link.label)).toEqual([
      "Official site",
      "Discogs",
      "Instagram",
      "Spotify",
      "Wikidata",
    ]);
  });

  it("puts the official homepage first, whatever order MusicBrainz answered in", () => {
    expect(artistLinks(daftPunk)[0]?.url).toBe("https://www.daftpunk.com/");
  });

  it("drops an ended relationship, an image, and anything that is not a url-rel", () => {
    const urls = artistLinks(daftPunk).map((link) => link.url);
    expect(urls).not.toContain("https://daftworld.example/");
    expect(urls).not.toContain("https://commons.example/x.jpg");
    expect(urls).toHaveLength(5);
  });

  it("names a social or streaming relation by its host, because the type names dozens", () => {
    const links = artistLinks({
      relations: [
        {
          type: "social network",
          "target-type": "url",
          url: { resource: "https://twitter.com/someone" },
        },
        {
          type: "social network",
          "target-type": "url",
          url: { resource: "https://www.facebook.com/someone" },
        },
      ],
    });
    expect(links.map((link) => link.label)).toEqual(["Facebook", "X"]);
  });

  it("falls back to the host when neither the type nor the host is known", () => {
    const links = artistLinks({
      relations: [
        { type: "lyrics", "target-type": "url", url: { resource: "https://lyrics.example/a" } },
      ],
    });
    expect(links[0]?.label).toBe("lyrics.example");
  });

  it("refuses anything that is not an http(s) address", () => {
    expect(
      artistLinks({
        relations: [
          {
            type: "official homepage",
            "target-type": "url",
            url: { resource: "javascript:alert(1)" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("deduplicates, so two relationships on one URL make one button", () => {
    const links = artistLinks({
      relations: [
        { type: "youtube", "target-type": "url", url: { resource: "https://youtube.com/@x" } },
        {
          type: "free streaming",
          "target-type": "url",
          url: { resource: "https://youtube.com/@x" },
        },
      ],
    });
    expect(links).toHaveLength(1);
  });

  it("answers nothing for a row with no payload, which is what the fixtures seed", () => {
    expect(artistLinks(null)).toEqual([]);
    expect(artistLinks({})).toEqual([]);
    expect(artistLinks("not an object")).toEqual([]);
    expect(artistLinks({ relations: "nonsense" })).toEqual([]);
  });
});

describe("artistProfile", () => {
  it("reads the type, the disambiguation and the life span", () => {
    expect(artistProfile(daftPunk)).toEqual({
      kind: "Group",
      disambiguation: "French electronic duo",
      began: "1993",
      ended: "2021",
    });
  });

  it("is all nulls when there is no payload", () => {
    expect(artistProfile(null)).toEqual({
      kind: null,
      disambiguation: null,
      began: null,
      ended: null,
    });
  });
});

describe("artistKey", () => {
  it("prefers the MBID, which is the part that survives a rename", () => {
    expect(artistKey({ name: "Daft Punk", mbid: "056e4f3e-d505-4dad-8ec1-d04f521cbb56" })).toBe(
      "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
    );
  });

  it("falls back to the name, because an untagged import never has an id", () => {
    expect(artistKey({ name: "Some Channel", mbid: null })).toBe("Some Channel");
    expect(artistKey({ name: "Some Channel", mbid: "  " })).toBe("Some Channel");
    expect(artistKey({ name: "Some Channel" })).toBe("Some Channel");
  });
});

describe("hostOf", () => {
  it("strips www and lowercases", () => {
    expect(hostOf("https://WWW.Example.COM/a")).toBe("example.com");
  });

  it("refuses a non-URL and a non-web scheme", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("fixture://discovery")).toBeNull();
  });
});
